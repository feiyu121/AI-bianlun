import test from 'node:test';
import assert from 'node:assert/strict';
import {AudienceCamps,parseCamp} from '../lib/audience-camps.mjs';
import {DouyinEvents,validateGiftMap,GIFT_MAP} from '../lib/douyin-events.mjs';
import {GIFT_PROFILES} from '../lib/gift-profiles.mjs';
const sides=[{id:'A',name:'肉包'},{id:'B',name:'鲸鱼娘'}];

test('阵营指令只匹配整条，支持全角、名字和明确加入/转投',()=>{
  for(const value of ['1','１！','A','肉包','支持肉包','我支持正方','加入肉包阵营','转投肉包','改投1'])assert.equal(parseCamp(value,sides),'A',value);
  for(const value of ['2','Ｂ','鲸鱼娘','支持鲸鱼娘','加入反方阵营','我站鲸鱼娘'])assert.equal(parseCamp(value,sides),'B',value);
  for(const value of ['12','支持肉包和鲸鱼娘','我不支持肉包','肉包你怎么看','今天1点开播','给鲸鱼娘提个问题','支持',''])assert.equal(parseCamp(value,sides),null,value);
});
test('阵营使用本场名字，不在普通点名中猜支持方向，重名不误选',()=>{
  const renamed=[{id:'A',name:'包+包'},{id:'B',name:'小鲸'}];
  assert.equal(parseCamp('支持包+包',renamed),'A');assert.equal(parseCamp('支持小鲸',renamed),'B');
  assert.equal(parseCamp('支持肉包',renamed),null);
  assert.equal(parseCamp('支持同名',[{id:'A',name:'同名'},{id:'B',name:'同名'}]),null);
});
test('一人一次、重复不增加、改阵营正确扣除；不同平台和同名用户独立',()=>{
  const camps=new AudienceCamps();camps.open(sides);
  const user={source:'douyin',userId:'private-user-42',name:'观众'};
  assert.equal(camps.cast(user,'A').changed,false);
  assert.equal(camps.cast({...user,name:'改名观众'},'A').duplicate,true);
  assert.equal(camps.cast(user,'B').changed,true);
  camps.cast({...user,source:'bilibili'},'A');camps.cast({...user,userId:'43'},'B');
  const view=camps.view();assert.equal(view.total,3);assert.deepEqual(view.sides.map(row=>row.count),[1,2]);
  assert.equal(view.sides[1].share,2/3);assert.equal(view.recent.length,4);
  assert.ok(!JSON.stringify(view).includes('private-user-42'),'公开快照不含观众 ID');
});
test('缺 ID 按昵称去重，完全匿名不计入；容量满允许原用户换阵营',()=>{
  const camps=new AudienceCamps({limit:1});camps.open(sides);
  assert.equal(camps.cast({},'A').reason,'anonymous');
  assert.equal(camps.cast({name:'观众'},'A').weak,true);
  assert.equal(camps.cast({name:'观众'},'A').duplicate,true);
  assert.equal(camps.cast({name:'另一位'},'B').reason,'capacity');
  assert.equal(camps.cast({name:'观众'},'B').changed,true);
  assert.equal(camps.view().total,1);
});
test('封存后不收人，开新场清空；快照与内部数据隔离',()=>{
  let now=100;const camps=new AudienceCamps({now:()=>now});
  assert.equal(camps.cast({userId:'1'},'A').reason,'closed');
  camps.open(sides);camps.cast({userId:'1',name:'观众'},'A');now=200;
  assert.equal(camps.close(),true);assert.equal(camps.close(),false);
  assert.equal(camps.view().closedAt,200);assert.equal(camps.cast({userId:'2'},'B').reason,'closed');
  const view=camps.view();view.sides[0].count=99;view.recent[0].name='伪造';assert.equal(camps.view().sides[0].count,1);assert.equal(camps.view().recent[0].name,'观众');
  camps.open(sides);assert.equal(camps.view().total,0);assert.equal(camps.view().recent.length,0);assert.equal(camps.view().state,'open');
});

test('支持票合并弹幕1票和礼物权重，换阵营不移动历史礼物票',()=>{
  const camps=new AudienceCamps();camps.open(sides);
  const user={userId:'viewer'};camps.cast(user,'A');
  assert.equal(camps.gift({...user,id:'g1',gift:'candy',count:2}).points,6);
  assert.equal(camps.gift({id:'g2',gift:'flower',count:3}).points,3);
  assert.equal(camps.view().total,1);assert.equal(camps.view().totalVotes,10);
  assert.deepEqual(camps.view().sides.map(side=>side.votes),[7,3]);
  assert.equal(camps.view().sides[0].share,0.7);
  camps.cast(user,'B');assert.deepEqual(camps.view().sides.map(side=>side.votes),[6,4]);
  camps.gift({id:'g3',gift:'heart',count:1});camps.gift({id:'g4',gift:'beer',count:2});
  assert.deepEqual(camps.view().sides.map(side=>side.votes),[7,10]);
  assert.equal(camps.view().total,1,'送礼不自动入阵营');
});
test('礼物消息幂等，缺稳定ID/未知礼物/非法数量不加票，封存与下场重置',()=>{
  const camps=new AudienceCamps();camps.open(sides);
  const event={id:'1',source:'douyin',gift:'heart',count:2};
  camps.gift(event);assert.equal(camps.gift(event).duplicate,true);
  assert.equal(camps.gift({...event,id:''}).reason,'missing-id');
  for(const count of [0,-1,1.5,100001,NaN])assert.equal(camps.gift({...event,id:'bad',count}).reason,'invalid-count');
  for(const gift of ['thanks','sunglasses','__proto__','toString'])assert.equal(camps.gift({...event,gift}).reason,'neutral');
  assert.equal(camps.view().totalVotes,2);
  camps.close();assert.equal(camps.gift({...event,id:'late'}).reason,'closed');
  camps.open(sides);assert.equal(camps.view().totalVotes,0);assert.equal(camps.gift(event).points,2);
});
test('计票连击按1→3→2→5只收5个，不因triggerSkill为false丢增量票',()=>{
  const events=new DouyinEvents(),camps=new AudienceCamps();camps.open(sides);
  const raw={type:'gift',room:'1',userId:'u1',giftName:'棒棒糖',groupId:'combo1',combo:true};
  const points=[];
  for(const [i,repeatCount]of [1,3,2,5].entries()){
    const event=events.normalize({...raw,id:'combo-'+i,repeatCount});
    if(event)points.push(camps.gift(event).points);
  }
  assert.deepEqual(points,[3,6,6]);assert.equal(camps.view().totalVotes,15);
  assert.equal(events.normalize({...raw,id:'combo-3',repeatCount:5}),null);
});
test('三平台礼物映射与旧配置兼容，保留自定义回嘴礼物及显式停用',()=>{
  for(const [provider,profile]of Object.entries(GIFT_PROFILES)){
    const map=validateGiftMap({sunglasses:['自定义回嘴']},profile.map);
    assert.deepEqual(map.beer,profile.map.beer);assert.deepEqual(map.flower,profile.map.flower);
    assert.deepEqual(map.sunglasses,['自定义回嘴']);
    const normalizer=new DouyinEvents();
    for(const [gift,names]of Object.entries(map)){
      const event=normalizer.normalize({type:'gift',id:gift,giftName:names[0],repeatCount:2},map,provider);
      assert.equal(event.gift,gift);assert.equal(event.count,2);
    }
  }
  assert.deepEqual(validateGiftMap({sunglasses:['爱心']}).heart,['小心心']);
  assert.deepEqual(validateGiftMap({...GIFT_MAP,heart:[]}).heart,[]);
  assert.throws(()=>validateGiftMap({...GIFT_MAP,heart:['墨镜']}),/只能映射一个/);
});
