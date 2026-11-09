// 剧本播放器：游标 + 槽位 + 反应位旁挂。
// 用可控的虚拟时钟整场跑，验五件事：顺序不歪、接话插在句与句之间、
// 预渲染不进合成队列、暂停不补播、合成失败不停播。
import test from 'node:test';
import assert from 'node:assert/strict';
import {Studio as Engine} from '../lib/studio.mjs';
import {defaultSafety} from '../lib/safety.mjs';
import {ScriptRunner} from '../lib/script/runner.mjs';
import {ReactionRouter} from '../lib/script/reactions.mjs';
import {MentionRouter} from '../lib/mention.mjs';
import {GiftQueue} from '../lib/script/gifts.mjs';

const BASE=1_700_000_000_000;

function scriptOf(n,{estSec=27,ms=20_000,reaction=true,side=i=>i%2?'B':'A',actOf=i=>1}={}){
 const turns=[];
 for(let i=0;i<n;i++)turns.push({
  id:'s'+String(i).padStart(3,'0'),act:actOf(i),side:side(i),
  text:'第'+i+'句台词，说的是摸鱼这件事到底该不该算偷时间。',
  estSec,durationMs:ms,reaction:typeof reaction==='function'?reaction(i):reaction,keywords:['摸鱼']
 });
 return {id:'demo',topic:'摸鱼该不该管',turns};
}

// 假合成：默认每句 20 秒，可以指定哪一句失败。
function fakeVoice({ms=20_000,fail=null}={}){
 const calls=[];
 return {
  calls,
  async render(item,settings){
   calls.push({text:item.text,voice:settings?.voiceName});
   if(fail&&fail(item))throw new Error('合成超时');
   // 与真实链路一致：返回 url + 实测时长，播放器按它占节奏。
   return {url:'/audio/'+calls.length+'.mp3',durationMs:ms};
  }
 };
}

// 可控时钟：sleep 不自己结束，由 step() 推进。
// 这样「播到一半停下来」的用例（暂停、中途入池的弹幕）才有确定的时间点。
function make({n=4,voice=null,lookahead=2,prewarm=2,script=null,voiceExpected=()=>false,draft=null,
 mention=false,mentionDraft=null,mentionLimits={},actOf=i=>1,
 gifts=false,giftDraft=null,giftLimits={},onSpoken=()=>{}}={}){
 const engine=new Engine({safety:defaultSafety,saved:{config:{characterName:'肉包'}}});
 let clock=BASE;
 const pending=[];
 // 点名路由：默认不接。接了就是真路由器，别名跟场上的两个形象对齐。
 const router=mention
  ?new MentionRouter({
   personas:[{id:'A',name:'肉包',aliases:['小胖','鱼鱼']},{id:'B',name:'鲸鱼娘',aliases:['小鲸鱼']}],
   limits:mentionLimits,now:()=>clock
  })
  :null;
 // 礼物槽：同样默认不接。接了就是真队列，配额跟 GIFT_LIMITS 走。
 const giftQueue=gifts?new GiftQueue({limits:giftLimits,now:()=>clock}):null;
 const runner=new ScriptRunner({
  engine,
  cloudVoice:voice||fakeVoice(),
  safety:defaultSafety,
  now:()=>clock,
  sleep:ms=>new Promise(resolve=>pending.push({ms,resolve})),
  lookahead,prewarm,voiceExpected,
  // 反应句写手：默认异步返回一句短话（真实链路是模型调用，本来也是异步的）。
  draft:draft===null
   ? async item=>'这题我不让，'+item.text.slice(0,4)
   : draft,
  mention:router,
  mentionDraft,
  gifts:giftQueue,
  giftDraft,
  onSpoken,
  onChange:()=>{},
  onEnd:()=>{}
 });
 const box={
  runner,engine,router,gifts:giftQueue,
  get clock(){return clock;},
  get parked(){return pending.length;},
  // 把主循环跑到底：每次挂起的 sleep 都推到底。
  async step(){await flush();const job=pending.shift();if(!job)return false;clock+=job.ms;job.resolve();await flush();return true;},
  async playOut(max=200){for(let i=0;i<max;i++)if(!await box.step())break;},
  tick(ms){clock+=ms;}
 };
 runner.attach(script||scriptOf(n,{actOf}));
 return box;
}

// 冲掉微任务，让主循环跑到下一个挂起点。
// 6 轮而不是 3 轮：点名槽那条链有「取文本 → 合成 → 发布」三次挂起，
// 3 轮只能推到「文本拿到了」，断言会看到一条还没发布的空记录。
async function flush(){for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));}

test('装剧本：时长优先用预渲染的实测值，没有才退回 estSec',()=>{
 const {runner}=make({script:{turns:[
  {id:'a',act:1,side:'A',text:'有实测的一句',durationMs:12_340,estSec:27},
  {id:'b',act:1,side:'B',text:'只有估算的一句',estSec:30}
 ]}});
 assert.equal(runner.stage.timeline[0].endMs,12_340);
 assert.equal(runner.stage.timeline[1].endMs,12_340+30_000);
});

test('播放顺序：发布的就是剧本顺序，两条音色分开，预渲染地址随手挂上',async()=>{
 const {runner,engine,playOut}=make({n:3});
 await runner.start();
 await playOut();
 assert.deepEqual(engine.utterances.map(item=>item.text.slice(0,2)),['第0','第1','第2']);
 assert.deepEqual(engine.utterances.map(item=>item.speaker),['A','B','A']);
 // 预渲染地址挂在 utterance 上：/api/speech 见到它就不进合成队列。
 assert.ok(engine.utterances.every(item=>String(item.audio||'').startsWith('/audio/')));
 assert.equal(runner.cursor,3);
 assert.equal(runner.active,false,'播完就收摊');
});

test('空档：脚本是提前写好的，句与句之间不该有任何等待',async()=>{
 const {runner,playOut}=make({n:3});
 await runner.start();
 await playOut();
 const stats=runner.summary();
 assert.equal(stats.maxGap,0,'真实时钟里每一句都准时接上，空档只能是 0');
 assert.equal(stats.starved,0);
 assert.equal(stats.rhythm,'ok');
});

test('接话、点名和礼物完整进入主字幕，随实际开口发布并保留观众名',async()=>{
 const {runner,engine,step}=make({voiceExpected:()=>true});
 for(const kind of ['reaction','mention','gift','script']){
  const previous=engine.state.scriptLine,text='这是给观众的完整回答，不能被回执的六十字限制截断。'.repeat(4);
  const turn={id:kind,side:'B',text,durationMs:20000,audience:kind==='script'?undefined:{name:'观众甲'}};
  const speaking=runner.speak(turn,{kind});await flush();
  assert.equal(engine.state.scriptLine,previous,'出声前不能提前切换字幕');
  runner.voiceStarted(turn.utteranceId);await flush();
  assert.equal(engine.state.scriptLine.text,text);assert.equal(engine.state.scriptLine.kind,kind);
  assert.equal(engine.state.scriptLine.audienceName,kind==='script'?'':'观众甲');
  assert.equal(engine.state.scriptLine.side,'B');assert.equal(engine.state.scriptLine.id,turn.utteranceId);
  await step();await speaking;
 }
});
test('对话记忆只收到实际说完的台词，预读和中途停止不会记录未来',async()=>{
 const heard=[];const {runner,step}=make({n:3,onSpoken:(turn,{kind})=>heard.push({text:turn.text,kind})});
 await runner.start();await flush();assert.equal(heard.length,0);
 await step();assert.equal(heard.length,1);assert.equal(heard[0].kind,'script');assert.match(heard[0].text,/第0句/);
 runner.stop();await runner.running;assert.equal(heard.length,1);
});

test('预热 + 预读：开播前先合成前两句，播到中段时后面几句也已备好',async()=>{
 const voice=fakeVoice();
 const {runner,playOut}=make({n:6,voice,prewarm:2,lookahead:2});
 await runner.start();
 // start 返回时预热已经做完：脚本还没开播就占住了 TTS。
 assert.equal(runner.turns.filter(turn=>turn.audio).length,2);
 await playOut();
 assert.equal(voice.calls.length,6,'六句各合成一次，不重复');
 assert.equal(runner.summary().audioReady,6);
});

test('反应位：弹幕在换气处插一句，不占剧本句数',async()=>{
 const {runner,engine,step,playOut}=make({n:4});
 await runner.start();
 // 第一句正在播的时候观众说话——现实里就是这样，弹幕不会等你说完。
 runner.comment({name:'老王',userId:'u1',text:'不是这都能吵起来'});
 await step();                          // 第一句播完，紧接着就是它的换气处
 const reactions=engine.utterances.filter(item=>item.kind==='reaction');
 assert.equal(reactions.length,1,'这一格接了');
 assert.equal(runner.turns.length,4,'接话不进剧本 turns');
 await playOut();
 assert.equal(engine.utterances.filter(item=>item.kind==='debate').length,4,'剧本四句一句不少');
 assert.equal(runner.summary().reactions,1);
});

test('接话不进剧本上下文：观众不是第三辩手',async()=>{
 const {runner,engine,step,playOut}=make({n:3});
 await runner.start();
 runner.comment({name:'甲',userId:'u1',text:'摸鱼就是偷时间'});
 await step();
 await playOut();
 // 剧本每一句的文本从头到尾没被接话改过，也没有 audience 字段粘上去。
 assert.ok(runner.turns.every(turn=>turn.text.startsWith('第')));
 assert.equal(runner.turns.some(turn=>turn.audience),false);
 const reaction=engine.utterances.find(item=>item.kind==='reaction');
 assert.ok(reaction,'接话只活在 utterance 上');
 assert.equal(reaction.speaker,'A','接话用当前说话那一方的音色');
});

test('reaction:false 的位置不设槽：冷开场整段不接话',async()=>{
 const {runner,engine,step,playOut}=make({script:scriptOf(3,{reaction:i=>i!==0})});
 await runner.start();
 runner.comment({name:'甲',userId:'u1',text:'开场这句我就不服'});
 await step();                          // 第一句播完——这一格没有槽
 assert.equal(engine.utterances.filter(item=>item.kind==='reaction').length,0);
 await playOut();
 assert.equal(runner.stage.stats.slots,2,'三句里只有两格设了槽');
});

test('暂停：游标停在原地，暂停期间弹幕只上墙，恢复后接着播且不补播',async()=>{
 const {runner,engine,step,playOut,tick}=make({n:4});
 await runner.start();
 await step();                          // 第一句播完
 const cursorAtPause=runner.cursor;
 assert.equal(runner.pause(),true);
 tick(180_000);                         // 场控暂停三分钟
 const wall=runner.comment({name:'甲',userId:'u9',text:'暂停期间刷的'});
 assert.equal(wall.ok,false);
 assert.equal(wall.reason,'paused');
 assert.equal(runner.cursor,cursorAtPause,'暂停时游标不动');
 assert.equal(runner.stage.stats.wall,1,'暂停期间的弹幕只上墙');
 const resumed=runner.resume();
 assert.equal(resumed.pausedMs,180_000);
 await playOut();
 assert.equal(runner.cursor,4,'恢复后把剩下的播完');
 assert.equal(engine.utterances.filter(item=>item.kind==='reaction').length,0,'暂停期间的弹幕不补播');
});

test('停止：中途喊停，后面的句子不再播，收尾只走一次',async()=>{
 const {runner,engine,step,playOut}=make({n:5});
 let ended=0;
 runner.onEnd=()=>{ended++;};
 await runner.start();
 await step();
 const before=engine.utterances.length;
 assert.equal(runner.stop(),true);
 await playOut();
 assert.ok(runner.cursor<5,'没播完就停了');
 assert.equal(engine.utterances.length,before,'停止后不再往队列里塞句子');
 assert.equal(runner.active,false);
 assert.equal(ended,1);
});

test('合成失败不停播：这一句按字数估时长继续，字幕照走',async()=>{
 const voice=fakeVoice({fail:item=>item.text.startsWith('第1')});
 const {runner,playOut,engine}=make({n:3,voice});
 await runner.start();
 await playOut();
 assert.equal(runner.cursor,3,'第三句照样播完');
 assert.equal(runner.summary().voiceFailed,1);
 assert.match(runner.error,/第 2 句没合成出来/);
 // 那一句没有音频地址，前端取不到声音，但字幕照常往下走。
 const failed=engine.utterances.find(item=>item.text.startsWith('第1'));
 assert.equal(failed.audio,undefined);
 assert.ok(failed.text.length>0);
});

test('等出声：有播放器时按上报放行，字幕贴在那一声之后',async()=>{
 const {runner,engine,step}=make({n:2,voiceExpected:()=>true});
 await runner.start();
 await flush();
 const first=engine.utterances[0];
 assert.ok(first,'第一句已经发布');
 assert.notEqual(engine.state.subtitle,first.text,'还没出声，字幕不该抢跑');
 runner.voiceStarted(first.id);
 await flush();
 assert.equal(engine.state.subtitle,first.text,'出声之后才写字幕');
 assert.equal(engine.state.speakingSide,'A');
 runner.stop();
 await step();
});

test('快照：剧本进度、音频就绪数、接话账都留给场控面板',async()=>{
 const {runner,playOut}=make({n:3});
 await runner.start();
 await playOut();
 const view=runner.view();
 assert.equal(view.mode,'script');
 assert.equal(view.total,3);
 assert.equal(view.index,3);
 assert.equal(view.phase,'ended');
 assert.equal(view.stats.audioReady,3);
 assert.equal(view.stats.rhythm,'ok');
 assert.ok(view.scriptMs>0);
 assert.equal(typeof view.reaction.stats.l1,'number');
});

test('弹幕路由：未接点名时全部进反应池，接上之后点名的走点名',async()=>{
 const {runner}=make({n:2});
 await runner.start();
 const routed=runner.comment({name:'甲',userId:'u1',text:'你们是不是收钱了'});
 assert.equal(routed.routed,'reaction');
 assert.equal(routed.ok,true);
 runner.mention=()=>({side:'B',reason:'exact'});
 const named=runner.comment({name:'乙',userId:'u2',text:'鲸鱼娘你怎么看'});
 assert.equal(named.routed,'mention');
 assert.equal(named.side,'B');
 runner.stop();
});

test('过点太多就作废：落后两格时一次只接一句，不在句后连珠炮',async()=>{
 const {runner,step,playOut}=make({n:6});
 await runner.start();
 // 一次性塞五条，且每一格都合格——位置比人多，规矩是「最多连 2」。
 for(let i=0;i<5;i++)runner.comment({name:'甲'+i,userId:'u'+i,text:'摸鱼这事我得说两句'+i});
 await playOut();
 const stats=runner.summary();
 assert.ok(stats.reactions<=4,'六句里不可能有五句都接');
 assert.ok(stats.overrun>=0);
 assert.equal(runner.stage.router.streak<=2,true);
});

test('舞台自带一个路由器，不每格新建一个池',()=>{
 const {runner}=make({n:1});
 assert.ok(runner.stage.router instanceof ReactionRouter);
 assert.equal(runner.stage.router.snapshot().pool,0);
});

test('气泡：写手给不出话时不出声，但留一条回执给弹幕墙',async()=>{
 // 写手返回空 = 现场写不出来（模型挂了/超时），这一刻只能降级成气泡。
 const {runner,engine,step}=make({n:3,draft:()=>''});
 await runner.start();
 runner.comment({name:'老王',userId:'u1',text:'不是这都能吵起来'});
 await step();
 assert.equal(runner.receipts.length,1,'被听见了就得留痕，否则观众不知道自己被看了');
 assert.equal(runner.receipts[0].kind,'bubble');
 assert.equal(runner.receipts[0].name,'老王');
 assert.equal(runner.receipts[0].said,'');
 assert.equal(engine.utterances.filter(item=>item.kind==='reaction').length,0,'气泡不占声音');
});

test('回执：出声的那条带上是哪位辩手、说了什么',async()=>{
 const {runner,step}=make({n:3});
 await runner.start();
 runner.comment({name:'小李',userId:'u2',text:'你们老板同意吗'});
 await step();
 const receipt=runner.receipts.at(-1);
 assert.equal(receipt.kind,'reply');
 assert.equal(receipt.layer,'L1');
 assert.ok(receipt.said.includes('这题我不让'),'回执要带上真正说出去的那句');
 assert.ok(['肉包','鲸鱼娘'].includes(receipt.name2),'界面要知道是谁接的');
 assert.ok(receipt.at>0);
});

test('回执只留最近 12 条：一场几百条会把快照撑肥',async()=>{
 const {runner,step}=make({n:3});
 await runner.start();
 for(let i=0;i<20;i++){
  runner.comment({name:'观众'+i,userId:'u'+i,text:'第'+i+'条弹幕，摸鱼这事我得说两句'});
  await step();
 }
 assert.ok(runner.receipts.length<=12);
});

test('点名：写在换幕那一刻，不插在幕中间',async()=>{
 const {runner,engine,router,step}=make({
  n:4,actOf:i=>i<2?1:2,mention:true,
  mentionDraft:async()=>'你问的这句我记着：摸鱼不是偷时间，是把被切碎的时间拼回来。'
 });
 await runner.start();
 runner.comment({name:'老王',userId:'u1',text:'肉包你怎么看'});
 assert.equal(router.size,1);
 await step();
 assert.equal(engine.utterances.filter(item=>item.kind==='mention').length,0,'第 1 幕还没完，不能插话');
 await step();
 const said=engine.utterances.filter(item=>item.kind==='mention');
 assert.equal(said.length,1,'换幕那一刻才出声');
 assert.equal(said[0].name,'肉包');
 assert.ok(said[0].text.includes('拼回来'));
 // 回执在开口那一刻就写：弹幕墙要跟着这句话一起钉住那条弹幕。
 assert.equal(runner.receipts.at(-1).kind,'mention');
 assert.equal(runner.receipts.at(-1).name,'老王');
 await step();
 assert.equal(router.repliedAt.get('u1')>0,true,'整句说完才扣配额');
});

test('点名：写不出来就放弃这一条，配额退还',async()=>{
 const {runner,engine,router,step}=make({n:4,actOf:i=>i<2?1:2,mention:true,mentionDraft:async()=>''});
 await runner.start();
 runner.comment({name:'老王',userId:'u1',text:'肉包你怎么看'});
 await step();
 await step();
 assert.equal(engine.utterances.filter(item=>item.kind==='mention').length,0);
 assert.equal(router.stats.released,1);
 assert.equal(router.repliedAt.has('u1'),false,'没播就不扣，下一幕还能再点');
});

test('点名：名字在句中走反应池，只记半点名权重',async()=>{
 const {runner,router}=make({n:4,mention:true,mentionDraft:async()=>'不该被调用'});
 await runner.start();
 const out=runner.comment({name:'小李',userId:'u2',text:'我觉得肉包那句说得挺对'});
 assert.equal(out.routed,'reaction');
 assert.equal(router.size,0,'评不是问，不占点名槽');
 const pooled=[...runner.stage.router.pool.values()][0];
 assert.equal(pooled.halfMention,true,'半点名要在反应池里加权');
});

test('点名句占的是真时间：时间轴整段后移，后面的位置不会提前',async()=>{
 const {runner,step}=make({n:4,actOf:i=>i<2?1:2,mention:true,
  mentionDraft:async()=>'你问的这句我记着：摸鱼不是偷时间，是把被切碎的时间拼回来。'});
 await runner.start();
 runner.comment({name:'老王',userId:'u1',text:'肉包你怎么看'});
 await step();
 const before=runner.stage.slipMs;
 await step();
 await step();
 assert.ok(runner.stage.slipMs>before,'换了幕还插了一句 20 秒的话，整条时间轴得跟着走');
});

test('礼物：墨镜在幕末插一句，用记好的那一方的音色',async()=>{
 const {runner,engine,gifts,step}=make({
  n:4,actOf:i=>i<2?1:2,gifts:true,
  giftDraft:async()=>'账这个字你抓得紧，那就把八小时摊开来算，谁在替谁的时间付钱。'
 });
 await runner.start();
 // 此刻说话的是 A，墨镜记给对手 B——花钱买的是「让他回嘴」。
 const out=runner.gift({gift:'sunglasses',count:1,name:'老王',userId:'u1'});
 assert.equal(out.queued,true);
 assert.equal(out.side,'B');
 assert.equal(gifts.size,1);
 await step();
 assert.equal(engine.utterances.filter(item=>item.kind==='gift').length,0,'第 1 幕还没完，不能插话');
 await step();
 const said=engine.utterances.filter(item=>item.kind==='gift');
 assert.equal(said.length,1,'换幕那一刻才出声');
 assert.equal(said[0].name,'鲸鱼娘');
 assert.ok(said[0].text.includes('八小时'));
 assert.equal(runner.receipts.at(-1).kind,'gift');
 assert.ok(runner.receipts.at(-1).text.includes('墨镜'),'回执要让人看出是哪个礼物换的');
 // 出声只是 publish，commit 要等这一句真的说完——配额与账本都以「说完」为准，
 // 不然播到一半被停掉，这个人也算用过一次。
 await step();
 await step();
 assert.equal(gifts.stats.played,1);
});

test('礼物：写废了排回下一幕重写，钱不白花',async()=>{
 let tries=0;
 const {runner,engine,gifts,step,playOut}=make({
  n:6,actOf:i=>i<2?1:i<4?2:3,gifts:true,
  giftDraft:async()=>{tries++;return tries===1?'':'账这个字你抓得紧，那就第二幕再说一遍，钱不能白花。';}
 });
 await runner.start();
 runner.gift({gift:'sunglasses',count:1,name:'老王',userId:'u1'});
 await step();
 await step();
 assert.equal(engine.utterances.filter(item=>item.kind==='gift').length,0,'第一幕写废了，不出声');
 assert.equal(gifts.size,1,'写废了排回队列，不是丢掉——他花了钱');
 assert.equal(gifts.stats.retried,1);
 // 下一幕重写：pending 被清掉，才会真的再问一次模型。
 // 这里用 playOut 跑到底：下一幕的槽在第 4 句之后，固定推两步会数不准——
 // 上一条用例就是因为「推两次只够 publish，不够说完」才误判的。
 await playOut();
 const said=engine.utterances.filter(item=>item.kind==='gift');
 assert.equal(said.length,1,'第二幕补上');
 assert.equal(tries,2,'重写要真的再调一次写手');
});

test('礼物优先于点名：花了钱的先上',async()=>{
 const {runner,engine,step}=make({
  n:4,actOf:i=>i<2?1:2,mention:true,gifts:true,
  mentionDraft:async()=>'你问的这句我记着：摸鱼不是偷时间，是把被切碎的时间拼回来。',
  giftDraft:async()=>'账这个字你抓得紧，那就把八小时摊开来算，谁在替谁的时间付钱。'
 });
 await runner.start();
 runner.gift({gift:'sunglasses',count:1,name:'老王',userId:'u1'});
 runner.comment({name:'小李',userId:'u2',text:'肉包你怎么看'});
 // 三句：礼物句要说完，之后才轮到点名句。少推一次就只能看到礼物。
 await step();
 await step();
 await step();
 await step();
 const kinds=engine.utterances.map(item=>item.kind).filter(kind=>kind==='gift'||kind==='mention');
 assert.deepEqual(kinds.slice(0,2),['gift','mention'],'同一幕末：礼物先，点名后');
});

test('礼物：计票类礼物不排队，只记账',async()=>{
 const {runner,gifts}=make({n:4,gifts:true,giftDraft:async()=>'不该被调用'});
 await runner.start();
 const out=runner.gift({gift:'beer',count:3,name:'老王'});
 assert.equal(out.queued,false);
 assert.equal(out.reason,'neutral');
 assert.equal(gifts.size,0);
 assert.equal(gifts.stats.neutral,1);
});

test('跳幕：落到下一幕开头，跳过的那几句不再算空档',async()=>{
 // 第 1 幕是第 0~2 句、第 2 幕是第 3~5 句。推一步让第 0 句正在播，此时按跳幕，
 // 目标是第 2 幕开头（第 3 句）：第 1、2 句整句被跳过，正在说的第 0 句不追回。
 const {runner,engine,step,playOut}=make({n:6,actOf:i=>i<3?1:2});
 await runner.start();
 await step();
 const out=runner.skip();
 assert.equal(out.skipped,true);
 assert.equal(out.act,2);
 await playOut();
 const texts=engine.utterances.map(item=>item.text);
 // 推一步之后游标已经在第 1 句上（第 0 句说完，第 1 句刚开播）。
 assert.ok(texts.some(text=>text.includes('第1句')),'正在说的那句不追回');
 assert.ok(!texts.some(text=>text.includes('第2句')),'跳过的句子不该再出声');
 assert.ok(texts.some(text=>text.includes('第3句')),'跳过去之后要接着播');
 assert.equal(runner.stats.starved,0,'跳过的部分不是空档');
});

test('跳幕：最后一幕按下去就直接收尾',async()=>{
 const {runner,step,playOut}=make({n:4,actOf:i=>i<2?1:2});
 await runner.start();
 await step();
 await step();
 await step();                        // 已经进第 2 幕
 const out=runner.skip();
 assert.equal(out.skipped,true);
 assert.equal(out.to,runner.turns.length);
 await playOut();
 assert.equal(runner.active,false);
});

test('重写未播的幕：句子换掉、句数可以变、游标不动',async()=>{
 const {runner,engine,step,playOut}=make({n:4,actOf:i=>i<2?1:2});
 await runner.start();
 await step();
 const current=runner.turns[runner.cursor].id;
 const out=runner.replaceAct(2,[
  {side:'A',text:'重写后的第二幕第一句，这一句话足够长，长到能当一整条。——测试用'},
  {side:'B',text:'重写后的第二幕第二句，用来确认句数可以从两句变成三句。'},
  {side:'A',text:'重写后的第二幕第三句，收一下。'}
 ]);
 assert.equal(out.ok,true);
 assert.equal(out.count,3);
 assert.equal(runner.turns[runner.cursor].id,current,'游标还停在原来那一句上');
 assert.equal(runner.turns.filter(turn=>turn.act===2).length,3);
 await playOut();
 const texts=engine.utterances.map(item=>item.text).join('|');
 assert.ok(texts.includes('重写后的第二幕第一句'));
 assert.ok(!texts.includes('第3句'),'旧台词不能再播');
});

test('重写正在播的那一幕：拒绝，不能和画面打架',async()=>{
 const {runner,step}=make({n:4,actOf:i=>i<2?1:2});
 await runner.start();
 await step();
 const out=runner.replaceAct(1,[{side:'A',text:'想换掉正在说的这一幕'}]);
 assert.equal(out.ok,false);
 assert.equal(out.reason,'already-started');
});

test('弹幕墙：发一句就上一句，回了才有状态',async()=>{
 const {runner,step}=make({n:3});
 await runner.start();
 runner.comment({name:'老王',userId:'u1',text:'不是这都能吵起来'});
 assert.equal(runner.wall.length,1);
 // 一进来就进池了，所以立刻是「已听见」（细边）；被接上之后才变粗边。
 assert.equal(runner.wall[0].state,'heard');
 assert.equal(runner.wall[0].name,'老王');
 await step();
 await step();
 assert.equal(runner.wall[0].state,'replied','接上了就该变粗边');
 assert.ok(runner.wall[0].said.length>0,'墙上要能显示「他说的」对「谁接的」');
 assert.ok(runner.wall[0].pinnedAt>0,'钉住六秒靠这个时刻');
});

test('弹幕墙：配额满了也要上墙——他只发了这一句，不该什么都看不到',async()=>{
 const {runner}=make({n:3});
 await runner.start();
 // 同一句名字的弹幕连发 30 条，配额与节流都会拒，但墙必须全收。
 for(let i=0;i<30;i++)runner.comment({name:'刷屏的'+i,userId:'s'+i,text:'摸鱼这事我得说两句'+i});
 assert.equal(runner.wall.length,30);
 assert.ok(runner.wall.every(row=>row.state!=='replied'));
});

test('弹幕墙：气泡算已听见，不是已回应',async()=>{
 const {runner,step}=make({n:3,draft:()=>''});
 await runner.start();
 runner.comment({name:'老王',userId:'u1',text:'不是这都能吵起来'});
 await step();
 assert.equal(runner.wall[0].state,'heard','没出声只算被听见');
 assert.equal(runner.wall[0].pinnedAt,0);
 assert.equal(runner.receipts[0].kind,'bubble');
});

test('弹幕墙：最多留 40 条，再往前滚就没人看了',async()=>{
 const {runner}=make({n:3});
 await runner.start();
 for(let i=0;i<45;i++)runner.comment({name:'观众'+i,userId:'u'+i,text:'第'+i+'条'});
 assert.equal(runner.wall.length,40);
 assert.equal(runner.wall.at(-1).text,'第44条');
});
