import {resolvePerformance} from './performance.js';

export function currentPerformance(data,now=Date.now()){
 const playback=data?.playback;
 if(playback?.text&&(!playback.until||playback.until>now)){
  const item=data.utterances?.find(row=>row.id===playback.id)||{};
  return {side:playback.speaker,phase:'speaking',at:playback.at||now,until:playback.until,performance:playback.performance||item.performance||resolvePerformance({...item,text:playback.text,emotion:playback.emotion})};
 }
 const cue=data?.state?.performanceCue;
 if(cue&&cue.until>now&&data.script?.active&&!data.script.paused&&
    (cue.phase!=='speaking'||!data.system?.playerActive))return cue;
 return null;
}

// Quiet, bounded poses; the listener reacts once rather than looping a gesture.
export function avatarPerformance(cue,side,now=Date.now()){
 const direction=side==='A'?1:-1;
 const rest={expression:'neutral',speaking:false,pose:{yaw:direction*.04,pitch:0,roll:0,gazeX:direction*.08,gazeY:0}};
 if(!cue||!['A','B'].includes(cue.side))return rest;
 const age=Math.max(0,now-cue.at),own=side===cue.side,p=cue.performance||{};
 if(own){
  const expression=p.expression||'neutral',speaking=cue.phase==='speaking';
  const thinking=cue.phase==='pause'||expression==='thinking',teasing=expression==='teasing';
  return {expression:cue.phase==='hold'?'neutral':thinking?'thinking':expression,speaking,
   pose:{yaw:teasing?direction*.12:direction*.02,pitch:thinking ? .07 : 0,roll:thinking?direction*.06:0,gazeX:teasing?direction*.22:thinking?-direction*.12:0,gazeY:thinking ? .14 : 0}};
 }
 const reaction=p.listenerReaction||'none';
 const listening={...rest,pose:{...rest.pose,yaw:direction*.12,gazeX:direction*.28}};
 const reactionAt=cue.phase==='hold'?0:Math.min(1000,Math.max(250,((cue.until||cue.at+2000)-cue.at)*.35));
 if(cue.phase==='pause'||cue.phase==='hold'||age<reactionAt||age>reactionAt+1800)return listening;
 if(reaction==='caught')return {...listening,expression:'embarrassed',pose:{yaw:age-reactionAt>500?-direction*.12:direction*.08,pitch:.08,roll:direction*.04,gazeX:age-reactionAt>500?-direction*.3:direction*.2,gazeY:.13}};
 if(reaction==='amused'||reaction==='softened')return {...listening,expression:'smile',pose:{...listening.pose,pitch:.025,roll:-direction*.035}};
 if(reaction==='skeptical')return {...listening,expression:'thinking',pose:{...listening.pose,roll:direction*.08}};
 return listening;
}
