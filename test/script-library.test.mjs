import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm,readFile,unlink} from 'node:fs/promises';
import {ScriptLibrary,pickLibraryScripts} from '../lib/script-library.mjs';
import {DebateRuntime} from '../lib/runtime.mjs';
import {ScriptWriter} from '../lib/script/writer.mjs';
import {createApplication} from '../lib/http-app.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),cleanup=new Map();
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'ai-library-test-'));t.after(async()=>{await cleanup.get(dir)?.();cleanup.delete(dir);assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-library-test-'));await rm(dir,{recursive:true,force:true});});return dir;}
const text='我们先把这件事实际发生时的条件讲清楚，再看对方提出的办法是否真的有用。';
function full(id='s1',topic='会议该怎么开'){
  return {id,topic,topicId:'meeting',meta:{ready:true},turns:Array.from({length:44},(_,i)=>({act:Math.floor(i/4)+1,side:i%2?'B':'A',text:text.repeat(6),reaction:true}))};
}
function short(id='short'){return {id,topic:'先把话聊清楚',meta:{ready:true},turns:[{act:1,side:'A',text:'那我们把条件先说清楚。'},{act:2,side:'B',text:'行，听你解释。'}]};}
async function until(check){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'等待超时');await new Promise(resolve=>setTimeout(resolve,5));}}
async function runtime(t,options={}){
  const dataDir=await temporary(t);
  const app=await new DebateRuntime({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),edgeStatus:()=>({available:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:1}),llm:{view:()=>({hasKey:true}),complete:async()=>{throw new Error('主线播放不应请求模型');}},...options}).init();
  cleanup.set(dataDir,()=>app.close());return app;
}
const row=(id,topic=id,other={})=>({id,topic,autoReady:true,playCount:0,lastPlayedAt:'',...other});

test('库存优先未播，再按次数和上次播放时间选；同题每轮最多一个版本',()=>{
  const rows=[row('old','旧题',{playCount:2,lastPlayedAt:'2026-01-01'}),row('new1','新题'),row('new2','新题'),row('once','一次',{playCount:1,lastPlayedAt:'2026-02-01'}),row('disabled','停用',{autoReady:false})];
  assert.deepEqual(pickLibraryScripts(rows).map(x=>x.id),['new1','once','old']);
  assert.deepEqual(pickLibraryScripts(rows,{used:['new1','once','old']}).map(x=>x.id),['new2']);
  assert.equal(pickLibraryScripts([row('one')],{used:['one']}).length,0);
  assert.equal(pickLibraryScripts([row('one')],{used:['one'],repeat:true}).length,1);
  assert.deepEqual(pickLibraryScripts([row('a'),row('b')],{currentId:'a',repeat:true}).map(x=>x.id),['b']);
});

test('播出次数、完成次数、轮播开关和异常中断跨重启保留',async t=>{
  const dir=await temporary(t),filename=path.join(dir,'library.json');let library=await new ScriptLibrary(filename).init();
  const event=await library.started({id:'a',topic:'题目'});await library.ended(event,'completed');await library.setEnabled('a',false);
  await library.started({id:'a',topic:'题目'});
  library=await new ScriptLibrary(filename).init();await library.recover();
  assert.equal(library.info('a').playCount,2);assert.equal(library.info('a').completedCount,1);assert.equal(library.info('a').enabled,false);
  assert.deepEqual(library.history.map(x=>x.status),['completed','interrupted']);
});

test('空库开播直接报错，单场与循环都不会偷偷写稿',async t=>{
  let writes=0;const app=await runtime(t);app.prepare=async()=>{writes++;throw new Error('意外写稿');};
  app.startSingle({topicId:'meeting'});await app.task;assert.match(app.operation.message,/没有可播剧本/);
  app.startCycle();await app.task;assert.match(app.operation.message,/没有可轮播/);assert.equal(writes,0);
});

test('轮播只收完整可用的长场；移出后保留原稿，短稿只支持单场',async t=>{
  const app=await runtime(t);await app.saveScript(full());await app.saveScript(short());await app.saveScript({...full('unready'),meta:{ready:false}});
  assert.equal(app.snapshot().library.available,1);const before=await app.loadScript('s1');
  await app.setScriptEnabled('s1',false);assert.equal(app.snapshot().library.available,0);assert.deepEqual(await app.loadScript('s1'),before);
  const out=await app.libraryEntry('short');assert.equal(out.ready,true);await assert.rejects(app.libraryEntry('short',{automatic:true}),/长场轮播/);
  await assert.rejects(app.libraryEntry('unready'),/未就绪/);
});

test('连续播放 15 份库存不重复；只有一份候选直接衔接，耗尽不投空票也不写稿',async t=>{
  const app=await runtime(t);for(let i=0;i<15;i++)await app.saveScript(full('s'+i,'辩题'+i));
  const played=[];app.play=async script=>{played.push(script.id);};app.announce=async()=>{};app.cycle.sleep=async()=>{};
  app.prepare=async()=>{throw new Error('意外写稿');};
  app.cycle.onPhase=event=>{if(event.phase==='vote')app.cycle.vote.lock({topicId:app.cycle.candidates[0].id});};
  app.startCycle();await app.task;
  assert.equal(played.length,15);assert.equal(new Set(played).size,15);assert.equal(app.cycle.stats.writes,0);assert.equal(app.cycle.stats.votes,13);assert.equal(app.operation.state,'idle');
});

test('开启复播后小库存能持续轮转，同题的多个版本都能上场',async t=>{
  const app=await runtime(t);await app.saveScript(full('v1'));await app.saveScript(full('v2'));
  const played=[];app.play=async script=>played.push(script.id);app.announce=async()=>{};app.cycle.sleep=async()=>{};
  app.startCycle({repeat:true,rounds:5});await app.task;
  assert.deepEqual(played,['v1','v2','v1','v2','v1']);assert.equal(app.cycle.stats.votes,0);
});

test('库文件临时丢失时换剩余库存，不回播本轮已用剧本',async t=>{
  const app=await runtime(t);for(const id of ['a','b','c'])await app.saveScript(full(id,id));
  const played=[];app.play=async script=>{played.push(script.id);if(script.id==='a')await unlink(path.join(app.dataDir,'scripts/b.json'));};app.announce=async()=>{};app.cycle.sleep=async()=>{};
  app.cycle.onPhase=event=>{if(event.phase==='vote')app.cycle.vote.lock({topicId:'b'});};
  app.startCycle({scriptId:'a'});await app.task;assert.deepEqual(played,['a','c']);assert.equal(app.cycle.stats.writes,0);
});

test('实际播出才计数，播完和中途停止有不同状态，空等配音不记次数',async t=>{
  const app=await runtime(t);await app.saveScript(short());app.runner.beat=async()=>{};app.runner.interludeSlot=async()=>{};
  app.startSingle({scriptId:'short'});await app.task;
  assert.equal(app.catalog.info('short').playCount,1);assert.equal(app.catalog.info('short').completedCount,1);assert.equal(app.catalog.history[0].status,'completed');
  let calls=0;app.renderVoice=undefined;app.voice.render=async()=>({url:'/audio/mock.mp3',durationMs:++calls===1?1:30000});
  app.startSingle({scriptId:'short'});await until(()=>app.catalog.info('short').playCount===2);await app.stop();
  assert.equal(app.catalog.info('short').completedCount,1);assert.equal(app.catalog.history.at(-1).status,'interrupted');
  app.voice.render=(_item,_settings)=>new Promise((resolve,reject)=>app.controller.signal.addEventListener('abort',()=>reject(new Error('取消')),{once:true}));
  app.startSingle({scriptId:'short'});await until(()=>app.runner.active);await app.stop();assert.equal(app.catalog.info('short').playCount,2);
});

test('批量按题份数生成，失败继续，已完成独立入库，禁止超量与非法参数',async t=>{
  const app=await runtime(t);let count=0;
  t.mock.method(ScriptWriter.prototype,'write',async function(){if(++count===2)throw new Error('模拟单份失败');return {...full(),topic:this.topic,sides:this.sides,meta:{}};});
  assert.throws(()=>app.generateBatch({topicIds:['meeting'],count:6}),/1～5/);assert.throws(()=>app.generateBatch({topicIds:app.snapshot().topics.slice(0,5).map(x=>x.id),count:5}),/20/);
  app.generateBatch({topicIds:['meeting','slack'],count:2});await app.task;
  assert.deepEqual([app.production.done,app.production.succeeded,app.production.failed],[4,3,1]);assert.equal(app.scripts.length,3);assert.equal(app.production.running,false);
  assert.equal(new Set(app.scripts.map(s=>s.id)).size,3);assert.equal(app.snapshot().library.available,3);
});

test('停止批量生成时保留已入库稿，不继续队列',async t=>{
  const app=await runtime(t);let count=0;
  t.mock.method(ScriptWriter.prototype,'write',async function(){if(++count===2)await new Promise((resolve,reject)=>app.controller.signal.addEventListener('abort',()=>reject(new Error('取消')),{once:true}));return {...full(),topic:this.topic,sides:this.sides,meta:{}};});
  app.generateBatch({topicIds:['meeting'],count:3});await until(()=>count===2);await app.stop();
  assert.equal(app.scripts.length,1);assert.equal(app.production.done,1);assert.equal(app.production.running,false);assert.equal(count,2);
});

test('整场配音预合成使用双方当前音色，不调用写稿模型',async t=>{
  const calls=[];const app=await runtime(t,{renderVoice:async(item,settings)=>{calls.push({item,settings});return {url:'/audio/mock.mp3',durationMs:1};}});
  await app.saveScript(short());app.preRender('short');await app.task;
  assert.equal(calls.length,2);assert.equal(calls[0].settings.voiceName,app.engine.config.voiceName);assert.equal(calls[1].settings.voiceName,app.engine.config.opponentVoice);assert.match(app.operation.message,/配音已缓存/);
});

test('新防护规则立即从自动候选中排除命中的库存，原文件保留',async t=>{
  const app=await runtime(t);await app.saveScript(full());await app.safety.configure({blockedTerms:['条件讲清楚']});await app.refreshScripts();
  assert.equal(app.snapshot().library.available,0);assert.equal(app.scripts[0].ready,false);assert.match(app.scripts[0].error,/屏蔽/);
  await assert.rejects(app.libraryEntry('s1'),/屏蔽/);assert.ok((await app.loadScript('s1')).turns.length);
});

test('HTTP 支持入库、开关、预合成，导出原稿不混入播出统计',async t=>{
  const dataDir=await temporary(t);const app=await createApplication({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:1})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));cleanup.set(dataDir,()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port,post=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const imported=await post('/api/script/import',{script:full()}).then(r=>r.json());assert.ok(imported.scriptId);
  let state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.library.available,1);assert.equal(state.cycle.source,'library');
  assert.equal((await post('/api/scripts/enabled',{scriptId:imported.scriptId,enabled:false})).status,200);
  state=await fetch(base+'/api/state').then(r=>r.json());assert.equal(state.library.available,0);
  assert.equal((await post('/api/scripts/generate-batch',{topicIds:[],count:1})).status,400);
  assert.equal((await post('/api/scripts/audio',{scriptId:imported.scriptId})).status,200);await app.runtime.task;
  const exported=await fetch(base+'/api/scripts/export?id='+imported.scriptId).then(r=>r.json());assert.equal(exported.playCount,undefined);assert.equal(exported.turns.length,44);
  const html=await readFile(path.join(root,'public/index.html'),'utf8');assert.match(html,/id="tab-library"/);assert.ok(!html.includes('生成并播放单场'));
});
