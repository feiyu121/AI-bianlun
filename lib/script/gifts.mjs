// 礼物槽：剧本是固定的，所以「墨镜买一次抢麦」只能变成「排队到下一个槽」。
// 设计见 DEBATE-SCRIPT.md §6.4。观众体感不变——他花了钱，下一幕就能听到回嘴——
// 但台上不会因为一个礼物就中断正在说的话。
//
// 三条与点名槽不同、必须分开写的地方：
//   1. 归属在**收下那一刻**就定死。墨镜记给「当前说话人的对手」，而排队到幕边界时
//      当前说话人早就换了；到点再算，会变成「送给刚开口那位让他自己反驳自己」。
//   2. 连送不排队 N 次。一次 ×10 排 10 条，整场就成礼物专场，剧本被挤没。
//   3. 礼物优先于点名：花了钱的先上。两者共用一个槽位、一个时间轴。
//
// 纯内存状态机，不碰 IO，时钟可注入（与 reactions.mjs / mention.mjs 同一套路子）。
import {normalizeComment,isInjection} from './reactions.mjs';

export const GIFT_LIMITS=Object.freeze({
 // 队列上限 6：一槽最多消费 1 条，6 条足够撑过六幕；再多说明这一场已经被礼物淹了。
 queueMax:6,
 // 一次礼物最多换 3 次回嘴。×10 墨镜排 10 条，台上一小时都在回同一批人。
 // 超出部分照记账（`dropped`），场控能从日志看出「这位送了十个，只排了三条」。
 maxLinesPerGift:3,
 // 排队超过 6 分钟就不回了。花钱买的是「马上有人回嘴」，
 // 六分钟之后台上早换了两幕，这时候插进去不是回应，是打断。
 ttlMs:6*60*1000,
 // 一个槽只消费 1 条礼物句。两条连着说，就成了一段礼物口播。
 slotMax:1
});

// 只有这三种礼物能换成一句台词。其余（爱心/鲜花/棒棒糖/啤酒）在剧本模式里只记账：
// 正赛没有「谁赢了」这个结算点，票数要等中场选辩题的投票窗，见 §6.4。
export const GIFT_LINES=Object.freeze({
 sunglasses:{label:'墨镜',kind:'interject'}
});

export class GiftQueue {
 constructor({now=Date.now,limits={},log=()=>{}}={}){
  this.now=now;
  this.log=log;
  this.limits={...GIFT_LIMITS,...limits};
  this.items=[];
  this.stats={heard:0,queued:0,played:0,released:0,retried:0,dropped:0,expired:0,full:0,neutral:0};
 }

 get size(){return this.items.length;}
 get pending(){return this.items.length;}

 // 收下一个礼物事件。返回 {queued, count, item?}。
 // side 由调用方算好——只有播放器知道「此刻在说话的是谁」，队列不该去猜。
 add({gift='thanks',count=1,name='观众',side='A',at=this.now(),userId='',giftName=''}={}){
  this.stats.heard++;
  const rule=GIFT_LINES[gift];
  const coin=Math.max(1,Math.trunc(Number(count)||1));
  if(!rule){
   // 计票类礼物在这里只是「知道了」：剧本场不结算胜负，票数进中场投票窗才有意义。
   this.stats.neutral++;
   return {queued:false,count:coin,reason:'neutral'};
  }
  const lines=Math.min(this.limits.maxLinesPerGift,coin);
  if(coin>lines){
   this.stats.dropped+=coin-lines;
   this.log(`${rule.label} ×${coin}：一次最多换 ${lines} 次回嘴，剩下 ${coin-lines} 个只记账`);
  }
  const queued=[];
  for(let i=0;i<lines;i++){
   if(this.items.length>=this.limits.queueMax){
    this.stats.full++;
    this.stats.dropped+=lines-i;
    this.log(`${rule.label}：队列已满（${this.limits.queueMax} 条），这次的 ${lines-i} 条作废`);
    break;
   }
   const item={
    userId:String(userId||name||''),name:String(name||'观众').slice(0,24),
    gift,label:rule.label,count:coin,side:side==='B'?'B':'A',at,
    // 同一批连送的这几条，除了序号没有别的差别——写手据此换开头，不至于三条一个腔调。
    seq:i+1,total:lines,
    pending:null,ready:'',failed:'',settled:false
   };
   this.items.push(item);
   queued.push(item);
   this.stats.queued++;
  }
  return {queued:queued.length>0,count:coin,lines:queued.length,items:queued};
 }

 // 到点取一条。取出来就算离开队列（悲观），写不出来再 release/requeue。
 plan({max=this.limits.slotMax}={}){
  const now=this.now();
  const stale=this.items.filter(item=>now-item.at>this.limits.ttlMs);
  if(stale.length){
   this.items=this.items.filter(item=>!stale.includes(item));
   this.stats.expired+=stale.length;
   this.log(`${stale.length} 条礼物等待超时，不再回`);
  }
  const picked=this.items.slice(0,Math.max(0,max));
  this.items=this.items.filter(item=>!picked.includes(item));
  return picked;
 }

 commit(item){
  if(!item)return this.stats.played;
  this.stats.played++;
  return this.stats.played;
 }

 release(item){
  if(!item)return 0;
  this.stats.released++;
  return this.stats.released;
 }

 // 到点还没写好：排回队首等下一幕。与点名同一个理由——
 // 这是「晚一幕」不是「降级」，钱花了不能因为模型慢就白花。
 requeue(item){
  if(!item)return 0;
  if(this.now()-item.at>this.limits.ttlMs){this.stats.expired++;return 0;}
  if(this.items.includes(item))return 0;
  this.items.unshift(item);
  return this.items.length;
 }

 // 写废了（拿到空串或被校验判掉）：清掉写手状态，下一幕重写。
 // 与点名不同——点名写废就退配额（他已经问过、也已经被回答过一轮）；
 // 礼物是花了钱的，写废不能算他的。但要清 pending，否则下一幕拿的还是那条写废的旧承诺。
 retry(item){
  if(!item)return 0;
  if(this.now()-item.at>this.limits.ttlMs){this.stats.expired++;return 0;}
  item.pending=null;item.ready='';item.failed='';item.settled=false;
  this.stats.retried=(this.stats.retried||0)+1;
  return this.requeue(item);
 }

 flush(){
  const count=this.items.length;
  this.items=[];
  return count;
 }

 reset(){
  this.items=[];
  this.stats={heard:0,queued:0,played:0,released:0,retried:0,dropped:0,expired:0,full:0,neutral:0};
 }

 snapshot(){
  return {
   queued:this.items.length,
   next:this.items[0]?{name:this.items[0].name,label:this.items[0].label,side:this.items[0].side}:null,
   stats:{...this.stats}
  };
 }
}

export default GiftQueue;
