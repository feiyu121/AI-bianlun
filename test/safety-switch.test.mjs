import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {Safety} from '../lib/safety.mjs';
import {validateScript} from '../lib/runtime.mjs';

async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'ai-safety-switch-'));t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-safety-switch-'));await rm(dir,{recursive:true,force:true});});return dir;}

test('总开关同时控制词库、谐音、自定义词、昵称、分片与输出拦截',async()=>{
  let now=1000;const safety=new Safety({now:()=>now});await safety.configure({blockedTerms:['测试自定义词']});
  assert.equal(safety.check('牛批').blocked,true);assert.equal(safety.check('niu pi').blocked,true);assert.equal(safety.check('测试自定义词').blocked,true);
  safety.ingress({type:'comment',userId:'u',text:'测试自定'});safety.output('普通的话',{trackSequence:true});assert.equal(safety.fragments.size,1);
  const revision=safety.revision;await safety.configure({enabled:false});assert.ok(safety.revision>revision);assert.equal(safety.fragments.size,0);assert.equal(safety.outputTail,'');
  for(const text of ['牛批','niu pi','测试自定义词','跟我念','手机号13800138000'])assert.equal(safety.check(text,{record:true}).blocked,false);
  const received=safety.ingress({type:'comment',userId:'u',name:'测试自定义词',text:'测试自定义词'});assert.equal(received.blocked,false);assert.equal(received.next.name,'测试自定义词');assert.equal(safety.fragments.size,0);
  assert.equal(safety.output('万岁'), '万岁');assert.equal(safety.output('测试自定义词'),'测试自定义词');assert.deepEqual(safety.view().counts,{});
  now+=100;await safety.configure({enabled:true});assert.equal(safety.check('测试自定义词').blocked,true);assert.notEqual(safety.output('万岁'),'万岁');assert.equal(safety.cleanName('测试自定义词'),'神秘观众');
});

test('开关跨重启保存，单独保存屏蔽词不重新开启，旧配置默认开启',async t=>{
  const dataDir=await temporary(t);let safety=new Safety({dataDir});await safety.init();assert.equal(safety.view().enabled,true);
  await safety.configure({enabled:false,blockedTerms:['测试自定义词']});safety=new Safety({dataDir});await safety.init();
  assert.equal(safety.settings().enabled,false);assert.deepEqual(safety.settings().blockedTerms,['测试自定义词']);
  await safety.configure({blockedTerms:['另一个测试词']});assert.equal(safety.view().enabled,false);
  await safety.configure({enabled:true});assert.deepEqual(safety.settings().blockedTerms,['另一个测试词']);
  await writeFile(path.join(dataDir,'safety-settings.json'),JSON.stringify({version:1,blockedTerms:['旧词']}));
  safety=new Safety({dataDir});await safety.init();assert.equal(safety.view().enabled,true);assert.deepEqual(safety.settings().blockedTerms,['旧词']);
});

test('关闭屏蔽允许原先被挡的剧本，格式与字数校验仍有效',async()=>{
  const safety=new Safety(),script={topic:'一次普通聊天',turns:[{side:'A',act:1,text:'这也太牛批了。'}]};
  assert.throws(()=>validateScript(script,safety),/第 1 句命中/);await safety.configure({enabled:false});assert.equal(validateScript(script,safety).turns[0].text,script.turns[0].text);
  assert.throws(()=>validateScript({...script,turns:[{side:'X',act:1,text:'正常台词'}]},safety),/格式无效/);
  assert.throws(()=>validateScript({...script,turns:[{side:'A',act:1,text:'字'.repeat(601)}]},safety),/格式无效/);
  await safety.configure({enabled:true});assert.throws(()=>validateScript(script,safety),/命中/);
});

test('无效开关值或未知设置被拒绝，配置不会部分修改',async()=>{
  const safety=new Safety();
  for(const input of [{enabled:'false'},{enabled:0},{enabled:false,unknown:true},{enabled:false,blockedTerms:[null]},[]])await assert.rejects(safety.configure(input));
  assert.equal(safety.view().enabled,true);assert.deepEqual(safety.settings().blockedTerms,[]);
});
