import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm,mkdir,readFile} from 'node:fs/promises';
import {DebateRuntime,validateScript} from '../lib/runtime.mjs';
import {createApplication} from '../lib/http-app.mjs';
import {DebateCycle} from '../lib/debate-cycle.mjs';
import {LLMClient} from '../lib/llm-client.mjs';
import {CloudVoice} from '../lib/cloud-voice.mjs';
import {estimateDuration} from '../lib/speech.mjs';
import {ScriptWriter} from '../lib/script/writer.mjs';
import {Douyin} from '../lib/douyin.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sample=()=>({topic:'加班应该如何安排',turns:[{side:'A',act:1,text:'先把工作目标讲清楚。',reaction:true},{side:'B',act:2,text:'也要考虑完成目标的代价。',reaction:true}]});
const teardown=new Map();
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'ai-bianlun-test-'));t.after(async()=>{await teardown.get(dir)?.();teardown.delete(dir);assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-bianlun-test-'));await rm(dir,{recursive:true,force:true});});return dir;}
async function until(check){const deadline=Date.now()+2000;while(!check()){assert.ok(Date.now()<deadline,'等待状态超时');await new Promise(resolve=>setTimeout(resolve,5));}}
async function runtime(t,options={}){const dataDir=await temporary(t);const app=await new DebateRuntime({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),edgeStatus:()=>({available:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:30000}),...options}).init();teardown.set(dataDir,()=>app.close());return app;}

test('长句按完整字数估时，不截断为 20 秒',()=>{assert.ok(estimateDuration('辩'.repeat(150))>30000);});
test('相爱相杀短样稿可通过播出检查，默认名和点名路由使用肉包',async t=>{
 const app=await runtime(t),demo=JSON.parse(await readFile(path.join(root,'public/demo.json'),'utf8'));
 const script=validateScript(demo,app.safety);assert.equal(script.turns.length,6);
 app.startSingle({script});await until(()=>app.runner.active);
 assert.equal(app.runner.side('A').name,'肉包');
 assert.match(app.runner.side('A').relationship,/肉包和鲸鱼娘是相爱相杀/);
 const mention=app.runner.comment({name:'观众',userId:'rename-test',text:'肉包你怎么看'});
 assert.equal(mention.routed,'mention');assert.equal(mention.item.personaId,'A');
 await app.stop();
});
test('准备剧本只创建一次人物状态，共用准备任务并保存同一状态',async t=>{
 const app=await runtime(t);let count=0,seenSides;
 const original=app.sides.bind(app);app.sides=topic=>{count++;return original(topic);};
 t.mock.method(ScriptWriter.prototype,'write',async function(){seenSides=this.sides;await new Promise(resolve=>setImmediate(resolve));return {...sample(),sides:this.sides,meta:{personaVersion:2}};});
 const topic=app.topic('slack');
 const [first,second]=await Promise.all([app.prepare(topic),app.prepare(topic)]);
 assert.equal(count,1);assert.equal(first,second);assert.deepEqual(first.script.sides,seenSides);
 const saved=await app.loadScript(first.script.id);
 assert.deepEqual(saved.sides,seenSides);assert.equal(saved.meta.personaVersion,2);
});
test('导入播放和互动沿用保存的人物，重写不重新抽取状态',async t=>{
 const calls=[];const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async messages=>{calls.push(messages);return '你说得对，这个条件我刚才没有认真想过。';}}});
 const sides=app.sides(app.topic('slack')).map(side=>({...side,scene:'本场虚构状态：想再听对方解释一次'}));
 const script=sample();script.sides=sides;
 const clean=validateScript(script,app.safety);
 for(let i=0;i<2;i++)for(const field of ['style','relationship','scene','backstory'])assert.equal(clean.sides[i][field],sides[i][field]);
 app.startSingle({script:clean});await until(()=>app.runner.active);
 for(let i=0;i<2;i++)for(const field of ['style','relationship','scene','backstory'])assert.equal(app.runner.sides[i][field],sides[i][field]);
 for(const kind of ['reaction','mention','gift'])await app.draft(kind,{name:'观众',text:'这里的条件要不要再想想',label:'墨镜',count:1},app.runner.turns[0],'A');
 for(const messages of calls){assert.ok(messages[0].content.includes(sides[0].scene));assert.ok(messages[0].content.includes(sides[0].relationship));}
 let rewrittenSides;
 t.mock.method(ScriptWriter.prototype,'write',async function(){rewrittenSides=this.sides;return {turns:[{side:'B',text:'这个条件我愿意重新想想。'}]};});
 const result=await app.rewrite(2);
 assert.equal(result.ok,true);assert.deepEqual(rewrittenSides,app.runner.sides);
 assert.equal(app.runner.turns.find(turn=>turn.act===2).text,'这个条件我愿意重新想想。');
 await app.stop();
});
test('导入只接受有效台词，清除音频、伪造时长和外部运行配置',()=>{
  const script=sample();Object.assign(script,{topicRef:{unsafe:true},sides:'wrong'});Object.assign(script.turns[0],{audio:'https://example.com/a.mp3',durationMs:1,estSec:9999});
  const clean=validateScript(script);assert.equal(clean.turns[0].audio,undefined);assert.equal(clean.turns[0].durationMs,undefined);assert.ok(clean.turns[0].estSec<10);assert.equal(clean.topicRef,undefined);assert.deepEqual(clean.sides,[]);
  assert.throws(()=>validateScript({...sample(),turns:[{side:'X',act:1,text:'错误'}]}));
  assert.throws(()=>validateScript({...sample(),turns:[{side:'A',act:2,text:'二'},{side:'B',act:1,text:'一'}]}));
});
test('单场/循环互斥，缺省双方音色不同，停止后可以重新开场',async t=>{
  const app=await runtime(t);app.startSingle({script:sample()});assert.throws(()=>app.startCycle(),/已有/);await until(()=>app.runner.active);
  assert.notEqual(app.runner.sideVoice('A'),app.runner.sideVoice('B'));assert.equal(app.snapshot().script.sides.length,2);
  await app.stop();assert.equal(app.runner.active,false);assert.equal(app.busy,false);assert.equal(app.engine.state.running,false);assert.equal(app.controller.signal.aborted,false);await app.voice.render({text:'停止后仍可试听'},{...app.engine.config});
  app.startSingle({script:sample()});await until(()=>app.runner.active);await app.stop();
});
test('运行失败释放场次状态，不会锁死工作台',async t=>{
  const app=await runtime(t);app.startSingle({topicId:'missing'});await app.task;
  assert.equal(app.operation.state,'error');assert.equal(app.busy,false);assert.equal(app.engine.state.running,false);assert.equal(app.cycle.running,false);
});
test('无模型时社交弹幕上墙，不循环播放三句固定人设台词',async t=>{
  const app=await runtime(t);app.startSingle({script:sample()});await until(()=>app.runner.active);
  app.runner.stage.hear({userId:'praise',name:'观众',text:'哈哈哈哈'});
  await new Promise(resolve=>setImmediate(resolve)); // 等无模型错误结算；待生成时会保留到后续句间
  const hits=app.runner.stage.advance(Infinity);assert.ok(hits.some(row=>row.kind==='bubble'));assert.equal(hits.some(row=>row.kind==='reply'),false);await app.stop();
});

test('正式开播入口：互动文字和配音在后台准备，齐备后才插入',async t=>{
 let finishAudio,audioCalls=0;
 const app=await runtime(t,{
  llm:{view:()=>({hasKey:true}),complete:async()=> '这个角度我愿意再想想。'},
  renderVoice:async item=>{
   if(item.interactive){audioCalls++;return new Promise(resolve=>{finishAudio=()=>resolve({url:'/audio/reply.mp3',durationMs:20});});}
   return {url:'/audio/main.mp3',durationMs:200};
  }
 });
 const script={topic:'工作怎么安排',turns:Array.from({length:5},(_,i)=>({act:1,side:i%2?'B':'A',text:'先把工作怎么安排说清楚。'}))};
 app.startSingle({script});await until(()=>app.engine.utterances.length===1);
 const result=app.runner.comment({userId:'u1',name:'观众',text:'这个条件能不能再想想'});
 assert.equal(result.ok,true);await until(()=>Boolean(finishAudio));
 await until(()=>app.engine.utterances.filter(item=>item.kind==='debate').length>=2);
 assert.equal(app.engine.utterances.some(item=>item.kind==='reaction'),false);
 assert.equal(app.runner.stage.router.repliedAt.has('u1'),false);
 finishAudio();await until(()=>app.engine.utterances.some(item=>item.kind==='reaction'));
 assert.equal(app.engine.utterances.find(item=>item.kind==='reaction').audio,'/audio/reply.mp3');
 assert.equal(audioCalls,1);await app.stop();
});
test('写好的临场回复不是已播记忆，已播历史会传给接话和重写，下一场重新开始',async t=>{
 const calls=[];const app=await runtime(t,{renderVoice:async item=>({url:'/audio/mock.mp3',durationMs:item.text===sample().turns[0].text?1:30000}),llm:{view:()=>({hasKey:true}),complete:async messages=>{calls.push(messages);return '行吧。';}}});
 const first=sample();first.turns.push({side:'A',act:3,text:'还没开始的收尾。'});
 app.startSingle({script:first});await until(()=>app.memory.entries.length===1);
 const history=app.memory.snapshot();assert.equal(history.history[0].text,sample().turns[0].text);
 assert.ok(!JSON.stringify(history).includes(sample().turns[1].text),'未说完的下一句不能提前进入记录');
 const text=await app.draft('reaction',{text:'哈哈哈哈',social:true},null,'A');assert.equal(text,'行吧。');
 assert.ok(calls[0][0].content.includes(sample().turns[0].text));assert.equal(app.memory.entries.length,1);
 let seed;
 t.mock.method(ScriptWriter.prototype,'write',async function(){seed=this.seedMemory.snapshot();return {turns:[{side:'A',text:'我记得刚才的话。'}]};});
 const rewritten=await app.rewrite(3);assert.equal(rewritten.ok,true);assert.deepEqual(seed,history);
 await app.stop();const second=sample();second.turns[0].text='另一场的开场。';
 app.startSingle({script:second});await until(()=>app.runner.active);assert.equal(app.memory.entries.length,0);await app.stop();
});
test('投票期普通弹幕继续进入聊天，有效数字票只进票箱',async t=>{
  const calls=[];const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async messages=>{calls.push(messages);return '这个角度有意思，留到下一场好好说。';}}});
  app.cycle.vote.open({candidates:app.snapshot().topics.slice(0,4)});app.cycle.phase='vote';
  const vote=await app.receive({type:'comment',name:'观众一',userId:'vote',text:'1'});assert.equal(vote.vote.ok,true);assert.equal(calls.length,0);
  const chat=await app.receive({type:'comment',name:'观众二',userId:'chat',text:'今天状态怎么样'});assert.equal(chat.heard,true);await Promise.all([...app.jobs]);assert.equal(calls.length,1);
});

test('场间点名使用对应角色和上一题已播记忆，配音完成后才发布',async t=>{
 let prompt,finishAudio;
 const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async messages=>{prompt=messages[0].content;return '刚才那句话我还没认输呢。';}},
  renderVoice:async(_item,settings)=>new Promise(resolve=>{finishAudio=()=>resolve({url:'/audio/chat.mp3',durationMs:1000});assert.equal(settings.voiceName,app.engine.config.opponentVoice);})});
 app.runner.attach({...sample(),sides:app.sides(null)});app.memory.remember({side:'A',text:'这次我可以少加一次班。',kind:'script'});
 app.cycle.vote.open({candidates:app.snapshot().topics.slice(0,2)});app.cycle.phase='vote';
 await app.receive({type:'comment',userId:'u1',name:'观众',text:'鲸鱼娘你还不服吗'});await until(()=>Boolean(finishAudio));
 assert.equal(app.engine.utterances.length,0);assert.ok(prompt.includes('这次我可以少加一次班'));assert.ok(prompt.includes(sample().topic));
 finishAudio();await Promise.all([...app.jobs]);
 assert.equal(app.engine.utterances.at(-1).speaker,'B');assert.equal(app.engine.utterances.at(-1).kind,'chat');assert.equal(app.engine.utterances.at(-1).audio,'/audio/chat.mp3');
});

test('锁票进入开场后，迟到的场间生成不会抢麦或进入下一题',async t=>{
 let finish;
 const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async()=>new Promise(resolve=>{finish=resolve;})}});
 app.cycle.vote.open({candidates:app.snapshot().topics.slice(0,2)});app.cycle.phase='vote';
 await app.receive({type:'comment',userId:'u1',text:'刚才还没说完呢'});await until(()=>Boolean(finish));
 app.cycle.setPhase('ready');finish('那我们继续说。');await Promise.all([...app.jobs]);
 assert.equal(app.engine.utterances.length,0);assert.equal(app.chatPending,0);
});

test('进入下一场会取消尚未完成的场间配音，释放合成队列',async t=>{
 let signal;
 const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async()=> '那句话我还记着呢。'},
  renderVoice:async(_item,_settings,options)=>{signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 app.cycle.vote.open({candidates:app.snapshot().topics.slice(0,2)});app.cycle.phase='vote';
 await app.receive({type:'comment',userId:'u1',text:'刚才那个条件怎么说'});await until(()=>Boolean(signal));
 app.cycle.setPhase('ready');await Promise.allSettled([...app.jobs]);
 assert.equal(signal.aborted,true);assert.equal(app.chatPending,0);assert.equal(app.jobs.size,0);assert.deepEqual(app.engine.utterances,[]);
});

test('阵营弹幕路由：重复去重、转投、暂停可加入，不进入接话模型或点名',async t=>{
  const calls=[];const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async m=>{calls.push(m);return '听见了。';}}});
  app.startSingle({script:sample()});await until(()=>app.runner.active);
  const receive=(text,id='1',userId='joiner')=>app.receive({type:'comment',text,id,userId,name:'同名观众',source:'douyin'});
  assert.equal((await receive('1')).camp.ok,true);
  assert.equal((await receive('2')).duplicate,true,'同一事件重传不改阵营');
  assert.equal((await receive('支持肉包','2')).camp.duplicate,true);
  assert.equal((await receive('2','3')).camp.changed,true);
  app.runner.pause();assert.equal((await receive('支持肉包','4','other')).camp.ok,true);
  assert.deepEqual(app.snapshot().camps.sides.map(side=>side.count),[1,1]);
  assert.equal(calls.length,0);assert.equal(app.runner.view().wall.length,0);
  assert.equal(app.engine.logs.filter(row=>row.type==='camp').length,3);
  const mention=await receive('肉包你怎么看','5','mention');assert.equal(mention.routed,'mention');
  await app.stop();assert.equal(app.snapshot().camps.state,'closed');assert.equal(app.snapshot().camps.total,2);
  assert.equal((await receive('1','6')).camp.reason,'closed');assert.equal(app.snapshot().camps.total,2);
  app.startSingle({script:sample()});await until(()=>app.runner.active);
  assert.equal(app.snapshot().camps.total,0);assert.equal((await receive('1','7')).camp.ok,true);
  await app.stop();
});
test('阵营安全检查、匿名拒绝以及选题数字票优先，礼物不增加阵营人数',async t=>{
  const app=await runtime(t);
  assert.equal((await app.receive({type:'comment',text:'支持肉包'})).camp.reason,'closed');
  app.startSingle({script:sample()});await until(()=>app.runner.active);
  assert.equal((await app.receive({type:'comment',text:'1'})).camp.reason,'anonymous');
  await app.safety.configure({blockedTerms:['支持肉包']});
  assert.equal((await app.receive({type:'comment',text:'支持肉包',userId:'blocked'})).blocked,true);
  await app.receive({type:'gift',gift:'sunglasses',label:'墨镜',count:1,userId:'gift',name:'礼物观众'});
  assert.equal(app.snapshot().camps.total,0);
  await app.receive({type:'comment',text:'2',userId:'joined',name:'观众'});
  await app.stop();
  app.cycle.phase='vote';app.cycle.vote.open({candidates:app.snapshot().topics.slice(0,4)});
  const vote=await app.receive({type:'comment',text:'1',userId:'vote',name:'选题观众'});
  assert.equal(vote.vote.ok,true);assert.equal(app.cycle.vote.total(),1);assert.equal(app.snapshot().camps.total,1);
  assert.equal((await app.receive({type:'comment',text:'加入鲸鱼娘阵营',userId:'late',name:'观众'})).camp.reason,'closed');
});
test('单场自然结束封存阵营，只记录一次结果',async t=>{
  const app=await runtime(t,{renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:1})});
  // End immediately after the real first spoken line; exercise the runner onEnd path.
  const spoken=app.runner.onSpoken;app.runner.onSpoken=(...args)=>{spoken(...args);app.camps.cast({userId:'1'},'A');app.runner.index=app.runner.turns.length;};
  app.startSingle({script:sample()});await app.task;
  assert.equal(app.snapshot().camps.state,'closed');assert.equal(app.snapshot().camps.total,1);
  assert.equal(app.engine.logs.filter(row=>row.title==='本场阵营支持').length,1);
});
test('正赛礼物增量计票独立于回嘴队列，封存后/场间不加票且不影响选题票',async t=>{
  const app=await runtime(t);app.startSingle({script:sample()});await until(()=>app.runner.active);app.runner.pause();
  const gift={type:'gift',source:'douyin',id:'score-1',gift:'candy',count:3,name:'送礼观众'};
  const first=await app.receive(gift);assert.equal(first.giftVote.points,9);assert.equal(first.queued,false);
  assert.equal((await app.receive(gift)).duplicate,true);
  await app.receive({...gift,id:'score-2',gift:'beer',count:2,triggerSkill:false});
  assert.deepEqual(app.snapshot().camps.sides.map(side=>side.votes),[9,6]);
  assert.equal((await app.receive({...gift,id:undefined})).giftVote.reason,'missing-id');
  assert.equal(app.snapshot().camps.totalVotes,15);assert.equal(app.snapshot().camps.total,0);
  await app.stop();
  app.cycle.phase='vote';app.cycle.vote.open({candidates:app.snapshot().topics.slice(0,4)});
  assert.equal((await app.receive({...gift,id:'late'})).giftVote.reason,'closed');
  assert.equal(app.cycle.vote.total(),0);assert.equal(app.snapshot().camps.totalVotes,15);
  app.cycle.phase='idle';app.startSingle({script:sample()});await until(()=>app.runner.active);
  assert.equal(app.snapshot().camps.totalVotes,0);await app.stop();
});
test('平台接入使用当前平台礼物映射并去重，旧保存映射升级后仍正确',async t=>{
  t.mock.method(Douyin.prototype,'check',async function(){this.state.dependency='ready';return true;});
  const app=await runtime(t,{platformEnabled:true});
  await app.platform.store.save({provider:'bilibili',profiles:{bilibili:{map:{sunglasses:['自定义回嘴']}}}});
  await app.platform.init();
  assert.deepEqual(app.platform.view().giftMap.candy,['辣条']);
  assert.deepEqual(app.platform.view().giftMap.sunglasses,['自定义回嘴']);
  app.startSingle({script:sample()});await until(()=>app.runner.active);app.runner.pause();
  const raw={id:'b1',type:'gift',userId:'u1',giftName:'辣条',repeatCount:2};
  await app.platform.ingest(raw);assert.equal(app.camps.view().totalVotes,6);
  assert.equal((await app.platform.ingest(raw)).duplicate,true);assert.equal(app.camps.view().totalVotes,6);
  await app.platform.configure({provider:'kuaishou'});
  await app.platform.ingest({...raw,id:'k1',giftName:'啤酒',repeatCount:1});
  assert.deepEqual(app.camps.view().sides.map(side=>side.votes),[6,3]);
  await app.stop();
});
test('停止等待中的语音任务会收到取消信号，不会发布迟到台词',async t=>{
  let signal;const app=await runtime(t,{renderVoice:(_item,_settings,options)=>{signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  app.startSingle({script:sample()});await until(()=>signal);await app.stop();assert.equal(signal.aborted,true);assert.deepEqual(app.engine.utterances,[]);assert.equal(app.jobs.size,0);assert.equal(app.runner.active,false);
});
test('手动锁票能离开投票阶段',async()=>{
  const candidates=[{id:'a',topic:'甲'},{id:'b',topic:'乙'}];let cycle;
  cycle=new DebateCycle({bank:candidates,prepare:async()=>({ready:true,script:{}}),play:async()=>{},sleep:async()=>{throw new Error('手动锁票后不应继续等待');},onPhase:event=>{if(event.phase==='vote')cycle.vote.lock({topicId:'a'});}});
  cycle.running=true;cycle.candidates=candidates;const winner=await cycle.voteStage();assert.equal(winner.topicId,'a');cycle.stop();
});
test('小题库连续 12 场可轮转，退出后 running 复位',async()=>{
  let clock=100000,played=0;const bank=Array.from({length:8},(_,i)=>({id:String(i),topic:'题目'+i}));
  const cycle=new DebateCycle({bank,now:()=>clock,sleep:async ms=>{clock+=ms;},prepare:async()=>({ready:true,script:{}}),play:async()=>{played++;},limits:{resultMs:1,readyMs:1,prewarmDelayMs:1,voteMinMs:1,voteMaxMs:2,tickMs:1,tieExtraMs:1}});
  await cycle.run({rounds:12});assert.equal(played,12);assert.equal(cycle.running,false);assert.equal(cycle.phase,'idle');
});
test('空题库异常也清理 running',async()=>{const cycle=new DebateCycle({prepare:async()=>{},play:async()=>{}});await assert.rejects(cycle.run(),/题库是空/);assert.equal(cycle.running,false);});
test('全局模型请求最多两个并发，队列任务可取消',async t=>{
  const dir=await temporary(t),releases=[];let active=0,max=0;
  const client=new LLMClient({dataDir:dir,fetcher:async()=>{active++;max=Math.max(max,active);await new Promise(resolve=>releases.push(resolve));active--;return {ok:true,json:async()=>({choices:[{message:{content:'完成'}}]})};}});
  client.config={baseUrl:'https://example.com/v1',model:'test',apiKey:'secret-never-exposed'};
  const abort=new AbortController(),pending=Array.from({length:6},(_,i)=>client.complete([],{signal:i===5?abort.signal:undefined}));
  const cancelled=assert.rejects(pending[5]);abort.abort();await cancelled;assert.equal(client.view().apiKey,undefined);
  for(let i=0;i<5;i++){await until(()=>releases.length);releases.shift()();}await Promise.all(pending.slice(0,5));assert.equal(max,2);assert.equal(client.active,0);assert.equal(client.waiters.length,0);
});
test('推理耗尽输出预算时只重试一次，不把截断台词当完整结果',async t=>{
 const dataDir=await temporary(t),budgets=[];let count=0;
 const client=new LLMClient({dataDir,fetcher:async(_url,options)=>{
  budgets.push(JSON.parse(options.body).max_tokens);count++;
  return {ok:true,json:async()=>({usage:{completion_tokens_details:{reasoning_tokens:390}},choices:[{finish_reason:count===1?'length':'stop',message:{content:count===1?'[{"side":"A","text":"没写完':'行吧。'}}]})};
 }});client.config={baseUrl:'https://example.com/v1',apiKey:'test',model:'reasoning-test'};
 assert.equal(await client.complete([],{maxTokens:400}),'行吧。');assert.equal(count,2);assert.ok(budgets[1]>budgets[0]);
 await client.complete([],{maxTokens:400});assert.ok(budgets[2]>400,'后续请求给已识别的推理模型预留空间');
 count=0;client.fetcher=async()=>{count++;return {ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'没说完'}}]})};};
 await assert.rejects(client.complete([]),/被截断/);assert.equal(count,2);
});
test('云端语音要求双方配置不同音色，排队合成响应取消',async t=>{
  const dataDir=await temporary(t);await mkdir(path.join(dataDir,'audio'));let started;
  const voice=new CloudVoice({dataDir,audioDir:path.join(dataDir,'audio'),edgeStatus:()=>({available:true}),edgeSpeech:(_payload,{signal})=>{started=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await assert.rejects(voice.configure({provider:'volcengine',apiKey:'secret',opponentSpeaker:''}),/不同/);
  const controller=new AbortController(),options={signal:controller.signal};const first=voice.render({text:'第一句'},{voiceName:'A'},options),second=voice.render({text:'第二句'},{voiceName:'B'},options);
  const checks=Promise.all([assert.rejects(first),assert.rejects(second)]);await until(()=>started);controller.abort();await checks;
});
test('HTTP 只开放长场接口，配置不泄露密钥，静态资源与模型引用完整',async t=>{
  const dataDir=await temporary(t),app=await createApplication({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:5})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));teardown.set(dataDir,()=>app.close());const base='http://127.0.0.1:'+app.server.address().port;
  const post=(url,payload)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const health=await fetch(base+'/api/health').then(r=>r.json());assert.equal(health.mode,'long-form');
  for(const url of ['/api/debate/start','/api/broadcast-mode','/api/lounge/start','/api/command','/api/song'])assert.equal((await post(url,{})).status,404);
  assert.equal((await post('/api/llm/settings',{model:'test',apiKey:'private-test-key'})).status,200);
  const state=await fetch(base+'/api/state').then(r=>r.json());assert.ok(state.script);assert.equal(state.debate,undefined);assert.ok(!JSON.stringify(state).includes('private-test-key'));
  assert.equal((await post('/api/script/start',{script:sample()})).status,200);assert.equal((await post('/api/cycle/start',{})).status,400);assert.equal((await post('/api/script/stop',{})).status,200);
  for(const file of ['index.html','studio.js','studio.css','base.css','api.js','scene.html','scene.js','scene.css','speaker.js','demo.json','avatar/renderer-live2d.js','avatar/live2d/vendor.js'])assert.equal((await fetch(base+'/'+file)).status,200,file);
  for(const file of ['doubao/2.0.model3.json','ds-whale-girl/c_0120.model3.json']){
    const manifest=JSON.parse(await readFile(path.join(root,'public/avatar/live2d',file),'utf8')),refs=manifest.FileReferences;
    const files=[refs.Moc,refs.Physics,refs.DisplayInfo,...refs.Textures,...(refs.Expressions||[]).map(x=>x.File),...Object.values(refs.Motions||{}).flat().map(x=>x.File)].filter(Boolean);
    for(const resource of files)await readFile(path.resolve(root,'public/avatar/live2d',path.dirname(file),resource));
  }
});
