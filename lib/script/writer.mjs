// 短场写手：大纲 → 分段生成 → 可播格式校验 → 消重，不按时长自动扩写。
// 默认顺序生成，每幕承接上一幕的真实原话；人物可以认同、修正，不靠固定句式维持冲突。
import {SAFETY_PROMPT} from '../safety.mjs';
import {parseJSONReply} from './prompts.mjs';
import {castPrompt,PERSONA_VERSION} from '../personas.mjs';
import {ConversationMemory,memoryPrompt} from '../conversation-memory.mjs';
import {EPISODE_LIMITS} from './episode.mjs';
import {performanceFields,PERFORMANCE_PROMPT} from '../../public/performance.js';

// 单轮允许短问或较长解释；整场时长使用总字符预算，避免等长小作文。
export const LINE_LIMITS={minChars:1,maxChars:260};
// 语速估计：中文约 4.9 字/秒。
export const CHARS_PER_SEC=4.9;
// 每个参考轮的内容预算，用于分段估时，不要求每句等长。
export const LINE_SECONDS=18;

// 五个后台分段与24个参考轮，允许短问短答和提前收尾，不规定论证步骤。
export const ACTS=Object.freeze([
 {id:'open',label:'冷开场',turns:2,reaction:false,
  goal:'从一个具体疑问自然进入，让双方的分歧显出来；不必主持式报题或介绍规则'},
 {id:'caseA',label:'接着聊',turns:5,slot:true,goal:'接住话头，抓住一个具体分歧；不要重复介绍观点'},
 {id:'clash1',label:'交锋',turns:9,slot:true,goal:'追问真正未解决的条件，有新信息再展开；同一意思说一次就够'},
 {id:'sum1',label:'换个角度',turns:5,slot:true,goal:'只追有意思的新变化；没有新内容就往收尾走，不补例子凑时长'},
 {id:'tail',label:'尾声',turns:3,slot:true,
  goal:'像熟人聊完一件事那样自然收住；可以仍有分歧，不编造谢票，不喊下一场'}
]);

// 同一剧本默认串行以保留衔接；运行时另有跨剧本的全局请求并发限制。
export const WRITER_DEFAULTS=Object.freeze({concurrency:1,retries:1,similarity:0.9,targetMinutes:EPISODE_LIMITS.targetMinutes});

const PUNCT=/[\s，。！？、；：""''「」『』（）《》〈〉…—·,.!?;:"'()\-]/g;
const META_TALK=/(辩论赛|辩题|这是设定|节目效果|我们在辩论|我是(一个)?(主播|AI)|有剧本|按稿)/u;
const FORMAT_CHARS=/[#*`~|]|（|）|\(|\)|【|】/;
export function cleanLine(text){return String(text??'').replace(PUNCT,'');}

// n-gram 用字符不用词：中文没有空格，分词器一上就要引依赖，而消重只需要「这八个字出现过」。
export function gramsOf(text,n=4){
 const clean=cleanLine(text),out=new Set();
 for(let i=0;i+n<=clean.length;i++)out.add(clean.slice(i,i+n));
 return out;
}

// Jaccard：分母取小集合，长句里抄了一句短句也会被抓住。
// 用并集的话，「150 字的句子 + 30 字重复」只有 0.19，永远拦不住。
export function similarity(a,b,n=4){
 const left=gramsOf(a,n),right=gramsOf(b,n);
 if(!left.size||!right.size)return 0;
 let hit=0;
 for(const gram of left)if(right.has(gram))hit++;
 return hit/Math.min(left.size,right.size);
}

export function estSeconds(text){
 const chars=cleanLine(text).length;
 return Math.max(1,Math.round(chars/CHARS_PER_SEC));
}

// ── 单句修补 ─────────────────────────────────────────────────────────────
// 只做「减法」：删括号旁白、剥 Markdown、去引号、超长按标点收尾。
// 不做补写——缺字补出来的半句比短句更糟，短句观众只当他在换气。
export function repairLine(value,limits=LINE_LIMITS){
 const raw=String(value??'');
 let text=raw
  .replace(/（[^）]*）/g,'').replace(/\([^)]*\)/g,'')
  .replace(/[#*`~|]/g,'')
  .replace(/[\r\n\t]+/g,' ')
  .replace(/^["“”'‘’「」『』\s]+|["“”'‘’「」『』\s]+$/g,'')
  .replace(/\s{2,}/g,' ').trim();
 if(text.length>limits.maxChars){
  const cut=text.slice(0,limits.maxChars);
  const stop=Math.max(cut.lastIndexOf('。'),cut.lastIndexOf('！'),cut.lastIndexOf('？'));
  text=stop>=limits.minChars?cut.slice(0,stop+1):cut.slice(0,limits.maxChars-1).replace(/[，、—–\-…\s]+$/,'')+'。';
 }
 return {text,changed:text!==raw};
}

// 一句能不能上墙。可配置的长度软提示不丢句，
// 只丢不可播的格式或自曝，局部认同和自然短答可以保留。
export function validateLine(text,{limits=LINE_LIMITS}={}){
 const value=String(text??'').trim();
 if(!value)return {ok:false,reason:'空句'};
 if(FORMAT_CHARS.test(value))return {ok:false,reason:'含格式或旁白'};
 if(META_TALK.test(value))return {ok:false,reason:'解释规则'};
 const soft=[];
 if(value.length<limits.minChars)soft.push('太短');
 // 只校验可播格式；不能用原词重合或固定接话标记代替对含义的理解。
 return {ok:true,text:value,soft};
}

// ── 提示词 ───────────────────────────────────────────────────────────────
// P1：只出大纲，不出台词；各段方向可由后续自然对话调整。
export function buildOutlineMessages({topic='',sides=[],avoid=[],acts=ACTS}={}){
 const system=[
  `你在给一场目标 6～8 分钟的双人直播对话做大纲。辩题：《${topic}》`,
  castPrompt(sides,{opening:true}),
  '下面仅为后台时长和互动分段，不规定人物行为或话题顺序。可为各段填 goal 和 points 作为可放弃的方向，不要求定义、成本、案例、小结依次登场。角色的开场意见可以互换、靠近或改变。',
  acts.map((act,index)=>`${index+1}. ${act.id}｜${act.label}｜${act.turns} 句｜原定目的：${act.goal}`).join('\n'),
  '要点必须落在当前辩题的具体情境、选择和后果上，不写「深入探讨定义」这类空话，也不套用与本题无关的职场例子。没有预设开场意见时，自行形成双方具体的关注差异，允许之后变化。',
  '保持双方真实的关注差异，也容许发现共同点、修正原先判断；不设计每幕都先反驳再升华的流程。不预设胜负、票数或观众反应。聊透可以提前结束，不为时长增添话头。',
  avoid.length?`上一场已经用过这些例子，不要再用：${avoid.slice(0,8).join('、')}`:'',
  `输出 JSON 对象：{"clash1":{"goal":"…","points":["…","…"]}, …}，键就是上面每一幕的 id，${acts.length} 个都要有。`,
  '只输出 JSON，不要代码块，不要解释。',
  SAFETY_PROMPT
 ].filter(Boolean).join('\n');
 return [{role:'system',content:system},{role:'user',content:JSON.stringify({辩题:topic})}];
}

// P2：一幕一请求，传入上一幕原话供理解语境，不强制引用原词。
export function buildActMessages({topic='',sides=[],act,plan={},previous=[],memory}={}){
 const nameOf=id=>sides.find(side=>side.id===id)?.name||(id==='B'?'反方':'正方');
 const targetChars=Math.round(act.turns*LINE_SECONDS*CHARS_PER_SEC);
 const system=[
  `你在写一场直播辩论的第 ${ACTS.findIndex(a=>a.id===act.id)+1} 幕台词。辩题：《${topic}》`,
  castPrompt(sides,{opening:!memory?.history?.length}),
  `后台分段：${act.label}。可参考方向：${plan.goal||act.goal}；前文自然走向优先，可以放弃这个方向。`,
  plan.points?.length?`可选想法，不必逐条完成：\n${plan.points.join('；')}`:'',
  memoryPrompt(memory),
  previous.length?`上一幕最后几句（接续真实语境，不必复述）：\n${previous.map(row=>`${nameOf(row.side)}：${row.text}`).join('\n')}`:'',
  `本幕总共约 ${targetChars} 个可朗读字符（约 ${Math.round(act.turns*LINE_SECONDS/60)} 分钟），参考 ${act.turns} 轮发言，可自然拆成最多 ${act.turns*3} 轮；总时长靠整幕控制。${act.first?`由${nameOf(act.first)}起话。`:''}`,
  '字数和轮数只是参考，可以更短。短问可以只有几个字，每轮最多 260 字。删掉换措辞复述、无效尾巴和重复抒情；同一梗没有新变化就结束，不凑时长。',
  '听见对方的意思再回应，可以直接回答、追问、局部认同或改口；可以接旧梗、翻旧账、短暂岔开再回来。不按固定顺序分配反驳、关心或升华。',
  '不许出现：括号旁白、星号、Markdown、表情符号；不许提「辩论」「辩题」「剧本」「按稿」。',
  '输出 JSON 数组，每项包含 side 和 text，side 只能是 A 或 B；text 只写自然说出口的话。',
  PERFORMANCE_PROMPT,
  '只输出 JSON，不要代码块，不要解释。',
  SAFETY_PROMPT
 ].filter(Boolean).join('\n');
 return [
  {role:'system',content:system},
  {role:'user',content:JSON.stringify({辩题:topic,本幕:act.label,句数:act.turns,先说:act.first?nameOf(act.first):'自由'})}
 ];
}

// 只有整段内容不足时补充实质细节，不把短问逐一扩写。
export function buildRefineMessages({sides=[],turns=[],missingSeconds=0,memory}={}){
 const rows=turns.map((turn,index)=>({i:index,who:sides.find(side=>side.id===turn.side)?.name||turn.side,text:turn.text}));
 const system=[
  castPrompt(sides),memoryPrompt(memory),
  `这段对话整体内容不足，下面选出 ${turns.length} 轮有展开空间的发言，合计可再增加约 ${Math.round(missingSeconds*CHARS_PER_SEC)} 字。按整段补充有意义的内容，不要求每轮都到 30 秒。`,
  '只在确有未讲清的理由、细节或条件处补充；短问和短答应保持简短，不灌水，不把每句变成等长的小作文。每轮最多 260 字。',
  '保留原意、说话人、顺序和对话衔接，可以调整开头的措辞，不必保留固定钩子。允许局部认同，不要求每次让步后反打。',
  '不许出现括号旁白、星号、Markdown，不捏造真实新闻或观众态度；虚构共同往事保持一致。',
  '输出 JSON 数组，每项 {"i":序号,"text":"完整的一句"}，序号照抄输入的 i，一个都不能少。',
  '只输出 JSON，不要代码块，不要解释。'
 ].join('\n');
 return [{role:'system',content:system},{role:'user',content:JSON.stringify(rows)}];
}

// ── 写手 ─────────────────────────────────────────────────────────────────
// complete: (messages, {maxTokens}) => Promise<string>。和 tools/reaction-lib.mjs 同一个签名。
export class ScriptWriter{
 constructor({complete,sides=[],topic='',safety=null,log=()=>{},onProgress=()=>{},signal,now=Date.now,
  memory=new ConversationMemory(),concurrency=WRITER_DEFAULTS.concurrency,retries=WRITER_DEFAULTS.retries,
  similarity:threshold=WRITER_DEFAULTS.similarity}={}){
  if(typeof complete!=='function')throw new Error('写手需要 complete(messages) 回调');
  this.complete=complete;
  this.sides=sides;
  this.seedMemory=memory.clone();this.memory=memory.clone();
  this.topic=topic;
  this.safety=safety;
  this.log=log;
  this.onProgress=onProgress;this.signal=signal;
  this.now=now;
  this.concurrency=Math.max(1,Math.trunc(concurrency));
  this.retries=Math.max(0,Math.trunc(retries));
  this.threshold=threshold;
  this.acts=ACTS;
  this.stats={calls:0,failed:0,retried:0,refined:0,tokens:0};
 }
 report(message,details={}){this.log(message);try{this.onProgress({message,at:this.now(),...details});}catch{}}

 async outline({topic=this.topic,avoid=[]}={}){
  const messages=buildOutlineMessages({topic,sides:this.sides,avoid,acts:this.acts});
  let error=null;
  // 11 幕的大纲实测 2600 字（约 1500 token），1600 的上限会把它从中间截断，
  // 截断的 JSON 永远解析不出来——所以上限放到 2600，并且失败再来一次（网络抖动同样会让它空回）。
  for(let attempt=0;attempt<2;attempt++){
   this.signal?.throwIfAborted();
   this.report(`正在生成 ${this.acts.length} 幕大纲${attempt?'（重试）':''}`,{phase:'outline',attempt:attempt+1});
   try{
    this.stats.calls++;
    const reply=await this.complete(messages,{maxTokens:2600});
    const json=parseJSONReply(reply);
    if(!json||typeof json!=='object'||Array.isArray(json))throw new Error('大纲不是对象');
    this.report('大纲已完成，开始逐幕写作',{phase:'outline'});
    return {plan:json,fallback:false};
   }catch(caught){this.signal?.throwIfAborted();error=caught;if(attempt===0)this.report(`大纲请求失败：${caught.message}，准备重试`,{phase:'outline'});}
  }
  // 大纲挂了不阻断：幕骨架本来就在代码里，缺的只是「这一幕争什么」。
  // 用内置 goal 兜底，剧情会平庸一点，但整场能写出来、能播。
  this.stats.failed++;
  this.report(`大纲失败（${error.message}），改用内置幕骨架`,{phase:'outline'});
  return {plan:{},fallback:true};
 }

 async expand(act,plan={},context={}){
  // 提示词只能给一次，所以重写提示必须每轮重新取：第一版把它算在循环外，
  // 第二次请求里那句「上一次写的不合格：」是空的——等于没给任何方向，白花一次调用。
  let hint=context.hint||'';
  let best=null;
  for(let attempt=0;attempt<=this.retries;attempt++){
   this.signal?.throwIfAborted();
   const actNumber=this.acts.indexOf(act)+1;
   this.report(`正在写第 ${actNumber}/${this.acts.length} 幕「${act.label}」${attempt?`（第 ${attempt+1} 次尝试）`:''}`,{phase:'act',act:actNumber,actLabel:act.label,attempt:attempt+1});
   const messages=buildActMessages({topic:this.topic,sides:this.sides,act,plan,previous:context.previous||[],memory:context.memory||this.memory.snapshot()});
   if(attempt>0)messages[0]={role:'system',content:messages[0].content+'\n上一次写的不合格：'+hint+'。这次必须改掉。'};
   let rows=[];
   try{
    this.stats.calls++;
    const reply=await this.complete(messages,{maxTokens:Math.max(1800,Math.ceil(act.turns*LINE_SECONDS*CHARS_PER_SEC*1.9))});
    rows=normalizeRows(parseJSONReply(reply),act);
   }catch(error){
    this.signal?.throwIfAborted();
    this.stats.failed++;
    if(attempt>=this.retries){this.report(`${act.label} 写失败：${error.message}`,{phase:'act'});return {act,turns:[],dropped:0,built:false};}
    hint=error.message;
    this.report(`${act.label} 请求失败：${error.message}，准备重试`,{phase:'act'});
    continue;
   }
   const built=this.build(act,rows);
   if(!best||built.turns.length>best.turns.length)best=built;
   const weak=built.turns.length===0;
   if(!weak)return built;
   if(attempt<this.retries){
    this.stats.retried++;
    hint='句数不够或整段格式无效';
    this.report(`${act.label} 仅有 ${built.turns.length} 句有效台词，准备重写`,{phase:'act'});
   }
  }
  return best||{act,turns:[],dropped:0,built:false};
 }

 // 逐句清洗 + 判定。返回干净的 turns 和 soft 清单（soft 不丢，只记账）。
 build(act,rows){
  const turns=[],soft=[];
  for(const row of rows){
   if(turns.length>=act.turns*3)break;
   const {text}=repairLine(row.text);
   const checked=validateLine(text);
   if(!checked.ok){this.log(`${act.label} 丢一句：${checked.reason}｜${text.slice(0,20)}`);soft.push(checked.reason);continue;}
   turns.push({side:row.side,text:checked.text,...performanceFields(row),beat:String(row.beat||'').slice(0,12)});
   soft.push(...checked.soft);
  }
  // 仅兼容手动指定 first 的自定义分段；默认分段不限制谁先说。
  if(act.first&&turns.length&&turns[0].side!==act.first)turns.shift();
  return {act,turns,dropped:rows.length-turns.length,soft,built:true};
 }

 // 整段不足预算九成时，补充有实质内容的发言；短问短答保持原样。
 // 返回补出来的秒数，仅供记账，不保证模型一定补足目标时长。
 async refineGroup(turns,{targetSeconds=turns.length*LINE_SECONDS}={}){
  const total=turns.reduce((sum,turn)=>sum+estSeconds(turn.text),0);
  if(total>=targetSeconds*0.9){this.report(`当前约 ${Math.round(total/60)} 分钟，内容预算已足够，跳过扩写`,{phase:'refine'});return 0;}
  // Preserve short exchanges. Only expand substantive turns, and keep one request bounded.
  const selected=new Set(turns.filter(turn=>cleanLine(turn.text).length>=24&&turn.text.length<LINE_LIMITS.maxChars-16).sort((a,b)=>b.text.length-a.text.length).slice(0,12));
  const short=turns.filter(turn=>selected.has(turn));
  // 没有可展开的发言时不强行灌水。
  if(!short.length){this.report('没有适合展开的长发言，保留现有短问短答',{phase:'refine'});return 0;}
  const current=short.reduce((sum,turn)=>sum+estSeconds(turn.text),0);
  let rows;
  this.signal?.throwIfAborted();
  this.report(`当前约 ${Math.round(total/60)} 分钟，正在补充 ${short.length} 段发言的内容`,{phase:'refine'});
  try{
   this.stats.calls++;
   const reply=await this.complete(buildRefineMessages({sides:this.sides,turns:short,missingSeconds:targetSeconds-total,memory:this.memory.snapshot()}),{maxTokens:Math.min(7000,Math.ceil(short.length*450))});
   const json=parseJSONReply(reply);
   rows=Array.isArray(json)?json:(Array.isArray(json?.lines)?json.lines:[]);
  }catch(error){
   this.signal?.throwIfAborted();
   // 扩写失败不影响播出：句子短一点，节奏快一点，只是整场会提早几分钟收尾。
   this.stats.failed++;
   this.report(`扩写失败（${error.message}），保留原句`,{phase:'refine'});
   return 0;
  }
  const before=current;
  short.forEach((turn,index)=>{
   const row=rows.find(item=>Number(item?.i)===index)??rows[index];
   const raw=typeof row==='string'?row:String(row?.text??'');
   const {text}=repairLine(raw);
   // 只收「确实变长了」的：模型偶尔会顺手改短，或者原句照抄回来，那等于没扩。
   if(!text||text.length<=turn.text.length+8)return;
   // Meaning must remain related; exact opening phrases are free to change.
   if(similarity(text,turn.text)<0.15)return;
   const checked=validateLine(text,{prev:'',stanceWords:[],respond:false});
   if(!checked.ok)return;
   turn.text=checked.text;
   this.stats.refined++;
  });
  const added=short.reduce((sum,turn)=>sum+estSeconds(turn.text),0)-before;
  this.report(`扩写已完成，新增约 ${Math.round(added)} 秒内容`,{phase:'refine'});return added;
 }

 async write({topic=this.topic,sides=this.sides,acts=this.acts}={}){
  this.memory=this.seedMemory.clone();
  this.topic=topic;
  this.acts=acts;
  if(sides.length)this.sides=sides;
  const startedAt=this.now();
  const {plan,fallback}=await this.outline({topic,avoid:[]});
  const groups=[];
  for(let i=0;i<acts.length;i+=this.concurrency)groups.push(acts.slice(i,i+this.concurrency));

  const expanded=[];
  let tail=[];
  for(const group of groups){
   // 默认每组一幕，持续传递原话；显式提高并发时，只有组首能拿到上一组原话。
   const results=await Promise.all(group.map((act,index)=>this.expand(act,plan[act.id]||{},{
    previous:index===0?tail:[],memory:this.memory.snapshot()
   })));
   expanded.push(...results);
   const written=expanded.flatMap(row=>row.turns||[]),chars=written.reduce((sum,row)=>sum+row.text.length,0),estTotalSec=written.reduce((sum,row)=>sum+estSeconds(row.text),0);
   this.report(`已处理 ${expanded.length}/${acts.length} 幕，累计 ${written.length} 句、${chars} 字，约 ${Math.round(estTotalSec/60)} 分钟`,{phase:'act',completedActs:expanded.length,totalActs:acts.length,validActs:expanded.filter(row=>row.turns?.length).length,turns:written.length,chars,estTotalSec});
   tail=recentTurns(expanded.flatMap(row=>row.turns||[]));
   for(const result of results)for(const turn of result.turns||[])this.memory.remember(turn);
  }
  // 成稿短于目标时也不自动扩写；避免把已经聊完的话题重新灌长。
  this.signal?.throwIfAborted();
  this.report('正在合并台词并检查重复内容',{phase:'assemble'});
  const script=this.assemble({expanded,plan,fallback,startedAt});
  this.report(`写稿完成：${script.turns.length} 句，约 ${Math.round(script.meta.estTotalSec/60)} 分钟，去除 ${script.meta.duplicates} 句重复内容`,{phase:'assemble',turns:script.turns.length,chars:script.turns.reduce((sum,row)=>sum+row.text.length,0),estTotalSec:script.meta.estTotalSec});
  return script;
 }

 assemble({expanded,plan,fallback,startedAt}){
  const rows=[];
  const kept=[];
  const duplicates=[];
  let dropped=0;
  for(const act of expanded){
   const number=this.acts.findIndex(item=>item.id===act.act.id)+1;
   const keptTurns=[];
   let count=0;
   for(const turn of act.turns||[]){
    // 只丢完全/近乎照抄的长句，保留带新内容的回扣。
    const clash=rows.find(prev=>isRedundant(turn.text,prev.text,this.threshold));
    if(clash){duplicates.push({text:turn.text.slice(0,24),same:clash.text.slice(0,24)});continue;}
    rows.push({
     id:`t${String(rows.length+1).padStart(3,'0')}`,
     act:number,
     side:turn.side,
     text:turn.text,
     ...performanceFields(turn),
     beat:turn.beat,
     estSec:estSeconds(turn.text),
     keywords:[],
     // 反应位标记跟着幕走，不是跟着句号走：冷开场和两个结辩幕一停顿就散了（§6.5.3）。
     reaction:act.act.reaction!==false
    });
    keptTurns.push(turn);
    count++;
   }
   // act.dropped 已经包含「生成回来但被判废」的句子；这里只加消重丢掉的，
   // 两处都加会把同一句算两遍（第一版就这么错过，校验报告里的丢句数虚高一倍）。
   dropped+=(act.dropped||0);
   if(keptTurns.length)kept.push({
    id:act.act.id,label:act.act.label,
    goal:plan[act.act.id]?.goal||act.act.goal,
    points:plan[act.act.id]?.points||[],
    turns:keptTurns.length
   });
  }
  const estTotalSec=rows.reduce((sum,turn)=>sum+turn.estSec,0);
  return {
   version:1,
   id:'',
   topic:this.topic,
   targetMinutes:WRITER_DEFAULTS.targetMinutes,
   sides:this.sides.map(side=>({...side,voice:side.voice||'',stance:side.stance||'',points:side.points||[]})),
   acts:kept,
   turns:rows,
   meta:{
    personaVersion:PERSONA_VERSION,
    generatedAt:new Date(this.now()).toISOString(),
    ...this.stats,
    fallback,duplicates:duplicates.length,dropped,estTotalSec,
    deviation:Number((estTotalSec/(WRITER_DEFAULTS.targetMinutes*60)-1).toFixed(3)),
    ms:this.now()-startedAt
   }
  };
 }
}

function normalizeRows(json,act){
 const list=Array.isArray(json)?json:Array.isArray(json?.lines)?json.lines:[];
 return list
  .map(row=>({side:row?.side==='B'?'B':(row?.side==='A'?'A':null),text:String(row?.text??row?.line??'').trim(),...performanceFields(row||{}),beat:String(row?.beat??'')}))
  .filter(row=>row.side&&row.text)
  .slice(0,act.turns*3);
}

// A repeated anchor with a new conclusion is a callback, not a duplicate.
export function isRedundant(a,b,threshold=WRITER_DEFAULTS.similarity){
 const left=cleanLine(a),right=cleanLine(b);
 if(Math.min(left.length,right.length)<24)return false;
 if(left===right)return true;
 if(similarity(a,b)<threshold)return false;
 const x=gramsOf(a),y=gramsOf(b),novel=[...x].filter(gram=>!y.has(gram)).length;
 return Math.abs(left.length-right.length)<=6&&novel<8;
}

function recentTurns(turns){
 return turns.slice(-4).map(turn=>({side:turn.side,text:turn.text}));
}

export default ScriptWriter;
