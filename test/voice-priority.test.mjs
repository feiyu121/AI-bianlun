import test from 'node:test';
import assert from 'node:assert/strict';
import {CloudVoice} from '../lib/cloud-voice.mjs';

test('互动配音排在尚未开始的主线预读前，正在合成的任务不中断，失败后继续串行',async()=>{
 const voice=new CloudVoice({dataDir:'.',audioDir:'.'}),order=[];
 let finish,active=0,maxActive=0;
 const work=(id,wait=false,fail=false)=>async()=>{
  order.push(id);active++;maxActive=Math.max(maxActive,active);
  try{if(wait)await new Promise(resolve=>{finish=resolve;});if(fail)throw new Error('合成失败');return id;}
  finally{active--;}
 };
 const current=voice.enqueueRender(work('正在合成',true));await Promise.resolve();
 const normal=voice.enqueueRender(work('主线预读'));
 const reply=voice.enqueueRender(work('互动回复',false,true),true);
 const failed=assert.rejects(reply,/合成失败/);
 assert.deepEqual(order,['正在合成'],'互动不能打断已有合成');
 finish();await Promise.all([current,normal,failed]);
 assert.deepEqual(order,['正在合成','互动回复','主线预读']);
 assert.equal(maxActive,1,'两个音色也不能突破供应商并发限制');
});
