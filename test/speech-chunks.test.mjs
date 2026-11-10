import test from 'node:test';
import assert from 'node:assert/strict';
import {speechChunks,playbackTurns,SPEECH_CHUNK_CHARS} from '../lib/script/speech-chunks.mjs';

test('播放分段按自然停顿拆开，中文、英文、emoji和无标点文本均不丢字',()=>{
 for(const text of ['这件事先说明白。然后把刚才那个条件慢慢展开，你先别急着下结论。'.repeat(5),
  '甲🙂乙'.repeat(60),'A complete English sentence, with spaces and another sentence. '.repeat(8)]){
  const parts=speechChunks(text);
  assert.ok(parts.length>1);assert.equal(parts.join(''),text);
  assert.ok(parts.every(part=>Array.from(part).length<=SPEECH_CHUNK_CHARS));
 }
 assert.deepEqual(speechChunks('为什么？'),['为什么？']);
});

test('长段拆分保留幕号与人物，不能复用原整段音频和时长；原剧本不改写',()=>{
 const source=[{id:'t001',side:'B',act:1,reaction:false,text:'先把这件事情说清楚。'.repeat(10),audio:'/audio/whole.mp3',durationMs:30000}];
 const turns=playbackTurns(source);
 assert.ok(turns.length>1);assert.equal(turns.map(turn=>turn.text).join(''),source[0].text);
 assert.equal(new Set(turns.map(turn=>turn.id)).size,turns.length);
 assert.ok(turns.every(turn=>turn.side==='B'&&turn.act===1&&turn.reaction===false&&!turn.audio&&!turn.durationMs&&turn.estSec>0));
 assert.equal(source.length,1);assert.equal(source[0].audio,'/audio/whole.mp3');
 const short={id:'t002',text:'好。',audio:'/audio/short.mp3',durationMs:1200};
 assert.deepEqual(playbackTurns([short]),[short]);
});
