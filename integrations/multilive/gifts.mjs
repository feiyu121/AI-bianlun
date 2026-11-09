export function extractGifts(value,context='',depth=0,found=new Map()){
 if(depth>9||found.size>=1000||!value||typeof value!=='object')return [...found.values()];
 if(!Array.isArray(value)){const explicit=value.giftId??value.gift_id,id=explicit??(/gift|present/i.test(context)?value.id:undefined),name=value.giftName??value.gift_name??(/gift|present/i.test(context)?value.name:undefined);if((typeof id==='number'||typeof id==='string')&&typeof name==='string'&&name.trim()&&name.length<=32&&/^[a-zA-Z0-9_-]{1,32}$/.test(String(id)))found.set(String(id),{id:String(id),name:name.trim()});}
 for(const [key,item]of Object.entries(value).slice(0,2000))if(item&&typeof item==='object')extractGifts(item,context+'/'+key,depth+1,found);
 return [...found.values()];
}
