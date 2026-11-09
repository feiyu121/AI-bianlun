// 反应位旁挂：用虚拟时钟把「剧本时间轴 + 弹幕池 + 三层路由」跑一遍，不碰音频。
// 重点验四件事：连填不超限、跨幕不复用、暂停不补播、播不出来时降级不重复念同一句。
import test from 'node:test';
import assert from 'node:assert/strict';
import {ReactionStage,STAGE_LIMITS} from '../lib/script/stage.mjs';
import {ReactionRouter} from '../lib/script/reactions.mjs';

const SCRIPT_SEC=27;
const BASE=1_000_000_000;

// 假库：pick(id) 依次吐句子，用尽返回 null（走气泡）。
function fakeLibrary(map={A:['库里的A句'],B:['库里的B句']}){
 const at={};
 return {pick(id){const list=map[id]||[];const n=at[id]??0;at[id]=n+1;return list[n]??null;}};
}

function scriptOf(n,{actOf=()=>1,side=i=>i%2?'B':'A',reaction=true,estSec=SCRIPT_SEC,keywords=['摸鱼']}={}){
 const turns=[];
 for(let i=0;i<n;i++)turns.push({id:'t'+String(i).padStart(3,'0'),act:actOf(i),side:side(i),estSec,
  keywords,reaction:typeof reaction==='function'?reaction(i):reaction});
 return {turns};
}

function fixture({n=8,library=fakeLibrary(),genMs=()=>1000,draft=item=>'这题我不让，'+item.text.slice(0,4),...rest}={}){
 const box={clock:BASE};
 const stage=new ReactionStage({now:()=>box.clock,library,genMs,draft,...rest});
 stage.attach(scriptOf(n,rest));
 return {stage,box};
}

const comment=(i,text='不是这都能吵起来')=>({userId:'u'+i,name:'观众'+i,text});

test('时间轴：每句按 estSec 排，末句 endMs 是剧本总长',()=>{
 const {stage}=fixture({n:3});
 assert.equal(stage.timeline[0].startMs,0);
 assert.equal(stage.timeline[0].endMs,27000);
 assert.equal(stage.timeline[2].endMs,81000);
 assert.equal(stage.scriptMs,81000);
});

test('advance 只处理到点的位置，没到的一句都不碰',()=>{
 const {stage,box}=fixture({n:3});
 stage.hear(comment(1));
 assert.equal(stage.advance(BASE+26000).length,0);
 assert.equal(stage.cursor,0);
 const first=stage.advance(BASE+27000);
 assert.equal(first.length,1);
 assert.equal(first[0].kind,'reply');
 assert.equal(stage.cursor,1);
});

test('连填不超限：连回 2 次后第 3 格强制空，空过再恢复',()=>{
 const {stage,box}=fixture({n:8});
 for(let i=0;i<6;i++)stage.hear(comment(i,'摸鱼这事我得说两句'+i));
 const out=stage.advance(Infinity);
 const kinds=out.map(x=>x.kind);
 assert.deepEqual(kinds.slice(0,6),['reply','reply','skip','reply','reply','skip']);
 const longest=kinds.join(',').match(/reply(,reply)*/g);
 assert.equal(Math.max(...longest.map(s=>s.split(',').length)),2,'结构上不可能连三段');
});

test('reaction:false 的位置不设槽：冷开场与结辩幕整段静默',()=>{
 const {stage}=fixture({n:4,reaction:i=>i!==1});
 for(let i=0;i<4;i++)stage.hear(comment(i,'摸鱼这事我得说两句'+i));
 const out=stage.advance(Infinity);
 const skippedAt=BASE+stage.timeline[1].endMs;
 assert.equal(out.some(x=>x.at===skippedAt),false,'这一格根本没有产出');
 assert.equal(stage.stats.slots,3);
});

test('跨幕作废：上一幕没被选中的弹幕不会在下一幕开口',()=>{
 const {stage}=fixture({n:2,actOf:i=>i===0?1:2});
 stage.hear(comment(1,'这是第一幕的话'));
 stage.hear(comment(2,'也是第一幕的话'));
 const out=stage.advance(Infinity);
 const act1=out.filter(x=>x.act===1);
 const act2=out.filter(x=>x.act===2);
 assert.equal(act1.filter(x=>x.kind==='reply').length,1);
 assert.equal(act2.filter(x=>x.kind==='reply').length,0,'第二幕只剩空的池子');
 assert.equal(stage.router.stats.expired,1);
});

test('L1 命中：弹幕早进池，到点时早就写好了',()=>{
 const {stage}=fixture({n:1,genMs:()=>1000});
 stage.hear(comment(1,'你们老板同意吗'));
 const [hit]=stage.advance(BASE+27000);
 assert.equal(hit.layer,'L1');
 assert.equal(hit.text,'这题我不让，你们老板');
 assert.equal(hit.latencyMs,1000);
});

test('赶不上就降 L0：位置前 3 秒才来的弹幕，现场生成必然来不及',()=>{
 const {stage,box}=fixture({n:1,genMs:()=>30000,library:fakeLibrary({A:['预渲染的兜底句'],B:[]})});
 box.clock=BASE+25000;                 // 位置在 27000，只剩 2 秒
 stage.hear(comment(1,'你们是不是收钱了'));
 const [hit]=stage.advance(BASE+27000);
 assert.equal(hit.layer,'L0-degrade');
 assert.equal(hit.text,'预渲染的兜底句');
 assert.equal(stage.stats.lapsed,1);
 assert.equal(stage.stats.degraded,1);
});

test('库也空了就走气泡，且这一条当场作废——不能下一格再念一遍',()=>{
 const {stage}=fixture({n:4,genMs:()=>90000,library:fakeLibrary({A:[],B:[]})});
 stage.hear(comment(1,'你们是不是收钱了'));
 const out=stage.advance(Infinity).filter(x=>x.kind==='bubble');
 assert.equal(out.length,1);
 assert.equal(stage.stats.bubble,1);
 assert.equal(stage.router.pool.size,0,'作废后不回池');
 assert.equal(stage.router.stats.dropped,1);
 const replies=stage.advance(Infinity);
 assert.equal(replies.length,0);
});

test('生成抛错不往上冒：当成没写出来，直接降级',()=>{
 const {stage}=fixture({n:1,genMs:()=>1000,draft:()=>{throw new Error('模型 502')},library:fakeLibrary({A:['兜底这一句'],B:[]})});
 stage.hear(comment(1,'摸鱼就是偷时间'));
 const [hit]=stage.advance(BASE+27000);
 assert.equal(hit.layer,'L0-degrade');
 assert.equal(hit.text,'兜底这一句');
});

test('接话时间只加不减：接几条就把整场拉长几个 3.5 秒',()=>{
 const {stage}=fixture({n:5});
 for(let i=0;i<5;i++)stage.hear(comment(i,'摸鱼这事我得说两句'+i));
 const out=stage.advance(Infinity);
 // 5 条弹幕只播 4 条——连填上限（2 接 1 空）在这里就生效了，时间账按实际播出算。
 const replies=out.filter(x=>x.kind==='reply'||x.kind==='ambient').length;
 assert.equal(replies,4);
 assert.equal(stage.slipMs,4*STAGE_LIMITS.replyMs);
 assert.equal(stage.snapshot().playedMs,5*27000+14000);
 assert.equal(stage.timeline[4].endMs,135000,'剧本自己的时间轴不被改写');
});

test('暂停：弹幕只上墙，不补播；恢复时清池并整条轴后移',()=>{
 const {stage,box}=fixture({n:4});
 stage.hear(comment(1,'暂停前还没轮到的那条'));
 const before=stage.cursor;
 stage.pause();
 box.clock+=60000;                      // 场控暂停一分钟
 assert.equal(stage.hear(comment(9,'暂停期间刷的')).reason,'paused');
 assert.equal(stage.hear(comment(10,'再刷一条')).reason,'paused');
 assert.equal(stage.advance(Infinity).length,0,'暂停时不推进游标');
 assert.equal(stage.cursor,before);
 const resume=stage.resume();
 assert.equal(resume.flushed,1,'暂停前没来得及说的那条也倒掉');
 assert.equal(resume.pausedMs,60000);
 assert.equal(stage.holdMs,60000);
 const after=stage.advance(Infinity);
 assert.ok(after.every(x=>x.at>=BASE+27000+60000),'恢复后第一格要等这一分钟补回来');
 assert.equal(stage.stats.wall,2,'暂停期间的上墙单独计数');
});

test('换场 reset 保留审计数字，便于对比两场',()=>{
 const {stage}=fixture({n:3});
 for(let i=0;i<3;i++)stage.hear(comment(i,'摸鱼这事我得说两句'+i));
 stage.advance(Infinity);
 const replied=stage.stats.replied;
 stage.router.reset();
 assert.equal(stage.router.snapshot().stats.replied,replied);
 assert.equal(stage.router.pool.size,0);
});

test('生成慢过 12 秒就不要了：迟到的回复等于答非所问',()=>{
 const {stage}=fixture({n:1,genMs:()=>20000,library:fakeLibrary({A:['库里的兜底句'],B:[]})});
 stage.hear(comment(1,'你们老板同意吗'));
 const [hit]=stage.advance(BASE+27000);
 assert.equal(hit.layer,'L0-degrade','赶不上的不排队，直接给现成的');
 assert.equal(stage.stats.slow,1,'慢到超线的要单独记账，否则看不出模型在排队');
});

test('跨幕生成作废：写在第 2 幕、播在第 3 幕，不能用',()=>{
 const {stage}=fixture({n:1});
 stage.attach({turns:[{id:'t0',act:2,side:'A',estSec:27},{id:'t1',act:3,side:'A',estSec:27}]});
 const item={userId:'u1',name:'甲',text:'你们老板同意吗',social:false};
 stage.schedule(item,{act:2,side:'A'});
 const route=stage.route(item,{act:3,side:'A'},stage.startedAt+60000);
 assert.equal(route.layer,'L0-degrade');
 assert.equal(stage.stats.stale,1);
});

test('begin：零点钉在开播那一刻，预热花掉的时间不算进时间轴',()=>{
 const {stage,box}=fixture({n:2});
 // attach 之后预热了一分钟才真的开播：如果零点留在 attach，第一格一开播就「早就到点」。
 box.clock=BASE+60000;
 stage.begin(box.clock);
 stage.hear(comment(1,'摸鱼这事我得说两句'));
 assert.equal(stage.advance(box.clock+1000).length,0,'开播一秒后还没有任何一格到点');
 const out=stage.advance(box.clock+27000);
 assert.equal(out.length,1);
 assert.equal(out[0].kind,'reply');
});

test('retime：真实音频比估算长 5 秒，后面的句子整体后移',()=>{
 const {stage}=fixture({n:3});
 const before=stage.timeline[2].endMs;
 const delta=stage.retime(0,27000+5000);
 assert.equal(delta,5000);
 assert.equal(stage.timeline[0].endMs,32000);
 assert.equal(stage.timeline[1].startMs,32000);
 assert.equal(stage.timeline[2].endMs,before+5000);
 assert.equal(stage.scriptMs,before+5000,'剧本总长跟着变，进度条才不会走到 100% 还在播');
});

test('settle：接话实际只花 1 秒，就别往时间轴上记 3.5 秒',()=>{
 const {stage}=fixture({n:3});
 stage.hear(comment(1,'摸鱼这事我得说两句'));
 stage.advance(BASE+27000);
 assert.equal(stage.slipMs,STAGE_LIMITS.replyMs);
 // 真实只用了 1 秒，把多记的 2.5 秒退回去，否则下一格会被判「还没到」而白白跳过。
 assert.equal(stage.settle(1000),1000-STAGE_LIMITS.replyMs);
 assert.equal(stage.slipMs,1000);
});

test('overrun：落后两格时一次只接一句，多出来的格子作废但不扣配额',()=>{
 const {stage}=fixture({n:5});
 for(let i=0;i<5;i++)stage.hear(comment(i,'摸鱼这事我得说两句'+i));
 const out=stage.advance(Infinity,{max:1});
 assert.equal(out.filter(x=>x.kind==='reply').length,1,'一次只接一句');
 assert.equal(out.filter(x=>x.reason==='overrun').length,4,'剩下的到点位直接作废');
 assert.equal(stage.stats.overrun,4);
 assert.equal(stage.router.stats.replied,1,'作废的格子没扣任何人配额');
 assert.equal(stage.router.pool.size,4,'人还在池里等下一格');
});

test('异步写手：写好之后才判命中，慢过 12 秒判废',async()=>{
 const box={clock:BASE};
 let resolve=null;
 const stage=new ReactionStage({
  now:()=>box.clock,
  genMs:()=>1000,
  draft:()=>new Promise(done=>{resolve=done;})
 });
 stage.attach(scriptOf(2));
 stage.hear(comment(1,'你们老板同意吗'));
 // 还没写好：位置到了也只能降级（气泡），不能拿半句空话去播。
 assert.equal(stage.advance(BASE+27000)[0].kind,'bubble');
 // 同一个人的第二条重来一次：这次按时写好。
 box.clock=BASE+28000;
 stage.hear(comment(2,'你们老板同意吗'));
 resolve('这题我不让，老板同不同意都得说');
 await Promise.resolve();
 const out=stage.advance(BASE+54000);
 assert.equal(out[0].layer,'L1');
 assert.equal(out[0].text,'这题我不让，老板同不同意都得说');
});

test('seek：跳幕把零点重新钉在现在，不会一次补播一串接话',()=>{
 const {stage,box}=fixture({n:6});
 for(let i=0;i<6;i++)stage.hear(comment(i,'摸鱼这事我得说两句'+i));
 // 跳到第 4 格：前 3 格的时间早就过去了，如果不重建零点，
 // 下一次 advance 会把它们判成「到点」并一次性全部投放。
 box.clock=BASE+10_000;
 assert.equal(stage.seek(3),3);
 assert.equal(stage.advance(box.clock).length,0,'跳过去之后没有立刻要播的东西');
 const out=stage.advance(box.clock+stage.timeline[3].endMs-stage.timeline[3].startMs+1000);
 assert.equal(out.length,1);
 assert.equal(out[0].act,stage.timeline[3].act);
});

test('rebuild：重写某一幕后按 turn id 找回位置',()=>{
 const {stage,box}=fixture({n:4});
 const id=stage.timeline[2].turnId;
 // 第 2 幕从 2 句变 4 句：下标全变了，按 id 才能回到原来那句。
 const turns=[
  {id:'x1',act:1,side:'A',text:'第一幕第一句',estSec:10},
  {id:'x2',act:1,side:'B',text:'第一幕第二句',estSec:10},
  {id:id,act:2,side:'A',text:'重写之后的第一句',estSec:10},
  {id:'x4',act:2,side:'B',text:'重写之后的第二句',estSec:10},
  {id:'x5',act:2,side:'A',text:'重写之后的第三句',estSec:10},
  {id:'x6',act:2,side:'B',text:'重写之后的第四句',estSec:10}
 ];
 box.clock=BASE+30_000;
 const index=stage.rebuild(turns,{turnId:id});
 assert.equal(index,2);
 assert.equal(stage.timeline.length,6);
 assert.equal(stage.timeline[index].turnId,id);
 assert.equal(stage.cursor,2);
});
