import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm,readFile,unlink} from 'node:fs/promises';
import {ScriptLibrary,pickLibraryScripts} from '../lib/script-library.mjs';
import {DebateRuntime,customTopic} from '../lib/runtime.mjs';
import {ScriptWriter} from '../lib/script/writer.mjs';
import {createApplication} from '../lib/http-app.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),cleanup=new Map();
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'ai-library-test-'));t.after(async()=>{await cleanup.get(dir)?.();cleanup.delete(dir);assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-library-test-'));await rm(dir,{recursive:true,force:true});});return dir;}
const text='我们先把这件事实际发生时的条件讲清楚，再看对方提出的办法是否真的有用。';
function full(id='s1',topic='会议该怎么开'){
  return {id,topic,topicId:'meeting',meta:{ready:true},turns:Array.from({length:25},(_,i)=>({act:Math.floor(i/5)+1,side:i%2?'B':'A',text:text.repeat(2),reaction:true}))};
}
function short(id='short'){return {id,topic:'先把话聊清楚',meta:{ready:true},turns:[{act:1,side:'A',text:'那我们把条件先说清楚。'},{act:2,side:'B',text:'行，听你解释。'}]};}
async function until(check){const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline,'等待超时');await new Promise(resolve=>setTimeout(resolve,5));}}
async function runtime(t,options={}){
  const dataDir=await temporary(t);
  const app=await new DebateRuntime({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),edgeStatus:()=>({available:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:1}),llm:{view:()=>({hasKey:true}),complete:async()=>{throw new Error('主线播放不应请求模型');}},...options}).init();
  cleanup.set(dataDir,()=>app.close());return app;
}
const row=(id,topic=id,other={})=>({id,topic,autoReady:true,playCount:0,lastPlayedAt:'',...other});

test('旧长稿保留可手动播，默认轮播排除，原文和导出不截断',async t=>{
 const app=await runtime(t),long=full('old-long');long.turns=long.turns.map(row=>({...row,text:row.text.repeat(3)}));
 await app.saveScript(long);
 assert.equal(app.scripts[0].ready,true);assert.equal(app.scripts[0].autoReady,false);
 assert.deepEqual((await app.loadScript(long.id)).turns,long.turns);
 assert.equal((await app.libraryEntry(long.id)).ready,true);
 await assert.rejects(app.libraryEntry(long.id,{automatic:true}),/短场轮播/);
});

test('运行时实时发布模型等待、分幕统计、检查入库和配音进度，完成后结束计时',async t=>{
  let release;const app=await runtime(t,{llm:{view:()=>({hasKey:true,active:1,queued:0}),complete:async()=>new Promise(resolve=>{release=resolve;})}});
  t.mock.method(ScriptWriter.prototype,'write',async function(){
    this.report('正在写第 1/5 幕',{phase:'act',act:1});await this.complete([]);
    this.report('已处理 11/5 幕',{phase:'act',completedActs:5,totalActs:5,turns:25,chars:2000,estTotalSec:420});return {...full(),topic:this.topic,sides:this.sides,meta:{}};
  });
  app.generateBatch({customTopics:['周末应该怎么过']});await until(()=>app.snapshot().generation.requestPending);
  const waiting=app.snapshot().generation;assert.equal(waiting.state,'running');assert.equal(waiting.phase,'act');assert.ok(waiting.requestAt>0);assert.ok(app.engine.logs.some(row=>row.type==='generation'&&row.detail.includes('第 1/5 幕')));
  release('模型已返回');await app.task;
  const done=app.snapshot().generation;assert.equal(done.state,'completed');assert.equal(done.phase,'ready');assert.equal(done.requestPending,false);assert.equal(done.completedActs,5);assert.equal(done.turns,25);assert.equal(done.audioDone,6);assert.ok(done.finishedAt>=done.startedAt);
  assert.equal(waiting.requestPending,true,'之前拿到的快照不会随完成状态改变');
  for(const phrase of ['正在检查剧本','正在保存','起播配音已预热 6/6','剧本已就绪'])assert.ok(app.engine.logs.some(row=>row.detail.includes(phrase)),phrase);
});

test('互动记录接收、生成成功和失败原因，模型超时不再静默',async t=>{
 let options,fail=false;
 const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:async(_messages,o)=>{options=o;if(fail)throw new Error('模型接口超时');return '在呢，你刚才在说什么？';}}});
 app.runner.attach(short());app.runner.active=true;
 const result=await app.receive({type:'comment',userId:'viewer',name:'观众',text:'你好'});
 assert.equal(result.ok,true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(options.timeoutMs,25000);
 assert.ok(app.engine.logs.some(row=>row.type==='interaction'&&row.detail.includes('收到弹幕：你好')));
 assert.ok(app.engine.logs.some(row=>row.detail.includes('弹幕接话已生成')));
 fail=true;
 assert.equal(await app.draft('reaction',{text:'你在聊什么'},null,'A'),'');
 assert.ok(app.engine.logs.some(row=>row.detail.includes('弹幕接话失败：模型接口超时')));
 app.runner.active=false;
});

test('写稿中停止与未达开播门槛分别显示取消和失败，不误报已就绪',async t=>{
  const app=await runtime(t,{llm:{view:()=>({hasKey:true}),complete:(_m,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}});
  t.mock.method(ScriptWriter.prototype,'write',async function(){await this.complete([]);return {...full(),topic:this.topic,sides:this.sides,meta:{}};});
  app.generateBatch({customTopics:['周末应该怎么过']});await until(()=>app.generation.requestPending);await app.stop();
  assert.equal(app.generation.state,'cancelled');assert.equal(app.generation.requestPending,false);assert.ok(app.generation.finishedAt);assert.equal(app.scripts.length,0);
  t.mock.method(ScriptWriter.prototype,'write',async function(){return {...short(),topic:this.topic,sides:this.sides,meta:{}};});
  app.generateBatch({customTopics:['周末应该怎么过']});await app.task;
  assert.equal(app.generation.state,'error');assert.equal(app.generation.phase,'not-ready');assert.equal(app.production.failed,1);assert.equal(app.scripts.length,1);assert.equal(app.scripts[0].ready,false);
});

test('自定义题目使用稳定编号，清理多余空格并拒绝非法输入',()=>{
  assert.equal(customTopic('  一个人  住好不好？ ').id,customTopic('一个人 住好不好?').id);
  assert.equal(customTopic('  一个人  住好不好？ ').topic,'一个人 住好不好？');
  assert.match(customTopic('../自定义话题').id,/^custom-[a-f0-9]{16}$/);
  for(const value of ['',null,123,'题'.repeat(101),'第一题\n第二题'])assert.throws(()=>customTopic(value),/辩题/);
});

test('自定义和推荐辩题可混合，按题名去重，空列表和超量提前拒绝',async t=>{
  const app=await runtime(t),preset=app.topic('slack');
  const topics=app.generationTopics({topicIds:['slack','slack'],customTopics:[preset.topic,'朋友借钱该不该收利息',' 朋友借钱该不该收利息 ' ]});
  assert.equal(topics.length,2);assert.equal(topics[0].id,'slack');assert.match(topics[1].id,/^custom-/);
  assert.throws(()=>app.generateBatch(),/请选择辩题或填写/);assert.throws(()=>app.generateBatch({customTopics:'不合法'}),/格式无效/);
  assert.throws(()=>app.generateBatch({customTopics:Array.from({length:11},(_,i)=>'自定义问题'+i),count:2}),/20/);
  await app.safety.configure({blockedTerms:['自定测试词']});assert.throws(()=>app.generateBatch({customTopics:['自定测试词']}),/屏蔽/);
  await app.safety.configure({enabled:false});assert.equal(app.generationTopics({customTopics:['自定测试词']}).length,1);
});

test('只填自定义题也能批量生成入库，人物不绑定推荐题库立场，播放和选题沿用原题',async t=>{
  const app=await runtime(t,{renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:30000})}),seen=[];
  t.mock.method(ScriptWriter.prototype,'write',async function(){seen.push({topic:this.topic,sides:this.sides});return {...full(),topic:this.topic,sides:this.sides,meta:{}};});
  app.generateBatch({customTopics:['情侣之间该不该查看手机','游戏输了到底该怪谁'],count:2});await app.task;
  assert.equal(app.production.succeeded,4);assert.equal(app.snapshot().library.available,4);
  for(const item of seen)for(const side of item.sides){assert.equal(side.stance,'');assert.deepEqual(side.points,[]);}
  const selected=app.scripts.find(row=>row.topic==='游戏输了到底该怪谁'),saved=await app.loadScript(selected.id);
  assert.match(saved.topicId,/^custom-/);assert.equal(app.topic(saved.topicId).topic,saved.topic);
  app.startSingle({scriptId:selected.id});await until(()=>app.runner.active);assert.equal(app.runner.topic,saved.topic);assert.equal(app.playingTopic.topic,saved.topic);assert.equal(app.runner.side('A').stance,'');await app.stop();
  const played=[];app.play=async script=>played.push(script.topic);app.announce=async()=>{};app.cycle.sleep=async()=>{};
  app.startCycle({topicId:saved.topicId,rounds:1});await app.task;assert.deepEqual(played,[saved.topic]);
});

test('自定义或导入剧本未带角色时，不回退到上班摸鱼的开场立场',async t=>{
  const app=await runtime(t,{renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:30000})}),script={...short(),topic:'周末该怎么过',topicId:'custom-weekend'};
  await app.saveScript(script);app.startSingle({scriptId:script.id});await until(()=>app.runner.active);
  for(const side of app.runner.sides){assert.equal(side.stance,'');assert.deepEqual(side.points,[]);}assert.equal(app.playingTopic.topic,script.topic);await app.stop();
});

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

test('轮播只收完整可用的短场；移出后保留原稿，短稿只支持单场',async t=>{
  const app=await runtime(t);await app.saveScript(full());await app.saveScript(short());await app.saveScript({...full('unready'),meta:{ready:false}});
  assert.equal(app.snapshot().library.available,1);const before=await app.loadScript('s1');
  await app.setScriptEnabled('s1',false);assert.equal(app.snapshot().library.available,0);assert.deepEqual(await app.loadScript('s1'),before);
  const out=await app.libraryEntry('short');assert.equal(out.ready,true);await assert.rejects(app.libraryEntry('short',{automatic:true}),/短场轮播/);
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
  const exported=await fetch(base+'/api/scripts/export?id='+imported.scriptId).then(r=>r.json());assert.equal(exported.playCount,undefined);assert.equal(exported.turns.length,25);
  const html=await readFile(path.join(root,'public/index.html'),'utf8');assert.match(html,/id="tab-library"/);assert.ok(!html.includes('生成并播放单场'));
});

test('HTTP 防护开关重查库存，并同步控制语音检查与音频授权版本',async t=>{
  const dataDir=await temporary(t);const app=await createApplication({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:1})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));cleanup.set(dataDir,()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port,post=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await post('/api/safety',{blockedTerms:['自定测试词']});const script=full();script.turns[20].text+='自定测试词';await app.runtime.saveScript(script);
  assert.equal(app.runtime.snapshot().library.available,0);
  const off=await post('/api/safety',{enabled:false}).then(r=>r.json());assert.equal(off.safety.enabled,false);assert.equal(app.runtime.snapshot().library.available,1);
  const item=app.runtime.engine.say('自定测试词');assert.equal(item.text,'自定测试词');
  assert.equal((await post('/api/speech',{id:item.id})).status,200);assert.equal(app.runtime.safeAudio.get('/audio/mock.mp3'),app.runtime.safety.revision);
  assert.equal((await post('/api/script/import',{script:{topic:'一次普通聊天',turns:[{side:'A',act:1,text:'自定测试词'}]}})).status,200);
  const on=await post('/api/safety',{enabled:true}).then(r=>r.json());assert.equal(on.safety.enabled,true);assert.equal(app.runtime.snapshot().library.available,0);
  assert.equal((await fetch(base+'/audio/mock.mp3')).status,403);app.runtime.engine.utterances.push(item);assert.equal((await post('/api/speech',{id:item.id})).status,400);
  const settings=await fetch(base+'/api/safety').then(r=>r.json());assert.deepEqual(settings.blockedTerms,['自定测试词']);assert.equal(settings.enabled,true);
});

test('HTTP 支持纯自定义批量写稿与单题接口，导出保留自定义题目',async t=>{
  const dataDir=await temporary(t);const app=await createApplication({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),renderVoice:async()=>({url:'/audio/mock.mp3',durationMs:1})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));cleanup.set(dataDir,()=>app.close());
  t.mock.method(ScriptWriter.prototype,'write',async function(){return {...full(),topic:this.topic,sides:this.sides,meta:{}};});
  const base='http://127.0.0.1:'+app.server.address().port,post=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/api/scripts/generate-batch',{customTopics:['奶茶应该热着喝还是冰着喝'],count:2})).status,200);await app.runtime.task;
  assert.equal(app.runtime.production.succeeded,2);const id=app.runtime.scripts[0].id;
  const exported=await fetch(base+'/api/scripts/export?id='+id).then(r=>r.json());assert.equal(exported.topic,'奶茶应该热着喝还是冰着喝');assert.match(exported.topicId,/^custom-/);
  assert.equal((await post('/api/script/generate',{topic:'朋友借钱该不该收利息'})).status,200);await app.runtime.task;assert.equal(app.runtime.scripts.length,3);
  assert.equal((await post('/api/scripts/generate-batch',{customTopics:['题'.repeat(101)]})).status,400);
});
