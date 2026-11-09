// 反应位旁挂调度：把「剧本时间轴」「弹幕池」「三层路由」接在一起。
// 它只回答三件事——这一格说不说、说哪一句、这句是现成的还是要等——
// 不碰音频队列：播放器拿到结果自己插队（priority 排序在 speech-queue.js 里现成）。
// 这样调度逻辑可以脱离音频单独跑，59 句假剧本 + 虚拟时钟就能验收。
//
// 与播放器的分工：
//   播放器   推进剧本游标、取音频、管缓冲
//   这里     在剧本句子之间的空隙里，决定要不要塞一句、塞什么
// 反应句占的时间是「额外加出来的」（见 §2.1 时间账），所以 slipMs 只增不减，
// 剧本本身的 startMs/endMs 不会被改写——剧本是剧本，接话是接话。
import {ReactionRouter} from './reactions.mjs';

export const STAGE_LIMITS={
  replyMs:3500,      // 一条反应句约 3.5 秒（2~4 秒区间取中），加在剧本之后
  genMs:3600,        // L1 现场生成的平均耗时；实测 3~6 秒，P50 约 3.6
  genMaxMs:12000,    // 超过这条线就不等了。35 秒才写出来的回复，观众早忘了自己说过什么，
                     // 而且生成时喂的是上一幕的论点，接上去必然答非所问——不如直接走 L0。
  ambientMs:3500
};

// 气氛句是预渲染的通用句，不贴具体语境。真实运行时由 P4 的社交库出 40 条里的一批，
// 这里放几条样本，够验证「池空但房间热」这条路径。
const AMBIENT=[
  '台下这反应，我看是站我这边的。',
  '话都说到这份上了，还有人不服。',
  '这屋里现在比台上热闹。',
  '都别急着站队，先听完这段。'
];

export class ReactionStage{
 // draft(item,slot) -> 文本；真实运行时接 buildReactionMessages + LLM。
 // genMs(rng,item) 注入是为了让回放可复现：固定种子 = 固定延迟 = 可对比的两版代码。
 constructor({router=null,library=null,now=Date.now,limits={},draft=null,genMs=null,rng=Math.random,log=()=>{}}={}){
  this.router=router||new ReactionRouter({now});
  this.library=library;
  this.now=now;
  this.limits={...STAGE_LIMITS,...limits};
  this.rng=rng;
  this.draft=draft||(()=> '');
  this.genMs=genMs||(()=>Math.round(this.limits.genMs*(0.6+this.rng()*1.1)));
  this.log=log;
  this.timeline=[];
  this.startedAt=this.now();   // 剧本开播的绝对时刻：位置时间点必须和 now() 同一基准，
  this.scriptMs=0;             // 否则 job.readyAt（绝对）和 at（相对）比大小永远判「赶不上」
  this.cursor=0;
  this.slipMs=0;        // 接话加出来的时间
  this.holdMs=0;        // 暂停累计时长，恢复后整条时间轴后移
  this.act=null;
  this.jobs=new Map();  // userId -> {readyAt,text,failed,layer,ms,act}
  this.paused=false;
  this.stats={slots:0,replied:0,ambient:0,skip:0,overrun:0,bubble:0,wall:0,l0:0,l1:0,degraded:0,lapsed:0,stale:0,slow:0,failed:0,playedMs:0,pausedAt:0,resumedAt:0};
 }

 // 剧本：{turns:[{id,act,side,estSec,durationMs,keywords,reaction}]}
 // reaction:false 的位置不设槽——冷开场和两个结辩幕一停顿就散了（见 §6.5.3）。
 // durationMs 优先于 estSec：预渲染过的剧本知道真实音频长度，用它排轴，
 // 位置就不会因为「字数估算偏 15%」在半小时里漂出一分钟。
 attach(script){
  const turns=Array.isArray(script?.turns)?script.turns:[];
  const timeline=[];
  let at=0;
  turns.forEach((turn,index)=>{
   const measured=Number(turn.durationMs);
   const sec=measured>0?measured/1000:(Number(turn.estSec)||27);
   timeline.push({
    turnId:String(turn.id??index+1),index,
    act:Number.isFinite(turn.act)?turn.act:0,
    side:turn.side==='B'?'B':'A',
    startMs:at,endMs:at+sec*1000,
    keywords:Array.isArray(turn.keywords)?turn.keywords:[],
    reaction:turn.reaction!==false
   });
   at+=sec*1000;
  });
  this.timeline=timeline;
  this.startedAt=this.now();
  this.scriptMs=at;
  this.cursor=0;this.slipMs=0;this.holdMs=0;this.act=null;
  this.jobs.clear();
  return timeline.length;
 }

 // 跳幕：把游标挪到某一格，并把时间轴的零点重新钉在「现在」。
 // 不这么做的话，跳过去的那些格子已经「早就到点」，下一次 advance 会一次补播一串接话。
 seek(index){
  const target=Math.max(0,Math.min(this.timeline.length,Math.trunc(index)));
  this.cursor=target;
  const slot=this.timeline[target];
  if(slot)this.startedAt=this.now()-slot.startMs;
  // 跨幕之后上一幕的弹幕作废：语境翻篇了，硬接就是答非所问。
  this.act=null;
  return this.cursor;
 }

 // 换一批台词（场控重写某一幕）：整条时间轴重建，游标按 turn id 回到原位。
 // 按 id 而不是按下标——重写那一幕的句数会变，下标早就对不上了。
 rebuild(turns,{turnId=null}={}){
  const at=this.now();
  this.attach({turns});
  const index=turnId?Math.max(0,this.timeline.findIndex(slot=>slot.turnId===String(turnId))):0;
  this.cursor=index;
  const slot=this.timeline[index];
  // 让「现在」正好是这一格的起点：已经播过的部分不该再占墙钟时间。
  if(slot)this.startedAt=at-slot.startMs;
  this.act=null;
  return index;
 }

 currentSlot(){
  if(!this.timeline.length)return null;
  return this.timeline[Math.min(this.cursor,this.timeline.length-1)];
 }

 // 开播：把时间轴的零点钉在「真的开始播」这一刻。
 // attach 那一刻只是把剧本装进来，前头还有预热（合成前几句）和倒计时；
 // 如果零点留在 attach，预热花掉的一分钟会让整条轴一开播全部「已到点」。
 begin(at=this.now()){
  this.startedAt=at;
  this.slipMs=0;
  this.holdMs=0;
  this.paused=false;
  return this.startedAt;
 }

 // 这一句的真实时长回写给时间轴。字数估算与真实音频差 10%~20%，
 // 59 句累积能漂出一分钟——播到后半场，位置时刻会越来越早，最后全部判「到点太晚」。
 // 只改这一句的 endMs 与它后面的句子，已过去的不动。
 retime(index,ms){
  const slot=this.timeline[index];
  const length=Math.round(Number(ms));
  if(!slot||!Number.isFinite(length)||length<=0)return 0;
  const delta=length-(slot.endMs-slot.startMs);
  if(!delta)return 0;
  slot.endMs+=delta;
  for(let i=index+1;i<this.timeline.length;i++){this.timeline[i].startMs+=delta;this.timeline[i].endMs+=delta;}
  this.scriptMs=Math.max(0,this.scriptMs+delta);
  return delta;
 }

 // 弹幕进池。暂停期间只上墙——观众还在打字，但画面停着，这些话说出来就是错位的。
 hear(event){
  if(this.paused){this.stats.wall++;return {ok:false,reason:'paused'};}
  const slot=this.currentSlot();
  const result=this.router.hear(event,{act:slot?.act??0,keywords:slot?.keywords??[]});
  if(result.ok)this.schedule(result.item,slot);
  return result;
 }

 // 进池即排生成，不等反应位——这是 §6.5.5 的 L1，平均投放延迟因此是负数。
 // draft 可以是字符串，也可以是 Promise：真实链路是异步的模型调用，
 // 回放里注入同步函数只是为了可复现。异步时 readyAt 以「真的写好」为准，
 // genMs 只作为「预计多久」的估算，不参与判定——估算当作事实，正是「迟到 35 秒
 // 仍判命中」那类 bug 的来源。
 schedule(item,slot){
  const act=slot?.act??null;
  if(item.social){
   // 社交类走 L0 预渲染库，现场写反而更慢，还得排合成。库空了才降级。
   this.jobs.set(item.userId,{readyAt:this.now(),text:null,failed:false,layer:'L0-A',ms:0,act});
   return;
  }
  const startedAt=this.now();
  const estimate=this.genMs(this.rng,item);
  const job={readyAt:startedAt+estimate,text:'',failed:false,layer:'L1',ms:estimate,act};
  this.jobs.set(item.userId,job);
  let pending;
  try{
   pending=this.draft(item,slot);
  }catch{
   job.failed=true;this.stats.failed++;
   return;
  }
  if(pending&&typeof pending.then==='function'){
   job.async=true;
   pending.then(text=>{
    const written=String(text||'').trim();
    const spent=this.now()-startedAt;
    job.text=written;
    job.ms=spent;
    job.readyAt=this.now();
    // 慢过 12 秒就不等了：这时候弹幕早已滚过几屏，接上去也是答非所问。
    if(!written)job.failed=true;
    else if(spent>this.limits.genMaxMs){job.failed=true;this.stats.slow++;}
   },()=>{job.failed=true;});
   return;
  }
  // 同步路径（回放/离线预览）：估算时长就是判据。
  if(estimate>this.limits.genMaxMs){job.failed=true;this.stats.slow++;}
  const written=String(pending||'').trim();
  if(!written)job.failed=true;else job.text=written;
 }

 // 接话实际花了多久。advance 里先按 replyMs（3.5 秒）记了一笔，这里按真实墙钟校正：
 // 接话只花了 1 秒，却往时间轴上加 3.5 秒，下一格就会「还没到」而被白白跳过；
 // 反过来接话拖到 6 秒，时间轴就落在真实播放后面，位置会连着判超时。
 // 误差只允许「落后」（安全），不允许「超前」（跳过）。
 settle(actualMs){
  const length=Math.round(Number(actualMs));
  if(!Number.isFinite(length)||length<=0)return 0;
  const delta=length-this.limits.replyMs;
  if(delta)this.slipMs=Math.max(0,this.slipMs+delta);
  return delta;
 }

 // 整段后移。点名句是插在换幕处的额外时间，从来没有预记过，所以不能用 settle
 // （那条会先减掉 3.5 秒的预记账）。插了多久，后面的位置就整体推后多久。
 shift(ms){
  const length=Math.round(Number(ms));
  if(!Number.isFinite(length)||length<=0)return 0;
  this.slipMs+=length;
  return length;
 }

 // 三层路由：L1 现成 → L0 预渲染 → L2 气泡。
 // 「赶不上」不是异常，是设计里就有的一档：位置前 3 秒才来的弹幕必然走 L0。
 route(item,slot,at){
  const job=this.jobs.get(item.userId);
  if(job&&!job.failed&&typeof job.text==='string'&&job.text&&job.readyAt<=at){
   // 幕已经翻篇就不能用了：写的时候在第 5 幕，播的时候在第 6 幕，接上去是答非所问。
   if(job.act!==null&&job.act!==slot.act){this.stats.stale++;return this.fallback(item,slot);}
   return {layer:'L1',text:job.text,latencyMs:job.ms};
  }
  if(job&&job.readyAt>at)this.stats.lapsed++;
  return this.fallback(item,slot);
 }

 // 降级到 L0 预渲染库；库也空了就交给气泡（L2）。
 fallback(item,slot){
  const ready=this.library?.pick?.(slot.side);
  if(ready)return {layer:item.social?'L0-A':'L0-degrade',text:ready,latencyMs:0};
  return {layer:'L2',text:'',latencyMs:0};
 }

 slot(slot,at){
  this.stats.slots++;
  const plan=this.router.plan({turnId:slot.turnId,index:slot.index,keywords:slot.keywords});
  if(plan.kind==='reply'){
   const item=plan.item;
   const route=this.route(item,slot,at);
   if(route.layer==='L2'){
    // 气泡兜底：上墙但不占声音。这一条必须作废——回池的话下一格又选它，整场反复念同一句。
    this.router.discard(item,'no-audio');
    this.stats.bubble++;
    return {kind:'bubble',reason:'no-audio',item};
   }
   this.router.commit(item);
   this.jobs.delete(item.userId);
   this.stats.replied++;
   if(route.layer==='L1')this.stats.l1++;
   else{this.stats.l0++;if(route.layer==='L0-degrade')this.stats.degraded++;}
   return {kind:'reply',layer:route.layer,text:route.text,item,latencyMs:route.latencyMs};
  }
  if(plan.kind==='ambient'){
   this.stats.ambient++;
   return {kind:'ambient',layer:'L0-A',text:this.ambient()};
  }
  this.stats.skip++;
  return {kind:'skip',reason:plan.reason};
 }

 ambient(){
  const index=Math.floor(this.rng()*AMBIENT.length)%AMBIENT.length;
  return AMBIENT[index];
 }

 // 推进到 toMs。返回这期间发生的投放（一次可能跨多格，暂停恢复后尤其）。
 // max 是「这一次最多接几句」。播放器每播完一句只调一次，因为它只能插一句——
 // 落后两格时把两句接话连着塞进去，听众听到的是一段自言自语，不是对话。
 // 超出的格子直接作废（不调 plan，不扣任何人的配额）：位置比人便宜。
 advance(toMs,{max=Infinity}={}){
  const out=[];
  // 暂停期间游标不动：真实播放器此时不会调 advance，这里挡住是为了防止
  // 场控面板的定时器还在打点，一暂停就补播一串。
  if(this.paused)return out;
  let spoken=0;
  while(this.cursor<this.timeline.length){
   const slot=this.timeline[this.cursor];
   const at=this.startedAt+slot.endMs+this.slipMs+this.holdMs;
   if(at>toMs)break;
   this.cursor++;
   // 换幕：上一幕的弹幕作废。语境已经翻篇，硬接就是答非所问。
   if(this.act!==null&&slot.act!==this.act)this.router.expire(slot.act);
   this.act=slot.act;
   if(!slot.reaction)continue;
   if(spoken>=max){
    this.stats.slots++;this.stats.overrun++;
    out.push({at,act:slot.act,index:slot.index,turnId:slot.turnId,side:slot.side,kind:'skip',reason:'overrun'});
    continue;
   }
   const decision=this.slot(slot,at);
   if(decision.kind==='reply'||decision.kind==='ambient'){this.slipMs+=this.limits.replyMs;spoken++;}
   // side/index 一并带出去：播放器要按这一格是谁的场子选音色，
   // 不能等到播的时候再猜「上一位是谁」——自由辩里两位是交替的，猜必错。
   out.push({at,act:slot.act,index:slot.index,turnId:slot.turnId,side:slot.side,...decision});
  }
  this.stats.playedMs=this.timeline.length
   ?this.timeline[this.timeline.length-1].endMs+this.slipMs+this.holdMs
   :0;
  return out;
 }

 // 暂停：游标和时间轴一起停。池里继续进的东西全部倒掉（flush），
 // 因为观众看的是三分钟前的画面，恢复后先把那些话说出来就是错位。
 pause(){
  if(this.paused)return 0;
  this.paused=true;
  this.stats.pausedAt=this.now();
  return this.stats.pausedAt;
 }

 resume(){
  if(!this.paused)return {flushed:0,pausedMs:0};
  const from=this.stats.pausedAt||this.now();
  const pausedMs=Math.max(0,this.now()-from);
  this.paused=false;
  this.holdMs+=pausedMs;
  this.stats.resumedAt=this.now();
  const flushed=this.router.flush();
  this.jobs.clear();
  return {flushed,pausedMs};
 }

 snapshot(){
  const base=this.scriptMs?Math.round((this.stats.playedMs/this.scriptMs)*100):100;
  return {
   scriptMs:this.scriptMs,playedMs:this.stats.playedMs,slipMs:this.slipMs,
   cursor:this.cursor,slots:this.timeline.length,
   lengthRatio:Number((base/100).toFixed(3)),
   paused:this.paused,pool:this.router.snapshot().pool,
   stats:{...this.stats,router:{...this.router.stats}}
  };
 }
}

export default ReactionStage;
