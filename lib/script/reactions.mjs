// 反应位：未点名弹幕的「到点接话」。只负责「谁、什么时候、能不能说」，不负责写台词。
// 设计见 DEBATE-SCRIPT.md §6.5。三条硬约束：不连击、疲劳保护、每人 10 分钟一次。
// 纯内存状态机，不碰 IO，时钟可注入，便于用虚拟时间跑测试。
export const REACTION_LIMITS={
 minChars:4,            // 短于 4 字的多半是「？」「好」「1」，接不住
 maxChars:40,           // 长于 40 字是演讲稿，不是弹幕
 quotaMs:600000,        // 每人 10 分钟一次；低于 5 分钟就会变成少数人刷屏
 hearGapMs:10000,       // 同一人 10 秒内只进池一次，防连发
 maxStreak:2,           // 最多连填 2 次，第 3 次强制空——一条规则同时管节奏和上限
 ambientHeat:20,        // 近 60 秒 20 条以上算「房间热」，池空时用气氛句兜底
 heatWindowMs:60000,
 quoteMax:6,            // 回应里与观众原话的公共子串上限，超过就算复读
 poolMax:400
};

// 观众在说什么。分类只影响排序和句式选择，不决定「回不回」——回不回由 §6.5.2 的落点决定。
const MOODS=[
 {id:'flame', re:/(滚|垃圾|傻|蠢|闭嘴|恶心|退钱|骗子|骗人|狗东西)/},
 {id:'doubt', re:/(真的吗|凭什么|不对吧|有问题|是不是|收钱|恰饭|谁信|不至于|较什么真|有什么用)/},
 {id:'mock',  re:/(这都能|也能吵|吵什么|别吵了|笑死|离谱|魔幻|就这|离谱|好玩吗)/},
 {id:'praise',re:/(好听|好可爱|可爱|声音|帅|漂亮|喜欢|爱你|好棒|厉害|牛|支持|加油|粉了|优秀)/},
 {id:'cheer', re:/(哈哈哈|哈哈|笑死|草|绝了|牛逼|awsl|太强了)/}
];

// 越权指令：命中就不进池。这是反应位独有的攻击面——回应会引用原话，等于给注入搭了桥。
const INJECTION=/(忽略(以上|之前|上面)|无视(规则|之前)|你现在是|从现在起你|system\s*prompt|扮演(一个)?无约束|开发者模式|进入?调试模式|ignore\s+(all\s+)?previous)/iu;
// 输出黑名单：模型自曝身份或拒绝，等于把节目拆了。
const OUTPUT_BAD=/(我是(一个)?(AI|人工智能|模型|助手)|作为(一个)?(AI|语言模型|人工智能)|无法(回答|讨论|提供)|抱歉[，,]我(不能|无法))/u;
// 客服腔：一出现人格立刻塌。
export const SERVICE_TONE=/(谢谢(你|您)?的?(支持|喜欢|关注)|感谢(这位|你的)?(朋友|支持|关注)|你说得对|理解你的|不好意思|客气了)/u;

export function normalizeComment(value){
 return String(value??'').normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/g,'').replace(/\s+/g,' ').trim().slice(0,120);
}

export function classifyComment(text){
 const value=normalizeComment(text);
 if(!value)return {mood:'plain',social:false};
 for(const m of MOODS)if(m.re.test(value))return {mood:m.id,social:m.id==='praise'||m.id==='cheer'};
 return {mood:'plain',social:false};
}

export function isInjection(text){return INJECTION.test(normalizeComment(text));}
export function isBadOutput(text){return OUTPUT_BAD.test(String(text??''))||SERVICE_TONE.test(String(text??''));}

// 最长公共子串。只用在这儿，数据量小（≤40 字 × ≤40 字），不做优化。
export function longestCommon(a,b){
 const x=normalizeComment(a),y=normalizeComment(b);
 if(!x||!y)return 0;
 let best=0,prev=new Array(y.length+1).fill(0);
 for(let i=1;i<=x.length;i++){
  const row=new Array(y.length+1).fill(0);
  for(let j=1;j<=y.length;j++){
   if(x[i-1]===y[j-1]){row[j]=prev[j-1]+1;if(row[j]>best)best=row[j];}
  }
  prev=row;
 }
 return best;
}

export function quotesTooMuch(reply,source,max=REACTION_LIMITS.quoteMax){return longestCommon(reply,source)>max;}

// 情绪强度：标点密度 + 叠字。0~20，用于同分时让「情绪高的先上」。
function emotionScore(text){
 const value=normalizeComment(text);
 const marks=(value.match(/[!！?？]/g)||[]).length;
 const repeat=/哈{2,}|啊{2,}|草{2,}|笑死|绝了|离谱/u.test(value)?6:0;
 const caps=/\p{Lu}{3,}/u.test(value)?3:0;
 return Math.min(20,marks*4+repeat+caps);
}

// 与「当前这一句」的关键词重合数，0~30。贴句不贴幕，是 v4 收紧的地方：位置密了，贴幕会穿帮。
function relevanceScore(text,keywords){
 if(!Array.isArray(keywords)||!keywords.length)return 0;
 const value=normalizeComment(text);
 let hits=0;
 for(const word of keywords){const w=String(word||'').trim();if(w.length>=2&&value.includes(w))hits++;}
 return Math.min(30,hits*10);
}

function lengthPenalty(text){
 const n=normalizeComment(text).length;
 return n<=30?0:Math.min(10,(n-30)/2);
}

export class ReactionRouter{
 constructor({now=Date.now,limits={}}={}){
  this.now=now;
  this.limits={...REACTION_LIMITS,...limits};
  this.pool=new Map();          // userId -> item（后来的覆盖先来的）
  this.pending=new Map();       // userId -> item，已选中但还没播（乐观锁，防同一人被连选）
  this.repliedAt=new Map();     // userId -> ts，配额
  this.consumed=new Set();      // 已消费过的 turnId，位置只发一次
  this.streak=0;                // 连续填充计数，到 maxStreak 就强制空一次
  this.recent=[];               // 近 60 秒所有弹幕时间戳（含被过滤的，热度看的是房间不是池）
  this.stats={heard:0,queued:0,replied:0,ambient:0,skipped:0,blocked:0,bounced:0,expired:0,flushed:0,dropped:0};
 }

 // 弹幕进池。返回 {ok,reason}；不抛错，调用方按 reason 记账即可。
 hear(event,ctx={}){
  const text=normalizeComment(event?.text);
  // 先记热度再看能不能入池：热度是房间属性，匿名和广告也算房间在说话。
  this.recent.push(this.now());
  this.trimHeat();
  this.stats.heard++;
  const key=String(event?.userId||event?.name||'');
  if(!key)return this.reject('anonymous');
  if(text.length<this.limits.minChars)return this.reject('too-short');
  if(text.length>this.limits.maxChars)return this.reject('too-long');
  if(isInjection(text))return this.reject('injection');
  if(this.blockedBy?.(text))return this.reject('safety');
  const old=this.pool.get(key);
  if(old&&this.now()-old.at<this.limits.hearGapMs)return this.reject('rate');
  const {mood,social}=classifyComment(text);
  const item={
   id:key+'@'+this.now(),userId:key,name:String(event?.name||'观众').slice(0,24),
   text,at:this.now(),mood,social,halfMention:Boolean(event?.halfMention),
   weak:!event?.userId,   // 没有稳定 userId 时用昵称兜底，改名就等于换了个人，日志里要能看出来
   act:Number.isFinite(ctx.act)?ctx.act:null,   // 进池时在第几幕，跨幕要作废
   keywords:Array.isArray(ctx.keywords)?[...ctx.keywords]:[]
  };
  this.pool.set(key,item);
  if(this.pool.size>this.limits.poolMax)this.pool.delete(this.pool.keys().next().value);
  this.stats.queued++;
  return {ok:true,item};
 }

 reject(reason){this.stats.blocked++;return {ok:false,reason};}

 trimHeat(){
  const floor=this.now()-this.limits.heatWindowMs;
  let cut=0;
  while(cut<this.recent.length&&this.recent[cut]<floor)cut++;
  if(cut)this.recent.splice(0,cut);
 }

 // 房间热不热。看到的是一条弹幕都没进池也算——热度是房间属性，不是池属性。
 heat(){this.trimHeat();return this.recent.length;}

 // 反应位到点。只决定落点，不写台词。
 // 密度用一条规则管：「最多连填 2 次」。连填 2 次后强制空一次，空的那次把计数归零。
 // 这条规则同时实现两件事——节奏不会退化成「辩论—弹幕—辩论—弹幕」的节拍器，
 // 且结构上把 59 个位置封在最多 39 条（演练值，见 test/reaction 的密度用例），不需要再设上限。
 plan(ctx={}){
  const turnId=String(ctx.turnId||'');
  if(!turnId)return {kind:'skip',reason:'no-turn'};
  if(this.consumed.has(turnId))return {kind:'skip',reason:'consumed'};
  if(this.streak>=this.limits.maxStreak){this.streak=0;return this.settle('skip','streak');}
  const pick=this.pick(ctx);
  if(pick){
   this.consumed.add(turnId);this.streak++;
   this.pool.delete(pick.userId);this.pending.set(pick.userId,pick);
   return {kind:'reply',item:pick};
  }
  if(this.heat()>=this.limits.ambientHeat){
   this.consumed.add(turnId);this.streak++;this.stats.ambient++;
   return {kind:'ambient',reason:'hot-but-empty'};
  }
  this.streak=0;
  return this.settle('skip',this.pool.size?'quota':'empty');
 }

 settle(kind,reason){this.stats.skipped++;return {kind,reason};}

 // 排序取 top1。同分时先来先上，避免「每次都是同一个人」。
 pick(ctx={}){
  const now=this.now(),candidates=[];
  for(const item of this.pool.values()){
   const last=this.repliedAt.get(item.userId);
   if(last!==undefined&&now-last<this.limits.quotaMs)continue;
   const score=relevanceScore(item.text,ctx.keywords??item.keywords)+emotionScore(item.text)
    +(item.halfMention?20:0)+(last===undefined?15:0)
    -lengthPenalty(item.text)-(item.social?10:0);
   candidates.push({item,score});
  }
  if(!candidates.length)return null;
  candidates.sort((a,b)=>b.score-a.score||a.item.at-b.item.at);
  return candidates[0].item;
 }

 // 真的播出去了才扣配额。生成失败要 release，否则这个人白等 10 分钟。
 commit(item){
  if(!item?.userId)return null;
  this.repliedAt.set(item.userId,this.now());
  this.pool.delete(item.userId);
  this.pending.delete(item.userId);
  this.stats.replied++;
  return item;
 }

 // plan 之后、commit 之前的失败：退还配额，人回池等下一个位。
 // 位置本身不退还（consumed 已记），因为「这一格已经过去了」——位置比人便宜。
 release(item,reason='failed'){
  if(!item?.userId)return;
  this.pending.delete(item.userId);
  this.repliedAt.delete(item.userId);
  this.stats.bounced++;
  if(!this.pool.has(item.userId)&&item.text)this.pool.set(item.userId,item);
 }

 // 换幕：上一幕还没被选中的弹幕作废。语境已经过去了，硬接就是答非所问。
 // 不消耗配额（没播出去就不算），也不回池——作废就是作废。
 expire(act){
  let n=0;
  for(const [key,item] of this.pool){
   if(item.act!==null&&item.act!==act){this.pool.delete(key);n++;}
  }
  this.stats.expired+=n;
  return n;
 }

 // 暂停恢复：池里的弹幕说的是三分钟前的画面，全部倒掉，否则一恢复就连播一串。
 // streak 一起归零，不然恢复后第一格会被「刚连填过」吞掉，听感像是不理人。
 flush(){
  const n=this.pool.size;
  this.pool.clear();this.pending.clear();this.streak=0;
  this.stats.flushed+=n;
  return n;
 }

 // 这一条到此为止：气泡兜底之后不能再回池。
 // 否则下一格又选中它，整场反复念同一句话——这是「降级」最容易变成事故的地方。
 discard(item,reason='dropped'){
  if(!item?.userId)return null;
  this.pending.delete(item.userId);
  this.pool.delete(item.userId);
  this.stats.dropped++;
  return item;
 }

 // 换场/切模式时清空。审计数字保留，便于对比两场。
 reset(){this.pool.clear();this.pending.clear();this.repliedAt.clear();this.consumed.clear();this.streak=0;this.recent=[];}

 snapshot(){
  return {pool:this.pool.size,pending:this.pending.size,streak:this.streak,heat:this.heat(),limits:{...this.limits},stats:{...this.stats}};
 }
}

export default ReactionRouter;
