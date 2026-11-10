import {estimateDuration} from '../speech.mjs';

// A playback unit is a breathing point, not a whole paragraph. Preserve every character.
export const SPEECH_CHUNK_CHARS=40;
export function speechChunks(value,maxChars=SPEECH_CHUNK_CHARS){
 const chars=Array.from(String(value??'')),chunks=[];
 const limit=Math.max(8,Math.trunc(maxChars)||SPEECH_CHUNK_CHARS);
 while(chars.length>limit){
  const head=chars.slice(0,limit).join('');
  const min=Math.floor(limit*.4);
  let sentence=0,clause=0;
  Array.from(head).forEach((ch,i)=>{
   if(i+1<min)return;
   if(/[。！？!?；;]/u.test(ch))sentence=i+1;
   else if(/[，,：:\s]/u.test(ch))clause=i+1;
  });
  let end=sentence||clause||limit;
  while(/[”’」』]/u.test(chars[end]||''))end++;
  chunks.push(chars.splice(0,end).join(''));
 }
 if(chars.length)chunks.push(chars.join(''));
 return chunks;
}

export function playbackTurns(turns){
 return turns.flatMap((turn,index)=>{
  const text=String(turn.text||'').trim(),parts=speechChunks(text);
  if(parts.length<=1)return [{...turn,text}];
  const sourceId=String(turn.id??index+1);
  return parts.map((part,i)=>({...turn,id:`${sourceId}-p${i+1}`,sourceId,text:part,
   audio:'',durationMs:0,estSec:estimateDuration(part)/1000}));
 });
}
