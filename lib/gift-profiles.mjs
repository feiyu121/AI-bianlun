export const GIFT_PROFILES=Object.freeze({
 douyin:{map:{heart:['爱心','小心心'],candy:['棒棒糖'],flower:['鲜花','玫瑰'],beer:['啤酒'],sunglasses:['墨镜']}},
 kuaishou:{map:{heart:['小心心'],candy:['棒棒糖'],flower:['玫瑰'],beer:['啤酒'],sunglasses:['甜甜圈']}},
 bilibili:{map:{heart:['小心心'],candy:['辣条'],flower:['小花花'],beer:['打call'],sunglasses:['牛哇牛哇']}}
});
export function displayGiftNames(names,catalog=[]){return names.map(name=>name.startsWith('id:')?(catalog.find(x=>String(x.id)===name.slice(3))?.name||'礼物ID'+name.slice(3)):name);}
