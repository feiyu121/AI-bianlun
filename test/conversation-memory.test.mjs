import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationMemory,memoryPrompt} from '../lib/conversation-memory.mjs';
test('整场记录保留早先的承诺、改口与互动顺序，快照不暴露额外字段',()=>{
 const memory=new ConversationMemory();
 memory.remember({side:'A',text:'我先答应你，今天交接完再走。',userId:'private',kind:'script'});
 for(let i=0;i<59;i++)memory.remember({side:i%2?'A':'B',text:`第${i}句，先把眼前这件事讲清楚。`});
 memory.remember({side:'B',text:'你刚才倒是答应过我，别装忘了。',kind:'mention'});
 const snapshot=memory.snapshot();assert.equal(snapshot.omitted,0);assert.equal(snapshot.history.length,61);
 assert.match(snapshot.history[0].text,/交接完再走/);assert.equal(snapshot.history.at(-1).kind,'mention');
 assert.ok(!JSON.stringify(snapshot).includes('private'));assert.match(memoryPrompt(snapshot),/别重置回开场立场/);
 snapshot.history[0].text='被修改';assert.match(memory.snapshot().history[0].text,/交接完再走/);
});
test('超长场次的记忆有预算边界，保留开场与最近的话，重写使用独立副本',()=>{
 const memory=new ConversationMemory();for(let i=0;i<150;i++)memory.remember({side:'A',text:`第${i}句：`+'一段对话内容。'.repeat(30)});
 const snapshot=memory.snapshot({maxChars:2400});
 assert.ok(snapshot.omitted>0);assert.match(snapshot.history[0].text,/第0句/);assert.match(snapshot.history.at(-1).text,/第149句/);
 assert.ok(snapshot.history.reduce((n,row)=>n+JSON.stringify(row).length,0)<=2400);
 const copy=memory.clone();copy.remember({side:'B',text:'新写的一句。'});assert.notEqual(memory.snapshot().history.at(-1).text,'新写的一句。');
});
