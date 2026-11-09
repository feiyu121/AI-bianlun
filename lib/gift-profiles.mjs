export const GIFT_PROFILES=Object.freeze({
 douyin:{map:{sunglasses:['墨镜']}},
 kuaishou:{map:{sunglasses:['甜甜圈']}},
 bilibili:{map:{sunglasses:['牛哇牛哇']}}
});
export function displayGiftNames(names,catalog=[]){return names.map(name=>name.startsWith('id:')?(catalog.find(x=>String(x.id)===name.slice(3))?.name||'礼物ID'+name.slice(3)):name);}
