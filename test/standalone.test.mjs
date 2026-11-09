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

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sample=()=>({topic:'加班应该如何安排',turns:[{side:'A',act:1,text:'先把工作目标讲清楚。',reaction:true},{side:'B',act:2,text:'也要考虑完成目标的代价。',reaction:true}]});
const teardown=new Map();
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'ai-bianlun-test-'));t.after(async()=>{await teardown.get(dir)?.();teardown.delete(dir);assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-bianlun-test-'));await rm(dir,{recursive:true,force:true});});return dir;}
async function until(check){const deadline=Date.now()+2000;while(!check()){assert.ok(Date.now()<deadline,'等待状态超时');await new Promise(resolve=>setTimeout(resolve,5));}}
async function runtime(t,options={}){const dataDir=await temporary(t);const app=await new DebateRuntime({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),edgeStatus:()=>({available:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:30000}),...options}).init();teardown.set(dataDir,()=>app.close());return app;}

test('长句按完整字数估时，不截断为 20 秒',()=>{assert.ok(estimateDuration('辩'.repeat(150))>30000);});
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
test('L0 社交回应无需模型即可命中，已接上运行时舞台',async t=>{
  const app=await runtime(t);app.startSingle({script:sample()});await until(()=>app.runner.active);
  app.runner.stage.hear({userId:'praise',name:'观众',text:'哈哈哈哈'});
  const hit=app.runner.stage.advance(Infinity).find(row=>row.kind==='reply');assert.ok(hit);assert.match(hit.layer,/L0/);assert.ok(hit.text.length>10);await app.stop();
});
test('投票期普通弹幕继续进入聊天，有效数字票只进票箱',async t=>{
  const calls=[];const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async messages=>{calls.push(messages);return '这个角度有意思，留到下一场好好说。';}}});
  app.cycle.vote.open({candidates:app.snapshot().topics.slice(0,4)});app.cycle.phase='vote';
  const vote=await app.receive({type:'comment',name:'观众一',userId:'vote',text:'1'});assert.equal(vote.vote.ok,true);assert.equal(calls.length,0);
  const chat=await app.receive({type:'comment',name:'观众二',userId:'chat',text:'今天状态怎么样'});assert.equal(chat.heard,true);await Promise.all([...app.jobs]);assert.equal(calls.length,1);
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
