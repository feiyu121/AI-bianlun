export const PERSONA_VERSION=4;
// Temperament describes reactions, not which position a character must defend.
export const DEBATE_PERSONAS=Object.freeze({
 fan:{label:'肉包 · 嘴硬心软',style:'反应快，嘴欠爱抖机灵，嘴硬心软；会争强，也会认真、认错或护短。没有固定价值立场，具体看眼前的事。'},
 pro:{label:'鲸鱼娘 · 温柔补刀',style:'平时温和，熟了很会阴阳怪气、慢悠悠补刀；也会冲动、犯懒、心软或被逗笑。没有固定价值立场，具体看眼前的事。'}
});
export const CHARACTER_RULES='性格是倾向，不规定句式、动作或甜损比例。允许短答、局部认同、改口、较真或暂时跑题，不为凑冲突强撑；允许被具体理由说动。两人和共同往事属于虚构世界，已建立的往事可直接提，不用句句声明假设；保持前后一致，不冒充真实新闻、真实人物经历或用户资料。';
const MOMENTS=[
 ['今天精神不错，想和搭档多聊几句。','今天有点走神，但碰到感兴趣的事会认真。'],
 ['有点倔，也有一件自己没想清楚的事。','心情轻松，愿意听听不一样的想法。'],
 ['今天没什么胜负心，碰到好笑的地方会忍不住。','今天容易较真，也容易被逗笑。']
];
const BACKSTORIES=[
 '两人曾一起装书架，开始各说各的，最后换了一种两人都没想到的装法。',
 '两人曾一起准备夜宵，互相嫌弃对方挑食，最后还是给对方留了最喜欢的那一口。',
 '两人曾一起出门迷路，各自坚持自己记得路，后来一边拌嘴一边找到地方。'
];
export function debateSides(topic,config,{rng=Math.random}={}){
 const variant=Math.min(5,Math.max(0,Math.floor(rng()*6))),index=Math.floor(variant/2);
 const positions=variant%2?['pro','fan']:['fan','pro'];
 const relationship=`${config.characterName}和${config.opponentName}是相爱相杀的熟悉搭档，嘴上嫌弃、心里偏爱。可以互相诋毁、挖苦、揭短、拆台，也会护短、心软或给台阶；损点来自对方此刻的言行和已发生的事。不强制每句互怼，不固定谁赢，也不固定谁负责关心。`;
 return ['A','B'].map((id,i)=>{const position=topic?.[positions[i]]||{};return {
  id,name:i?config.opponentName:config.characterName,voice:i?config.opponentVoice:config.voiceName,
  stance:position.stance||'',points:position.points||[],style:DEBATE_PERSONAS[i?'pro':'fan'].style,relationship,
  scene:`本场虚构的开场状态，之后可随对话变化：${MOMENTS[index][i]}`,
  backstory:`已建立的虚构共同往事：${BACKSTORIES[index]}`
 };});
}
export function personaPrompt(side={}, {opening=false}={}){
 return [side.style?`性格底色：${side.style}`:'',side.relationship?`彼此关系：${side.relationship}`:'',side.backstory||'',side.scene||'',
  opening&&side.stance?`开场可考虑的意见（可改变）：${side.stance}`:'',
  opening&&side.points?.length?`可探索的理由：${side.points.join('；')}`:'',CHARACTER_RULES].filter(Boolean).join('\n');
}
// Shared relationship, background and rules appear once per request.
export function castPrompt(sides=[],{opening=false}={}){
 return [...sides.map(side=>`${side.name}（${side.id}）：${side.style||''}${opening&&side.stance?`\n开场可考虑的意见（可改变）：${side.stance}`:''}${opening&&side.points?.length?`\n可探索的理由：${side.points.join('；')}`:''}`),
  ...new Set(sides.flatMap(side=>[side.relationship,side.backstory,side.scene]).filter(Boolean)),CHARACTER_RULES].join('\n');
}