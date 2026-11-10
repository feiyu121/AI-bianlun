import test from 'node:test';
import assert from 'node:assert/strict';
import {episodeStatus} from '../lib/script/episode.mjs';
import {DebateCycle} from '../lib/debate-cycle.mjs';
import {TopicVote} from '../lib/topic-vote.mjs';
import {AudienceCamps} from '../lib/audience-camps.mjs';

test('短场轮播允许聊透后提前结束，排除超长、缺段和单人稿',()=>{
 const script={turns:Array.from({length:20},(_,i)=>({act:Math.floor(i/4)+1,side:i%2?'B':'A',estSec:20}))};
 assert.equal(episodeStatus(script).shortForm,true);
 assert.equal(episodeStatus({turns:script.turns.map(row=>({...row,estSec:9}))}).shortForm,true,'三分钟完整稿不强行扩长');
 assert.equal(episodeStatus({turns:script.turns.map(row=>({...row,estSec:31}))}).shortForm,false);
 assert.equal(episodeStatus({turns:script.turns.filter(row=>row.act!==3)}).shortForm,false);
 assert.equal(episodeStatus({turns:script.turns.map(row=>({...row,side:'A'}))}).shortForm,false);
});

for(const mode of ['empty','tie','leader'])test(`默认场间 ${mode} 不超35秒，投票不拖成长等待`,async()=>{
 let clock=1700000000000,endAt=0,nextAt=0;
 const bank=[{id:'a',topic:'甲'},{id:'b',topic:'乙'},{id:'c',topic:'丙'}];
 const cycle=new DebateCycle({libraryOnly:true,bank,now:()=>clock,sleep:async ms=>{clock+=ms;},
  prepare:async topic=>({ready:true,script:{id:topic.id}}),
  play:async()=>{if(!endAt)endAt=clock;else nextAt=clock;},
  onPhase:event=>{if(event.phase==='vote'&&mode!=='empty'){
   cycle.vote.cast({userId:'u1',text:'1'});
   if(mode==='tie')cycle.vote.cast({userId:'u2',text:'2'});
  }}
 });
 await cycle.run({first:bank[0],rounds:2});
 assert.ok(nextAt-endAt>=25000&&nextAt-endAt<=35000,`实际场间 ${nextAt-endAt}ms`);
 assert.equal(cycle.vote.extended,0,'默认平票不加时');
});

test('场控延长聊天保留选题票、保证延长时间，不能无限拖延或重开锁票',()=>{
 let clock=1700000000000;const vote=new TopicVote({now:()=>clock});
 vote.open({candidates:[{id:'a'},{id:'b'}]});vote.cast({userId:'u1',text:'2'});
 clock+=19000;assert.equal(vote.defer().ok,true);
 assert.equal(vote.total(),1);assert.equal(vote.topIds()[0],'b');
 clock+=20000;assert.equal(vote.canLock(),false);clock+=6000;assert.equal(vote.canLock(),true);
 for(let i=0;i<3;i++)assert.equal(vote.defer().ok,true);
 assert.equal(vote.defer().reason,'limit');vote.lock();assert.equal(vote.defer().reason,'closed');
});

test('本题票数重置，本次直播累计按观众去重并保留礼物；转投不搬礼物',()=>{
 const camps=new AudienceCamps(),sides=[{id:'A',name:'肉包'},{id:'B',name:'鲸鱼娘'}],viewer={userId:'private-viewer',name:'观众'};
 camps.open(sides);camps.cast(viewer,'A');camps.gift({id:'gift-1',gift:'candy',count:2});camps.close();
 camps.open(sides,{continueSession:true});assert.equal(camps.view().totalVotes,0);
 assert.deepEqual(camps.view().session.sides.map(side=>side.votes),[7,0]);
 camps.cast(viewer,'A');assert.equal(camps.view().session.totalVotes,7,'同一人跨题重发不刷累计票');
 camps.cast(viewer,'B');assert.deepEqual(camps.view().session.sides.map(side=>side.votes),[6,1]);
 assert.equal(camps.gift({id:'gift-1',gift:'candy',count:2}).duplicate,true,'跨题不重复收旧礼物事件');
 assert.equal(camps.view().totalVotes,1);
 camps.gift({id:'gift-2',gift:'flower',count:3});assert.equal(camps.view().session.totalVotes,10);
 assert.ok(!JSON.stringify(camps.view()).includes('private-viewer'));
 camps.close();camps.open(sides);assert.equal(camps.view().session.totalVotes,0,'重新开播开始新的累计');
});
