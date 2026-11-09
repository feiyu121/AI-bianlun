// Membership belongs to a character for one match, independent of their opinions.
const normalize=value=>String(value??'').normalize('NFKC').replace(/[\s，。！？、,.!?~～…:：;；“”‘’"']/gu,'').toLowerCase();
export const CAMP_GIFT_RULES=Object.freeze({
  heart:Object.freeze({side:'A',weight:1,label:'爱心'}),
  candy:Object.freeze({side:'A',weight:3,label:'棒棒糖'}),
  flower:Object.freeze({side:'B',weight:1,label:'鲜花'}),
  beer:Object.freeze({side:'B',weight:3,label:'啤酒'})
});
export function parseCamp(text,sides=[]){
  const value=normalize(text);
  const hits=['A','B'].filter((id,index)=>{
    const tokens=[String(index+1),id.toLowerCase(),index?'反方':'正方',...sides.filter(side=>side.id===id).map(side=>normalize(side.name))].filter(Boolean);
    return tokens.some(token=>['', '支持', '我支持', '加入', '加入阵营', '站队', '我站', '转投', '改投'].some(prefix=>value===prefix+token||value===prefix+token+'阵营'));
  });
  return hits.length===1?hits[0]:null;
}

export class AudienceCamps{
  constructor({now=Date.now,limit=100000}={}){this.now=now;this.limit=limit;this.state='idle';this.members=new Map();this.counts={A:0,B:0};this.giftVotes={A:0,B:0};this.giftEvents=new Set();this.sides=[];this.recent=[];}
  open(sides){
    this.members.clear();this.counts={A:0,B:0};this.giftVotes={A:0,B:0};this.giftEvents.clear();this.recent=[];
    this.sides=['A','B'].map(id=>({id,name:sides.find(side=>side.id===id)?.name||id}));
    this.state='open';this.openedAt=this.now();this.closedAt=0;
  }
  close(){if(this.state!=='open')return false;this.state='closed';this.closedAt=this.now();return true;}
  cast(event,side){
    if(this.state!=='open')return {ok:false,reason:'closed'};
    if(!['A','B'].includes(side))return {ok:false,reason:'invalid-side'};
    const userId=String(event.userId??'').trim(),name=String(event.name??'').trim();
    if(!userId&&!name)return {ok:false,reason:'anonymous'};
    const key=JSON.stringify([event.source||'local',userId?'id':'name',userId||name]);
    const previous=this.members.get(key);
    if(previous?.side===side)return {ok:true,side,duplicate:true,changed:false,weak:!userId};
    if(!previous&&this.members.size>=this.limit)return {ok:false,reason:'capacity'};
    if(previous)this.counts[previous.side]--;
    this.members.set(key,{side,weak:!userId});this.counts[side]++;
    const receipt={name:name||'观众',side,changed:Boolean(previous),weak:!userId,at:this.now()};
    this.recent.push(receipt);this.recent=this.recent.slice(-8);
    return {ok:true,side,duplicate:false,changed:Boolean(previous),weak:!userId};
  }
  view(){
    const total=this.members.size,totalVotes=total+this.giftVotes.A+this.giftVotes.B;
    return {state:this.state,openedAt:this.openedAt||0,closedAt:this.closedAt||0,total,totalVotes,
      giftRules:Object.entries(CAMP_GIFT_RULES).map(([gift,rule])=>({gift,...rule})),
      sides:this.sides.map(side=>({...side,count:this.counts[side.id],giftVotes:this.giftVotes[side.id],votes:this.counts[side.id]+this.giftVotes[side.id],share:totalVotes?(this.counts[side.id]+this.giftVotes[side.id])/totalVotes:0})),
      recent:this.recent.map(row=>({...row}))};
  }
  gift(event){
    if(this.state!=='open')return {ok:false,reason:'closed'};
    if(!Object.hasOwn(CAMP_GIFT_RULES,event.gift))return {ok:false,reason:'neutral'};
    const rule=CAMP_GIFT_RULES[event.gift];
    if(!Number.isSafeInteger(event.count)||event.count<1||event.count>100000)return {ok:false,reason:'invalid-count'};
    if(typeof event.id!=='string'||!event.id.trim())return {ok:false,reason:'missing-id'};
    const key=JSON.stringify([event.source||'local',event.id]);
    if(this.giftEvents.has(key))return {ok:true,side:rule.side,points:0,duplicate:true};
    // Never evict a paid event and risk counting its replay twice.
    if(this.giftEvents.size>=this.limit)return {ok:false,reason:'capacity'};
    const points=rule.weight*event.count;
    if(!Number.isSafeInteger(this.members.size+this.giftVotes.A+this.giftVotes.B+points))return {ok:false,reason:'overflow'};
    this.giftEvents.add(key);this.giftVotes[rule.side]+=points;
    return {ok:true,side:rule.side,points,weight:rule.weight,duplicate:false};
  }
}
