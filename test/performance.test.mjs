import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performanceFields,resolvePerformance} from '../public/performance.js';
import {currentPerformance,avatarPerformance} from '../public/stage-performance.js';
import {AVATAR_PROFILES} from '../public/avatar-profiles.js';
import {validateScript} from '../lib/runtime.mjs';
import {createApplication} from '../lib/http-app.mjs';
import {ScriptWriter,ACTS} from '../lib/script/writer.mjs';
import {ScriptRunner} from '../lib/script/runner.mjs';
import {playbackTurns} from '../lib/script/speech-chunks.mjs';
import {Studio} from '../lib/studio.mjs';
import {voiceRequest,CLOUD_VOICE_DEFAULTS,edgeRate} from '../lib/cloud-voice.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const direction={expression:'teasing',delivery:'故意认真，轻轻补刀',listenerReaction:'caught',pauseBeforeMs:300};

test('旧稿保守回退，问号、感叹号不能直接决定情绪；非法字段不进入播放器',()=>{
 assert.equal(resolvePerformance({text:'谢谢你！'}).expression,'neutral');
 assert.equal(resolvePerformance({text:'你觉得呢？'}).expression,'neutral');
 assert.equal(resolvePerformance({text:'上次谁先跑的？'}).expression,'teasing');
 assert.equal(resolvePerformance({emotion:'angry',expression:'serious'}).emotion,'neutral');
 assert.deepEqual(performanceFields({expression:'random',listenerReaction:'dance',pauseBeforeMs:Infinity,delivery:12}),{});
 assert.equal(performanceFields({pauseBeforeMs:50000}).pauseBeforeMs,800);
 assert.equal(performanceFields({pauseBeforeMs:-100}).pauseBeforeMs,0);
 assert.equal(performanceFields({delivery:'哈'.repeat(100)}).delivery.length,80);
});

test('模型生成的表演字段经过组装与导入校验仍保留，台词原文不混入指令',async()=>{
 const writer=new ScriptWriter({complete:async messages=>{
  if(!JSON.parse(messages[1].content).本幕)return '{}';
  assert.match(messages[0].content,/listenerReaction/);
  return JSON.stringify([{side:'A',text:'这次我真的没有偷懒。'},{side:'B',text:'行，你最勤快。',...direction}]);
 }});
 const script=await writer.write({topic:'聊聊偷懒',acts:[ACTS[0]]}),clean=validateScript(script);
 for(const key of Object.keys(direction))assert.equal(clean.turns[1][key],direction[key]);
 assert.equal(clean.turns[1].text,'行，你最勤快。');
 assert.equal(clean.turns[0].delivery,undefined);
 const chunks=playbackTurns([{...clean.turns[1],text:'这句话还没有说完，我们接着把刚才的细节讲清楚。'.repeat(5)}]);
 assert.ok(chunks.length>1);assert.equal(chunks[0].pauseBeforeMs,300);
 assert.ok(chunks.slice(1).every(turn=>turn.pauseBeforeMs===0&&turn.listenerReaction==='none'));
 assert.ok(chunks.every(turn=>turn.expression==='teasing'&&turn.delivery===direction.delivery));
});

test('语音请求与画面共享情绪，语气走独立字段，Edge降级只轻微调速',()=>{
 const item={text:'你这回还嘴硬吗？',expression:'annoyed',delivery:'略带不服气地认真反问'};
 const request=voiceRequest(item,{...CLOUD_VOICE_DEFAULTS,resourceId:'seed-tts-2.0'}).req_params;
 assert.equal(request.text,item.text);
 assert.match(JSON.parse(request.additions).context_texts.join(' '),/略带不服气地认真反问/);
 const old=voiceRequest(item,{...CLOUD_VOICE_DEFAULTS,resourceId:'seed-tts-1.0'}).req_params;
 assert.equal(old.audio_params.emotion,resolvePerformance(item).emotion);
 assert.equal(edgeRate({expression:'serious'},{speechRate:0}),-1);
 assert.equal(edgeRate({expression:'serious'},{speechRate:-5}),-5);
 assert.equal(edgeRate({expression:'teasing'},{speechRate:0}),0);
});

test('双方独立映射的每个表情确实存在于各自模型素材中',async()=>{
 for(const [profile,model]of [['roubao','doubao/2.0.model3.json'],['whale','ds-whale-girl/c_0120.model3.json']]){
  const manifest=JSON.parse(await readFile(new URL('../public/avatar/live2d/'+model,import.meta.url),'utf8'));
  const names=new Set(manifest.FileReferences.Expressions.map(row=>row.Name));
  for(const name of Object.values(AVATAR_PROFILES[profile]))if(name)assert.ok(names.has(name),`${profile}: ${name}`);
 }
 assert.equal(AVATAR_PROFILES.whale.smile,'开心兴奋');
});

test('表演跟随实际出声，听话反应延后且只短暂出现，暂停或过期不继续动嘴',()=>{
 const now=1700000000000,performance=resolvePerformance(direction);
 const cue={side:'B',phase:'speaking',at:now,until:now+5000,performance};
 const state={script:{active:true,paused:false},system:{playerActive:true},state:{performanceCue:cue},playback:{text:''}};
 assert.equal(currentPerformance(state,now),null,'有播放器时不提前用预计时间演');
 state.playback={id:1,text:'上次谁先跑的？',speaker:'B',at:now,until:now+5000,performance};
 assert.equal(currentPerformance(state,now).side,'B');
 assert.equal(avatarPerformance(cue,'B',now+1000).speaking,true);
 assert.equal(avatarPerformance(cue,'A',now+100).expression,'neutral');
 const caught=avatarPerformance(cue,'A',now+1600);
 assert.equal(caught.expression,'embarrassed');assert.equal(caught.speaking,false);assert.ok(caught.pose.gazeX<0);
 assert.equal(avatarPerformance(cue,'A',now+4000).expression,'neutral','不能一直循环被揭短');
 assert.equal(currentPerformance(state,now+6000),null);
 state.playback={text:''};state.system.playerActive=false;assert.equal(currentPerformance(state,now).phase,'speaking');
 state.script.paused=true;assert.equal(currentPerformance(state,now),null);
});

test('实际播放器按表演停顿后才发布，配音与发布情绪相同，停止能打断停顿',async()=>{
 const engine=new Studio(),calls=[],events=[];let clock=1700000000000;
 const runner=new ScriptRunner({engine,cloudVoice:{render:async item=>{calls.push(item);return {url:'/audio/test.mp3',durationMs:100};}},
  now:()=>clock,sleep:async ms=>{clock+=ms;},onChange:()=>{if(engine.state.performanceCue)events.push({...engine.state.performanceCue,utterances:engine.utterances.length});}});
 const script={topic:'怎么接话',turns:[{act:1,side:'A',text:'听听你的理由。',reaction:false},{act:1,side:'B',text:'你先别装了。',reaction:false,...direction}]};
 await runner.start({script});await runner.running;
 assert.equal(runner.turns[1].startAt-runner.turns[0].endAt,300);
 assert.ok(events.some(event=>event.phase==='pause'&&event.utterances===1));
 assert.equal(calls[1].emotion,engine.utterances[1].emotion);
 assert.equal(engine.utterances[1].performance.delivery,direction.delivery);assert.equal(runner.stats.starved,0);
 const stopped=new ScriptRunner({engine:new Studio(),cloudVoice:{render:async()=>({url:'/audio/test.mp3',durationMs:100})},
  now:()=>clock,sleep:async ms=>{clock+=ms;},onChange:()=>{if(stopped.engine.state.performanceCue?.phase==='pause')stopped.stop();}});
 await stopped.start({script});await stopped.running;
 assert.equal(stopped.engine.utterances.length,1);assert.equal(stopped.engine.state.performanceCue,null);
});

test('HTTP导入导出保留表演，预合成与实际分段播放复用相同语音请求',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'ai-performance-')),calls=[];
 const app=await createApplication({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),renderVoice:async(item,settings)=>{
  calls.push(JSON.stringify({voice:settings.voiceName,request:voiceRequest(item,CLOUD_VOICE_DEFAULTS)}));return {url:'/audio/test.mp3',durationMs:1};
 }});
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
 const post=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();};
 const text='这是需要拆成多个配音段落的长句，我们继续说刚才发生的事情。'.repeat(3);
 const result=await post('/api/script/import',{script:{topic:'怎么演',turns:[{act:1,side:'A',text,...direction}]}});
 const saved=await fetch(base+'/api/scripts/export?id='+result.scriptId).then(response=>response.json());
 assert.equal(saved.turns[0].delivery,direction.delivery);assert.equal(saved.turns[0].pauseBeforeMs,300);
 await post('/api/scripts/audio',{scriptId:result.scriptId});await app.runtime.task;
 const warmed=[...calls];assert.equal(warmed.length,playbackTurns(saved.turns).length);calls.length=0;
 app.runtime.runner.sleep=async()=>{};
 await post('/api/script/start',{scriptId:result.scriptId});await app.runtime.task;
 assert.deepEqual(calls,warmed);
 const item=app.runtime.engine.utterances[0];
 await post('/api/player',{id:'qa-player'});await post('/api/playback',{playerId:'qa-player',id:item.id,duration:1});
 const state=await fetch(base+'/api/state').then(response=>response.json());
 assert.equal(state.playback.performance.expression,'teasing');assert.ok(state.playback.at>0);
 const retry=app.runtime.engine.say('这次你可别装了。');retry.performance=resolvePerformance(direction);retry.emotion=retry.performance.emotion;
 await post('/api/speech',{id:retry.id});
 assert.match(calls.at(-1),/故意认真，轻轻补刀/,'前端重试缺失音频时也必须沿用表演指令');
});

test('跳幕能打断等待出声，不能随后重新发布旧人物的表演',async()=>{
 const engine=new Studio(),runner=new ScriptRunner({engine,cloudVoice:{render:async()=>({url:'/audio/test.mp3',durationMs:1000})},voiceExpected:()=>true});
 runner.attach({topic:'跳幕',turns:[{act:1,side:'A',text:'这句还在等声音。'},{act:2,side:'B',text:'进入下一段。'}]});runner.active=true;
 const speaking=runner.speak(runner.turns[0]);
 runner.skip();await speaking;
 assert.equal(engine.state.performanceCue,null);assert.equal(engine.state.scriptLine,undefined);
 runner.stop();
});
