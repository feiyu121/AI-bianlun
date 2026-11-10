// 六到八分钟是创作目标；完整的较短对话也可轮播，不按时长强行补写。
export const EPISODE_LIMITS=Object.freeze({targetMinutes:7,minSeconds:180,maxSeconds:600,minTurns:12});

export function episodeStatus(script){
 const turns=script?.turns||[],seconds=turns.reduce((sum,turn)=>sum+Number(turn.estSec||0),0);
 const acts=[...new Set(turns.map(turn=>turn.act))].sort((a,b)=>a-b);
 const complete=acts.length>=3&&acts.every((act,index)=>act===index+1)&&new Set(turns.map(turn=>turn.side)).size===2;
 return {seconds,complete,shortForm:complete&&turns.length>=EPISODE_LIMITS.minTurns&&seconds>=EPISODE_LIMITS.minSeconds&&seconds<=EPISODE_LIMITS.maxSeconds};
}
