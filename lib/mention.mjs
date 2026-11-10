// 点名路由：把「准确提到某个形象」的弹幕从反应池里挑出来，走点名槽。
// 设计见 DEBATE-SCRIPT.md §6.1~§6.3。三条边界，每条都对应一类线上事故：
//   1. 别名必须 ≥2 字。单字「鱼」会命中「摸鱼」，一晚上能把半个房间点成辩手。
//   2. 否定语境与引号里的名字不算。「别叫肉包」「他说『肉包』好凶」都不是在叫他。
//   3. 名字在句首 / @ / 后接「你」才算点名；在句中只回反应池（排序 +20）。
//      分界是「他要的是回答，还是只想被听见」——评不该被当成问答处理，但也不该被无视。
//
// 纯内存状态机，不碰 IO，时钟可注入。与 reactions.mjs 的分工：
//   reactions 管「未点名弹幕什么时候接」；这里管「点名的那条什么时候答、答不答得上」。
import {normalizeComment,isInjection} from './script/reactions.mjs';

export const MENTION_LIMITS=Object.freeze({
 // 别名最短 2 字：单字别名在中文里几乎必然误命中（鱼/包/鲸）。
 minAliasChars:2,
 // 最多 40 位观众同时排队，每人只有一条待回消息。
 queueMax:40,
 // 排队超过 8 分钟就不回了。观众问的是当时那个画面，八分钟后答非所问比不答更难看。
 ttlMs:8*60*1000,
 // 一个槽最多消费 2 条（§6.3）。再多就成了点名专场，剧本被挤没了。
 slotMax:2,
 // 回应后仅短暂冷却，同一场可以继续点名提问。
 slotQuotaMs:15000,
 voteQuotaMs:15000
});

// 名字后面接这些词，基本就是在跟人说话，不是在评论。
const ASK_AFTER=/^(你|您|在吗|在不在|你好|我问你|请问|怎么看|怎么说|觉得|说说|回答|来回答|出来)/u;
// 「别叫肉包」「不是肉包」——否定语境里的名字是在说他，不是叫他。
const NEGATE_BEFORE=/(别|不要|不是|假装|冒充|让|像)(叫)?$/u;
// 引号里的名字是「引用」，不是「称呼」。整段替换成占位符，位置还留着，
// 这样「他说『肉包』好凶，肉包你倒是说句话」里第二个「肉包」仍然命中。
const QUOTED=/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|《[^》]*》/gu;
// 归一化时去掉的字符：标点、空白、格式符。@ 必须留着——它是「在跟谁说话」的最强信号。
const PUNCT=/[\s，。、；：！？,.;:!?'"“”‘’「」『』《》（）()【】\[\]{}…—～~`|*#\-_+=<>/\\]/gu;

export function normalizeMentionText(value){
 return normalizeComment(value)
  .replace(QUOTED,text=>'〇'.repeat(text.length))
  .replace(PUNCT,'');
}

// 别名表：长别名优先。「小鲸鱼」和「鲸鱼」同时存在时，命中长的那个才是对的。
export function buildAliasTable(personas=[]){
 const rows=[];
 for(const persona of Array.isArray(personas)?personas:[]){
  if(!persona?.id)continue;
  const names=[persona.name,...(Array.isArray(persona.aliases)?persona.aliases:[])]
   .map(name=>normalizeMentionText(name))
   .filter(name=>name.length>=MENTION_LIMITS.minAliasChars);
  for(const alias of new Set(names)){
   rows.push({personaId:String(persona.id),name:String(persona.name||''),alias});
  }
 }
 return rows.sort((a,b)=>b.alias.length-a.alias.length);
}

// 找命中：返回 {personaId,name,alias,index,score} 或 null。
export function findMention(text,table=[]){
 const clean=normalizeMentionText(text);
 if(!clean)return null;
 let best=null;
 for(const row of table){
  const index=clean.indexOf(row.alias);
  if(index<0)continue;
  // 否定语境只挡「这一处」，不挡整个别名：同一句里后面还有一处正常提及。
  if(NEGATE_BEFORE.test(clean.slice(Math.max(0,index-3),index)))continue;
  if(!best||row.alias.length>best.alias.length||(row.alias.length===best.alias.length&&index<best.index)){
   best={...row,index};
  }
 }
 if(!best)return null;
 return {...best,score:scoreOf(clean,best)};
}

// 两档，不做四档：档位一多，「准确提及」就变成玄学，现场没人说得清为什么这条进了槽。
function scoreOf(clean,hit){
 const before=clean[hit.index-1]||'';
 const after=clean.slice(hit.index+hit.alias.length);
 if(hit.index===0||before==='@')return 2;
 if(ASK_AFTER.test(after))return 2;
 return 1;
}

export class MentionRouter {
 constructor({personas=[],now=Date.now,limits={},log=()=>{}}={}){
  this.now=now;
  this.log=log;
  this.limits={...MENTION_LIMITS,...limits};
  this.table=buildAliasTable(personas);
  this.personas=new Map((Array.isArray(personas)?personas:[]).map(item=>[String(item.id),item]));
  this.items=[];
  // 点名配额按人算，与反应位的滚动配额是两套账：一个人可以在反应位上说过话，
  // 同时还没被点过名——这两件事在观众那边完全不是一回事。
  this.repliedAt=new Map();
  this.stats={heard:0,named:0,queued:0,replied:0,released:0,requeued:0,expired:0,quota:0,injection:0,full:0,replaced:0};
 }

 get size(){return this.items.length;}
 persona(id){return this.personas.get(String(id))||null;}

 // 正赛和场间均允许连续多轮对话，只限制短时连发。
 quotaWindow(phase='match'){
  const ms=phase==='vote'?this.limits.voteQuotaMs:this.limits.slotQuotaMs;
  return Math.max(0,Number(ms)||0);
 }

 // 归一化 + 命中 + 配额 + 入队。返回值就是给 runner 的分流依据：
 //   score 2 → 进点名槽（queued=true 才是真的排上了）
 //   score 1 → 回反应池，带 halfMention 标记（排序 +20，但不是直接对话）
 hear(event={}){
  this.stats.heard++;
  const text=normalizeComment(event.text);
  if(!text)return {ok:false,reason:'empty'};
  if(isInjection(text)){this.stats.injection++;return {ok:false,reason:'injection'};}
  const hit=findMention(text,this.table);
  if(!hit)return {ok:false,reason:'none'};
  this.stats.named++;
  if(hit.score<2)return {ok:true,score:1,personaId:hit.personaId,name:hit.name,halfMention:true};
  const userId=String(event.userId||event.name||'').trim();
  if(!userId)return {ok:false,reason:'anonymous',personaId:hit.personaId};
  const now=this.now();
  const last=this.repliedAt.get(userId);
  if(last!==undefined&&now-last<this.quotaWindow(event.phase)){
   this.stats.quota++;
   return {ok:false,reason:'quota',personaId:hit.personaId,retryAfterMs:this.quotaWindow(event.phase)-(now-last)};
  }
  // 同一个人连着点名：留最新那句。留着旧的等于答一个他已经改口的问题。
  const existing=this.items.find(item=>item.userId===userId);
  if(existing){
   // 新对象隔离旧的生成/配音 Promise，旧问题完成后不能覆盖新问题的回复。
   const replacement={...existing,text,at:now,personaId:hit.personaId,alias:hit.alias,pending:null,ready:'',failed:'',settled:false,audioJob:null,audioText:'',audioSide:'',audioReady:null,audioError:''};
   this.items[this.items.indexOf(existing)]=replacement;
   this.stats.replaced++;
   return {ok:true,score:2,queued:true,item:replacement,personaId:hit.personaId,name:hit.name};
  }
  if(this.items.length>=this.limits.queueMax){
   this.stats.full++;
   return {ok:false,reason:'full',personaId:hit.personaId};
  }
  const item={
   userId,name:String(event.name||'观众').slice(0,24),text,at:now,
   score:hit.score,personaId:hit.personaId,alias:hit.alias,
   // pending 是「提前写」的承诺。点名槽是可预测的，所以在入队那一刻就开始写，
   // 到点通常已经写好——现场再写要等模型四秒，那四秒台上是空的。
   pending:null,ready:'',failed:''
  };
  this.items.push(item);
  this.stats.queued++;
  return {ok:true,score:2,queued:true,item,personaId:hit.personaId,name:hit.name};
 }

 // 到点取人。取出来就算离开队列（悲观），写不出来再 release。
 plan({max=this.limits.slotMax,eligible=null}={}){
  const now=this.now();
  const stale=this.items.filter(item=>now-item.at>this.limits.ttlMs);
  if(stale.length){
   this.items=this.items.filter(item=>!stale.includes(item));
   this.stats.expired+=stale.length;
  }
  const picked=[...this.items]
   .filter(item=>!eligible||eligible(item))
   .sort((a,b)=>Number(this.repliedAt.has(a.userId))-Number(this.repliedAt.has(b.userId))||b.score-a.score||a.at-b.at)
   .slice(0,Math.max(0,max));
  this.items=this.items.filter(item=>!picked.includes(item));
  return picked;
 }

 // 真正回应后才开始短暂冷却，没播不占机会。
 commit(items){
  const list=Array.isArray(items)?items:[items];
  const now=this.now();
  for(const item of list){
   if(!item)continue;
   this.repliedAt.set(item.userId,now);
   this.stats.replied++;
  }
  return this.stats.replied;
 }

 release(item){
  if(!item)return 0;
  this.stats.released++;
  return this.stats.released;
 }

 // 到点还没写好：排回去等下一幕，不收配额。
 // 这不是「降级」，是「晚一幕」——观众问的是这一场里的问题，三分钟后答仍然成立；
 // 而直接丢掉，他今晚就只有这一次机会，还被模型的速度吞了。
 requeue(item){
  if(!item)return 0;
  if(this.now()-item.at>this.limits.ttlMs){this.stats.expired++;return 0;}
  if(this.items.includes(item))return 0;
  this.items.unshift(item);
  this.stats.requeued++;
  return this.items.length;
 }

 // 暂停恢复 / 换场：池里的句子指向的是几分钟前的画面，全部倒掉。
 flush(){
  const count=this.items.length;
  this.items=[];
  return count;
 }

 reset(){
  this.items=[];
  this.repliedAt.clear();
  this.stats={heard:0,named:0,queued:0,replied:0,released:0,requeued:0,expired:0,quota:0,injection:0,full:0,replaced:0};
 }

 snapshot(){
  return {
   queued:this.items.length,
   next:this.items[0]?{name:this.items[0].name,text:this.items[0].text,personaId:this.items[0].personaId}:null,
   aliases:this.table.map(row=>row.alias),
   stats:{...this.stats}
  };
 }
}

export default MentionRouter;
