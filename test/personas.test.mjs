import test from 'node:test';
import assert from 'node:assert/strict';
import {debateSides,DEBATE_PERSONAS,personaPrompt,castPrompt} from '../lib/personas.mjs';
import {DEBATE_TOPICS} from '../lib/debate-topics.mjs';
import {DEFAULTS} from '../lib/studio.mjs';
import {SAFETY_PROMPT,defaultSafety} from '../lib/safety.mjs';
import {buildReactionMessages,buildAskMessages,buildSocialBankMessages,buildMentionMessages,buildGiftMessages,validateReaction,validateGift} from '../lib/script/prompts.mjs';

const config={characterName:'肉包',opponentName:'鲸鱼娘',voiceName:'voice-a',opponentVoice:'voice-b'};
test('肉包与鲸鱼娘可以相爱相杀，人物互损与认真认同同时保留',()=>{
 assert.equal(DEFAULTS.characterName,'肉包');
 const sides=debateSides(DEBATE_TOPICS[0],config,{rng:()=>0});
 for(const side of sides){
  assert.match(side.relationship,/相爱相杀/);assert.match(side.relationship,/互相诋毁/);
  assert.match(side.relationship,/护短/);assert.match(side.relationship,/不强制每句互怼/);
  assert.match(personaPrompt(side),/允许被具体理由说动/);
  assert.equal(defaultSafety.check(side.relationship).blocked,false,'人物关系本身应能保存和重播');
 }
 assert.match(sides[0].style,/嘴欠/);assert.match(sides[1].style,/阴阳怪气/);
 assert.match(SAFETY_PROMPT,/允许两位虚构搭档/);
 assert.match(SAFETY_PROMPT,/不对观众或真实人物/);
 assert.equal(validateReaction('你这张嘴比手勤快，活还没干完功劳先领了。').ok,true);
});
test('稳定性格不被题目旧风格覆盖，双方关系使用当前名字',()=>{
 const topic={...DEBATE_TOPICS[0],fan:{...DEBATE_TOPICS[0].fan,style:'每句必须反问'}};
 const sides=debateSides(topic,{...config,characterName:'阿青',opponentName:'小白'},{rng:()=>0});
 assert.equal(sides[0].style,DEBATE_PERSONAS.fan.style);
 assert.equal(sides[1].style,DEBATE_PERSONAS.pro.style);
 assert.equal(sides[0].stance,topic.fan.stance);
 assert.deepEqual(sides.map(side=>side.voice),['voice-a','voice-b']);
 for(const side of sides){assert.match(side.relationship,/阿青.*小白/);assert.match(side.scene,/虚构/);}
});
test('开场意见可以互换，人物性格和音色保持稳定，共同往事只注入一次',()=>{
 const topic=DEBATE_TOPICS[0],first=debateSides(topic,config,{rng:()=>0}),swapped=debateSides(topic,config,{rng:()=>.2});
 assert.equal(first[0].stance,swapped[1].stance);assert.equal(first[1].stance,swapped[0].stance);
 assert.equal(first[0].style,swapped[0].style);assert.equal(first[0].voice,swapped[0].voice);
 const prompt=castPrompt(first);
 assert.equal(prompt.split(first[0].relationship).length-1,1);
 assert.equal(prompt.split(first[0].backstory).length-1,1);
 assert.ok(!prompt.includes(first[0].stance));assert.match(prompt,/不用句句声明假设/);
});
test('每场只抽一次共同情境，换场可变状态而保留性格',()=>{
 let calls=0;const first=debateSides(DEBATE_TOPICS[0],config,{rng:()=>{calls++;return 0;}});
 const next=debateSides(DEBATE_TOPICS[0],config,{rng:()=>0.99});
 assert.equal(calls,1);
 for(let i=0;i<2;i++){assert.equal(first[i].style,next[i].style);assert.notEqual(first[i].scene,next[i].scene);assert.match(personaPrompt(first[i]),/允许被具体理由说动/);}
});
test('五类互动沿用同一人物，跨场社交库排除临场经历和辩题论据',()=>{
 const [side,opponent]=debateSides(DEBATE_TOPICS[0],config,{rng:()=>0});
 const common={side,opponent,topic:'工作安排',turn:{text:'我们先把代价说清楚。'},stanceWords:['八小时']};
 for(const build of [buildReactionMessages,buildAskMessages,buildMentionMessages,buildGiftMessages]){
  const system=build(common)[0].content;
  for(const field of ['style','relationship','scene'])assert.ok(system.includes(side[field]),field+' 应传入人物提示词');
  assert.match(system,/局部认同/);assert.match(system,/不冒充真实新闻/);
  assert.ok(!system.includes('带上这几个词里的一个'));
 }
 const social=buildSocialBankMessages(common)[0].content;
 assert.ok(social.includes(side.style));assert.ok(!social.includes(side.scene));assert.ok(!social.includes(side.points[0]));
 assert.match(social,/不按固定比例/);
 assert.match(buildAskMessages(common)[0].content,/沉默不代表赞同/);
 assert.match(buildGiftMessages(common)[0].content,/可以简短道谢/);
});
test('自然认同和简短道谢可以播出，客服套话仍被拦截',()=>{
 assert.equal(validateReaction('你说得对，这个代价我刚才确实没有想清楚。').ok,true);
 assert.equal(validateReaction('谢谢你的支持，我会继续努力说下去。').ok,false);
 assert.equal(validateGift('谢啦。').ok,true);
});
