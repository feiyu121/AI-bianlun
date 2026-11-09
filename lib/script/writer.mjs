// 剧本写手（P1 大纲 → P2 分幕扩写 → P3 校验 → P4 时长校准）。
// 方案见 DEBATE-SCRIPT.md §3 / §4。
//
// 为什么不能一次调用写完 30 分钟：长文本必然跑题、复用同一个例子、并逐渐同意对方。
// 分幕写，每幕一次请求，写完立刻过机器校验；整场再消一次重——这是长稿最容易崩的地方，
// 必须机器判，不能靠提示词哀求（提示词只能要求，校验才能拦住）。
//
// 并发与上下文的取舍：§4 说每幕要带「前两幕最后 2 句原话」，但按幕串行是 11×120 秒，
// 跑不进正赛的 30 分钟窗口。所以按块并发（默认 3 幕一块），块与块之间传真实原话，
// 块内部传前一幕的大纲要点。差别只在「同一块里相邻两幕的衔接」，而块边界都落在小结/交锋口，
// 本来就是复盘句，损失可接受。
import {SAFETY_PROMPT} from '../safety.mjs';
import {parseJSONReply,sharedWord} from './prompts.mjs';

// 单句 130~155 字 ≈ 28~32 秒（§2.1）。校验按 118~160 卡：
// 下界放一点是因为模型数不准字数，120 字的句子念出来同样成立；
// 上界卡死是因为超过 160 字一句要 34 秒，两句之间观众就开始看弹幕了。
// 目标 145~160 是**原始字数**（含标点）：实测中文标点占 11%，150 原始字里只有 133 个是念出来的。
// 133 / 4.9 = 27 秒，整场只有 26.7 分钟——比设计的 29.5 少三分多。
// 要让念出来满 30 秒，原始字数得到 165 上下，所以目标定在 145~160（扩写实测会超出目标约 7%）。
export const LINE_LIMITS={minChars:118,maxChars:180,target:'145~160'};
// 语速：CloudVoice 实测中文约 4.9 字/秒，和 debate.mjs 的 estimateDuration 同源。
export const CHARS_PER_SEC=4.9;
// 每句要占的秒数。语速 × 秒数 = 需要的字数，也是判断「这一幕够不够长」的尺子。
export const LINE_SECONDS=30;

// 幕结构直接写死，不让模型生成——幕数一漂，时长、反应位、互动槽全跟着漂。
// 句数合计 59，反应位 51（冷开场 2 + 两个结辩 6 句不设），与 §6.5.11 的实测一致。
export const ACTS=Object.freeze([
 {id:'open',label:'冷开场',turns:2,reaction:false,
  goal:'报题、双方亮立场。最后一句要把这场的真分歧点出来，不要客套、不要介绍规则'},
 {id:'caseA',label:'立论 A',turns:3,first:'A',
  goal:'A 方三个前提立住，第三个必须落到一个具体场景（一个动作、一个时间点）'},
 {id:'caseB',label:'立论 B',turns:3,first:'B',
  goal:'B 方反向前提、算成本账，末尾用一个问题把 A 逼到墙角'},
 {id:'clash1',label:'交锋一 · 定义与前提',turns:12,
  goal:'争「算不算」，互相拆对方的定义，逼对方在两个坏选项里选一个'},
 {id:'sum1',label:'小结一 · 半场复盘与票数',turns:3,slot:true,
  goal:'各自认一处自己的漏洞，说半场错在哪；票数只表态度，不念数字'},
 {id:'clash2',label:'交锋二 · 成本与代价',turns:13,
  goal:'算账：谁付成本、谁受益。必须出现一次真实的让步，让步之后再反打'},
 {id:'clash3',label:'交锋三 · 案例对决',turns:12,
  goal:'各讲一个具体故事（有人、有事、有时间），再互拆对方的故事'},
 {id:'sum2',label:'小结二 · 票数与反超',turns:3,slot:true,
  goal:'落后一方讲反超叙事，领先一方讲为什么现在不能松'},
 {id:'closeB',label:'结辩 B',turns:3,first:'B',reaction:false,
  goal:'收束：把全场压成一句判准，让台下能拿去用'},
 {id:'closeA',label:'结辩 A',turns:3,first:'A',reaction:false,
  goal:'收束并回扣开场那句，最后一句要能单独被记住'},
 {id:'tail',label:'尾声',turns:2,slot:true,
  goal:'认账、谢票、不给结论，把话留给台下。不报数字、不喊下一场'}
]);

// 并发默认 2 不是 3：实测这个网关同时压三个 3000 token 的请求会直接断连（fetch failed），
// 一批里除了第一个全挂。2 是还能跑通的档，再往上要靠网关侧限流配合。
export const WRITER_DEFAULTS=Object.freeze({concurrency:2,retries:1,similarity:0.35,targetMinutes:30});

const PUNCT=/[\s，。！？、；：""''「」『』（）《》〈〉…—·,.!?;:"'()\-]/g;
// 与 debate.mjs 的 AGREEMENT / CATCHPHRASE 同源，但不 import：那个模块拖着 engine 和存储，
// 写手是纯函数 + 一个 complete，不该被拖进来（同 prompts.mjs 对 sharedWord 的处理）。
const AGREEMENT=/你说得对|说得对|说得很对|说得很明白|同意你|我认同|确实如此|有道理啊|你说得好|这点我承认你是对的/u;
const CATCHPHRASE=/这句(我|也)不?接|我不接|不接这|没法接|接不住|先把.{0,6}说圆|说圆|圆不回|圆回来|这(话|个|账)圆/u;
const META_TALK=/(辩论赛|辩题|这是设定|节目效果|我们在辩论|我是(一个)?(主播|AI)|有剧本|按稿)/u;
const FORMAT_CHARS=/[#*`~|]|（|）|\(|\)|【|】/;
// 「接住了对方」的显式标记。没有显式标记时退到 4-gram 重合（同 debate.mjs 的 sharedFragment）。
const RESPOND_TO=/(对方辩友|你刚才|你方|你这话|你那个|你说的|你上一条|你这句话)/u;

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
 return Math.max(6,Math.round(chars/CHARS_PER_SEC));
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

// 一句能不能上墙。返回 soft 的（太短、没接住对方）不丢——丢了这一幕就断，
// 而断句在直播里比一句平庸的话明显得多。丢的只有「不能播」的：格式、认输、自曝。
export function validateLine(text,{prev='',stanceWords=[],limits=LINE_LIMITS,respond=true}={}){
 const value=String(text??'').trim();
 if(!value)return {ok:false,reason:'空句'};
 if(FORMAT_CHARS.test(value))return {ok:false,reason:'含格式或旁白'};
 if(META_TALK.test(value))return {ok:false,reason:'解释规则'};
 if(AGREEMENT.test(value))return {ok:false,reason:'认同对手'};
 if(CATCHPHRASE.test(value))return {ok:false,reason:'口头禅复读'};
 const soft=[];
 if(value.length<limits.minChars)soft.push('太短');
 // 交锋性：三种都算接住——显式标记 / 与对方上一句共享一个 2 字实词 / 4-gram 有重合。
 // 只认 4-gram 是不行的：实测 59 句里有 39 句被判「没接对方」，读下来明明句句在回
 // （「账这个字你抓得紧，那就看账」），只是没复述对方四个字。判据比现实严，就会逼模型去抄原话。
 // 2 字实词用的是反应位那套 sharedWord，两处一致，人才知道该信哪个数。
 if(respond&&prev&&!RESPOND_TO.test(value)&&!sharedWord(value,prev)&&similarity(value,prev)<0.03)soft.push('没接对方');
 const words=(stanceWords||[]).filter(word=>String(word||'').length>=2);
 if(words.length&&!words.some(word=>value.includes(word)))soft.push('没沾立场词');
 return {ok:true,text:value,soft};
}

// ── 提示词 ───────────────────────────────────────────────────────────────
function sideBlock(side){
 return [
  `${side.name}（${side.id} 方），立场：${side.stance||''}`,
  side.style?`　表达风格：${side.style}`:'',
  side.points?.length?`　不可让步的前提：${side.points.map((p,i)=>`${i+1}.${p}`).join(' ')}`:''
 ].filter(Boolean).join('\n');
}

// P1：只出大纲，不出台词。11 幕的骨架已经定死，模型只填「这一幕争什么、要展开哪几点」。
export function buildOutlineMessages({topic='',sides=[],avoid=[],acts=ACTS}={}){
 const [A,B]=sides;
 const system=[
  `你在给一场 30 分钟的直播辩论做大纲。辩题：《${topic}》`,
  sideBlock(A||{id:'A',name:'正方'}),
  sideBlock(B||{id:'B',name:'反方'}),
  '下面 11 幕的顺序已经定死，你只填每一幕的两样东西：goal（这一幕要争出什么，一句话）和 points（2~4 条具体要点，不是口号）。',
  acts.map((act,index)=>`${index+1}. ${act.id}｜${act.label}｜${act.turns} 句｜原定目的：${act.goal}`).join('\n'),
  '要点必须能落地：写「拿上班刷手机查资料这件事问对方算不算」，不要写「深入探讨定义」。',
  '两方的要点不许互补——如果 A 说「时间被切碎了」，B 的要点就要能一刀切在这上面。',
  avoid.length?`上一场已经用过这些例子，不要再用：${avoid.slice(0,8).join('、')}`:'',
  `输出 JSON 对象：{"clash1":{"goal":"…","points":["…","…"]}, …}，键就是上面每一幕的 id，${acts.length} 个都要有。`,
  '只输出 JSON，不要代码块，不要解释。',
  SAFETY_PROMPT
 ].filter(Boolean).join('\n');
 return [{role:'system',content:system},{role:'user',content:JSON.stringify({辩题:topic})}];
}

// P2：一幕一请求。上一幕的原话是硬需求（要能引对方的词），块内退到大纲要点。
export function buildActMessages({topic='',sides=[],act,plan={},previous=[],repeats=[]}={}){
 const [A,B]=sides;
 const nameOf=id=>sides.find(side=>side.id===id)?.name||(id==='B'?'反方':'正方');
 const totalChars=`${act.turns} 句，每句 ${LINE_LIMITS.target} 字`;
 const system=[
  `你在写一场直播辩论的第 ${ACTS.findIndex(a=>a.id===act.id)+1} 幕台词。辩题：《${topic}》`,
  sideBlock(A||{id:'A',name:'正方'}),
  sideBlock(B||{id:'B',name:'反方'}),
  `本幕：${act.label}。要争出的是：${plan.goal||act.goal}`,
  plan.points?.length?`本幕要点：\n${plan.points.map((p,i)=>`${i+1}. ${p}`).join('\n')}`:'',
  previous.length?`上一幕最后两句（要能引，但别复述）：\n${previous.map(row=>`${nameOf(row.side)}：${row.text}`).join('\n')}`:'',
  repeats.length?`这些例子/说法前面已经用过，别再讲：${repeats.slice(0,6).join('、')}`:'',
  `写 ${totalChars}。${act.first?`第一句由${nameOf(act.first)}说。`:''}双方轮流出，不许连着说三句。`,
  '每句只推进一个点，句子要口语、能被念出来：短句开头，长句在后，末尾别用总结腔。',
  '必须接住对方上一句：引用他的一个词再推开，或者直接说「你刚才那句」。不许互相认同、不许说「你说得对」。',
  '不许出现：括号旁白、星号、Markdown、表情符号；不许提「辩论」「辩题」「剧本」「按稿」。',
  '输出 JSON 数组：[{"side":"A","beat":"拆定义","text":"…"}]，side 只能是 A 或 B。',
  '只输出 JSON，不要代码块，不要解释。',
  SAFETY_PROMPT
 ].filter(Boolean).join('\n');
 return [
  {role:'system',content:system},
  {role:'user',content:JSON.stringify({辩题:topic,本幕:act.label,句数:act.turns,先说:act.first?nameOf(act.first):'自由'})}
 ];
}

// P3：二次扩写。
// 为什么必须有：实测提示词要 130~155 字，模型写 102~145；改要 160~175，它反而写得更短（105~134）。
// 中文字数不是模型能自己数准的量，靠提示词调只会白试——只能写完再补。
// 补的时候只许加细节（时间点、动作、一句反问、一次让步），不许动观点、说话人和顺序，
// 所以整块一次调用就够，不必逐句：逐句要 12 次调用，成本翻倍还容易写出十二种腔调。
export function buildRefineMessages({sides=[],turns=[]}={}){
 const rows=turns.map((turn,index)=>({i:index,who:sides.find(side=>side.id===turn.side)?.name||turn.side,text:turn.text}));
 const system=[
  `下面 ${turns.length} 句是刚写好的辩论台词，每句念出来只有 20 秒上下，需要 30 秒。`,
  `逐句把它扩写到 ${LINE_LIMITS.target} 字。只加细节：具体的时间点、具体的动作、一句反问、一次让步。`,
  '不许加新论点，不许换立场，不许换说话人，不许合并或拆开句子，不许改变顺序。',
  '每句开头的那个钩子（「你刚才那句…」这类引语）必须原样留着——那是接对方话的地方，删了就不成对话。',
  '不许出现括号旁白、星号、Markdown；不许说「谢谢」「你说得对」「理解」。',
  '输出 JSON 数组，每项 {"i":序号,"text":"完整的一句"}，序号照抄输入的 i，一个都不能少。',
  '只输出 JSON，不要代码块，不要解释。'
 ].join('\n');
 return [{role:'system',content:system},{role:'user',content:JSON.stringify(rows)}];
}

// ── 写手 ─────────────────────────────────────────────────────────────────
// complete: (messages, {maxTokens}) => Promise<string>。和 tools/reaction-lib.mjs 同一个签名。
export class ScriptWriter{
 constructor({complete,sides=[],topic='',safety=null,log=()=>{},now=Date.now,
  concurrency=WRITER_DEFAULTS.concurrency,retries=WRITER_DEFAULTS.retries,
  similarity:threshold=WRITER_DEFAULTS.similarity}={}){
  if(typeof complete!=='function')throw new Error('写手需要 complete(messages) 回调');
  this.complete=complete;
  this.sides=sides;
  this.topic=topic;
  this.safety=safety;
  this.log=log;
  this.now=now;
  this.concurrency=Math.max(1,Math.trunc(concurrency));
  this.retries=Math.max(0,Math.trunc(retries));
  this.threshold=threshold;
  this.acts=ACTS;
  this.stats={calls:0,failed:0,retried:0,refined:0,tokens:0};
 }

 async outline({topic=this.topic,avoid=[]}={}){
  const messages=buildOutlineMessages({topic,sides:this.sides,avoid,acts:this.acts});
  let error=null;
  // 11 幕的大纲实测 2600 字（约 1500 token），1600 的上限会把它从中间截断，
  // 截断的 JSON 永远解析不出来——所以上限放到 2600，并且失败再来一次（网络抖动同样会让它空回）。
  for(let attempt=0;attempt<2;attempt++){
   try{
    this.stats.calls++;
    const reply=await this.complete(messages,{maxTokens:2600});
    const json=parseJSONReply(reply);
    if(!json||typeof json!=='object'||Array.isArray(json))throw new Error('大纲不是对象');
    return {plan:json,fallback:false};
   }catch(caught){error=caught;}
  }
  // 大纲挂了不阻断：幕骨架本来就在代码里，缺的只是「这一幕争什么」。
  // 用内置 goal 兜底，剧情会平庸一点，但整场能写出来、能播。
  this.stats.failed++;
  this.log(`大纲失败（${error.message}），改用内置幕骨架`);
  return {plan:{},fallback:true};
 }

 async expand(act,plan={},context={}){
  // 提示词只能给一次，所以重写提示必须每轮重新取：第一版把它算在循环外，
  // 第二次请求里那句「上一次写的不合格：」是空的——等于没给任何方向，白花一次调用。
  let hint=context.hint||'';
  let best=null;
  for(let attempt=0;attempt<=this.retries;attempt++){
   const messages=buildActMessages({topic:this.topic,sides:this.sides,act,plan,previous:context.previous||[],repeats:context.repeats||[]});
   if(attempt>0)messages[0]={role:'system',content:messages[0].content+'\n上一次写的不合格：'+hint+'。这次必须改掉。'};
   let rows=[];
   try{
    this.stats.calls++;
    const reply=await this.complete(messages,{maxTokens:3200});
    rows=normalizeRows(parseJSONReply(reply),act);
   }catch(error){
    this.stats.failed++;
    if(attempt>=this.retries){this.log(`${act.label} 写失败：${error.message}`);return {act,turns:[],dropped:0,built:false};}
    continue;
   }
   const built=this.build(act,rows);
   if(!best||built.turns.length>best.turns.length)best=built;
   const offTarget=built.soft.filter(reason=>reason==='没接对方').length;
   const weak=built.turns.length===0||built.turns.length<Math.ceil(act.turns*0.6);
   if(!weak&&offTarget<=Math.ceil(built.turns.length*0.4))return built;
   if(attempt<this.retries){
    this.stats.retried++;
    hint=weak?'句数不够或整段跑偏':'多数句子没有接住对方，各说各的';
   }
  }
  return best||{act,turns:[],dropped:0,built:false};
 }

 // 逐句清洗 + 判定。返回干净的 turns 和 soft 清单（soft 不丢，只记账）。
 build(act,rows){
  const turns=[],soft=[];
  for(const row of rows){
   if(turns.length>=act.turns)break;
   const {text}=repairLine(row.text);
   const prev=[...turns].reverse().find(turn=>turn.side!==row.side);
   const checked=validateLine(text,{prev:prev?.text||'',stanceWords:[]});
   if(!checked.ok){this.log(`${act.label} 丢一句：${checked.reason}｜${text.slice(0,20)}`);soft.push(checked.reason);continue;}
   turns.push({side:row.side,text:checked.text,beat:String(row.beat||'').slice(0,12)});
   soft.push(...checked.soft);
  }
  // 先说的那一方：模型经常把开场给反。直接翻不是办法（那句话是给对方写的），
  // 所以只在整段第一句错了时才翻——单句翻会造出「用对方的口吻说自己立场」。
  if(act.first&&turns.length&&turns[0].side!==act.first)turns.shift();
  return {act,turns,dropped:rows.length-turns.length,soft,built:true};
 }

 // 块内扩写。返回补出来的秒数（记账用）。
 // 判断门槛放在「整块」而不是「每句」：一块里大半句都短才值得花一次调用；
 // 只有两三句短的时候，多出来的二十秒对整场没有意义，补它反而是浪费。
 async refineGroup(turns){
  // 按句挑，不按块平均：第一版用整块平均命中率，结果「立论 B」那三句 22 秒的短句
  // 被另外两幕的长句平均掉了，整块判合格、一句没补。短的是具体的句子，不是块。
  const short=turns.filter(turn=>estSeconds(turn.text)<LINE_SECONDS*0.85);
  // 只短一两句就算了：多二十秒对整场没意义，白花一次调用。
  if(short.length<2)return 0;
  const current=short.reduce((sum,turn)=>sum+estSeconds(turn.text),0);
  let rows;
  try{
   this.stats.calls++;
   const reply=await this.complete(buildRefineMessages({sides:this.sides,turns:short}),{maxTokens:Math.min(6000,Math.ceil(short.length*230))});
   const json=parseJSONReply(reply);
   rows=Array.isArray(json)?json:(Array.isArray(json?.lines)?json.lines:[]);
  }catch(error){
   // 扩写失败不影响播出：句子短一点，节奏快一点，只是整场会提早几分钟收尾。
   this.stats.failed++;
   this.log(`扩写失败（${error.message}），保留原句`);
   return 0;
  }
  const before=current;
  short.forEach((turn,index)=>{
   const row=rows.find(item=>Number(item?.i)===index)??rows[index];
   const raw=typeof row==='string'?row:String(row?.text??'');
   const {text}=repairLine(raw);
   // 只收「确实变长了」的：模型偶尔会顺手改短，或者原句照抄回来，那等于没扩。
   if(!text||text.length<=turn.text.length+8)return;
   // 钩子必须还在：扩写最容易丢的就是句首那句引语，丢了这一句就没有接住对方。
   const hook=/^(你刚才|你方|你说的|对方辩友)/u.exec(turn.text)?.[1];
   if(hook&&!text.startsWith(hook))return;
   const checked=validateLine(text,{prev:'',stanceWords:[],respond:false});
   if(!checked.ok)return;
   turn.text=checked.text;
   this.stats.refined++;
  });
  return short.reduce((sum,turn)=>sum+estSeconds(turn.text),0)-before;
 }

 async write({topic=this.topic,sides=this.sides,acts=this.acts}={}){
  this.topic=topic;
  this.acts=acts;
  if(sides.length)this.sides=sides;
  const startedAt=this.now();
  const {plan,fallback}=await this.outline({topic,avoid:[]});
  const groups=[];
  for(let i=0;i<acts.length;i+=this.concurrency)groups.push(acts.slice(i,i+this.concurrency));

  const expanded=[];
  let tail=[];
  const repeats=[];
  for(const group of groups){
   // 块内真并发：整块一次发出去，等齐再进下一块。块首那一幕拿上一块的真实原话，
   // 块内的后续幕拿不到（并发时它还没写完），损失落在块内的衔接上，见文件头。
   const results=await Promise.all(group.map((act,index)=>this.expand(act,plan[act.id]||{},{
    previous:index===0?tail:[],
    repeats:[...repeats]
   })));
   await this.refineGroup(results.flatMap(row=>row.turns||[]));
   expanded.push(...results);
   tail=lastTwo(expanded.flatMap(row=>row.turns||[]));
   collectRepeats(expanded,repeats);
  }
  const script=this.assemble({expanded,plan,fallback,startedAt});
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
    // 跨幕消重：30 分钟长稿最容易崩的就是「同一个例子讲三次」。
    // 命中就丢——丢一句，那幕短一秒，比让台下听两遍强。
    const clash=rows.find(prev=>similarity(turn.text,prev.text)>=this.threshold);
    if(clash){duplicates.push({text:turn.text.slice(0,24),same:clash.text.slice(0,24)});continue;}
    rows.push({
     id:`t${String(rows.length+1).padStart(3,'0')}`,
     act:number,
     side:turn.side,
     text:turn.text,
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
   sides:this.sides.map(side=>({id:side.id,name:side.name,voice:side.voice||'',stance:side.stance||'',points:side.points||[]})),
   acts:kept,
   turns:rows,
   meta:{
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
  .map(row=>({side:row?.side==='B'?'B':(row?.side==='A'?'A':null),text:String(row?.text??row?.line??'').trim(),beat:String(row?.beat??'')}))
  .filter(row=>row.side&&row.text)
  .slice(0,act.turns+2);
}

// 已用过的例子：4-gram 在整场出现两次以上的，说明这是个反复讲的段子/说法。
function collectRepeats(expanded,out){
 const counts=new Map();
 for(const act of expanded)for(const turn of act.turns||[])for(const gram of gramsOf(turn.text))counts.set(gram,(counts.get(gram)||0)+1);
 for(const [gram,count]of counts)if(count>=2&&!out.includes(gram))out.push(gram);
 out.sort((a,b)=>counts.get(b)-counts.get(a));
}

function lastTwo(turns){
 return turns.slice(-2).map(turn=>({side:turn.side,text:turn.text}));
}

export default ScriptWriter;
