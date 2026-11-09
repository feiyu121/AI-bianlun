import {createHash} from 'node:crypto';
export const GIFT_MAP=Object.freeze({sunglasses:['墨镜']});
export function roomNumber(value){
 if(typeof value!=='string')throw new Error('请填写直播间链接或直播间号');
 const t=value.normalize('NFKC').trim();if(/^\d{1,20}$/.test(t))return t;
 const found=t.match(/https?:\/\/[^\s\[\]\(\)<>"'，。；、【】《》（）]+/i);
 const candidate=(found?found[0]:t).replace(/[)\]}!！?？]+$/,'');
 let u;try{u=new URL(/^https?:/i.test(candidate)?candidate:'https://'+candidate);}catch{throw new Error('未识别到抖音直播链接，可粘贴完整分享文字或数字直播间号');}
 if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port)throw new Error('直播间链接格式不正确');
 if(u.hostname==='live.douyin.com'){
  if(/^\/\d{1,20}\/?$/.test(u.pathname))return u.pathname.split('/')[1];
  const rid=u.searchParams.get('web_rid');if(rid&&/^\d{1,20}$/.test(rid))return rid;
 }
 const short=u.hostname==='v.douyin.com'&&/^\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname);
 const reflow=['webcast.amemv.com','webcast.iesdouyin.com','live.douyin.com'].includes(u.hostname)&&/^\/[^?#]*(?:reflow|webcast|room)\//.test(u.pathname);
 if(short||reflow){u.protocol='https:';u.hash='';return u.href;}
 if(['www.douyin.com','www.iesdouyin.com'].includes(u.hostname)&&u.pathname.startsWith('/user/'))throw new Error('这是个人主页链接，请复制直播间的分享链接');
 throw new Error('未识别到直播间：支持数字房间号、live.douyin.com 链接或 v.douyin.com 手机分享短链');
}
export function validateGiftMap(input=GIFT_MAP){
 const out={};for(const key of Object.keys(GIFT_MAP)){const list=input[key];if(!Array.isArray(list)||list.length>20||!list.every(x=>typeof x==='string'&&x.trim().length>0&&x.trim().length<=32))throw new Error('礼物映射格式无效');out[key]=[...new Set(list.map(x=>x.trim()))];}
 const all=Object.values(out).flat();if(new Set(all).size!==all.length)throw new Error('同一个礼物只能映射一个技能');return out;
}
const txt=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export class DouyinEvents{
 constructor(saved={},now=()=>Date.now()){this.now=now;this.seen=new Map(saved.seen||[]);this.combos=new Map(saved.combos||[]);this.prune();}
 prune(){const limit=this.now()-86400000;for(const[k,t]of this.seen)if(t<limit)this.seen.delete(k);for(const[k,v]of this.combos)if(v.at<limit)this.combos.delete(k);while(this.seen.size>4000)this.seen.delete(this.seen.keys().next().value);while(this.combos.size>2000)this.combos.delete(this.combos.keys().next().value);}
 normalize(raw,map=GIFT_MAP,source='douyin'){
  if(!raw||!['comment','like','gift','enter'].includes(raw.type))throw new Error('事件类型无效');
  const room=txt(String(raw.room||''),32),uid=txt(String(raw.userId||''),80),name=txt(raw.name,24)||'路过的朋友',content=txt(raw.text,160),giftName=txt(raw.giftName,32),giftId=txt(String(raw.giftId||''),32),group=txt(String(raw.groupId||''),80),id=txt(String(raw.id||''),128);
  if(!id||id==='0')throw new Error('消息缺少稳定 ID');const key=source+':'+room+':'+raw.type+':'+id;if(this.seen.has(key))return null;
  const e={type:raw.type,id:'dy-'+createHash('sha256').update(key).digest('hex').slice(0,40),source,name,userId:uid};let pendingCombo;
  if(raw.type==='comment'){if(!content)throw new Error('弹幕为空');e.text=content;}
  if(raw.type==='like'){if(!Number.isSafeInteger(raw.count)||raw.count<1||raw.count>10000)throw new Error('点赞数量无效');e.count=raw.count;}
  if(raw.type==='gift'){
   if(!giftName)throw new Error('礼物名称为空');const count=raw.repeatCount??1;if(!Number.isSafeInteger(count)||count<1||count>10000)throw new Error('礼物数量无效');
   e.gift=Object.entries(map).find(([,a])=>a.includes(giftName)||a.includes('id:'+giftId))?.[0]||'thanks';e.giftName=giftName;e.count=count;e.triggerSkill=true;
   if(raw.combo){if(!group||group==='0')throw new Error('连击缺少 groupId，已忽略以防重复');const ck=[source,room,uid,giftId||giftName,group].join(':');const before=this.combos.get(ck)?.count||0;e.count=Math.max(0,count-before);e.triggerSkill=before===0;pendingCombo=[ck,{count:Math.max(before,count),at:this.now()}];}
  }
  this.seen.set(key,this.now());if(pendingCombo)this.combos.set(...pendingCombo);this.prune();return e.count===0?null:e;
 }
 serialize(){this.prune();return {seen:[...this.seen],combos:[...this.combos]};}
}
