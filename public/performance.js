// Shared by the writer, audio renderer and browser. Directions never enter spoken text.
export const EXPRESSIONS=Object.freeze(['neutral','smile','teasing','thinking','surprised','annoyed','embarrassed','serious','sad']);
export const LISTENER_REACTIONS=Object.freeze(['attentive','amused','skeptical','caught','softened','none']);
const LEGACY={neutral:'neutral',focus:'neutral',happy:'smile',excited:'smile',love:'smile',smug:'teasing',question:'thinking',surprised:'surprised',shock:'surprised',angry:'annoyed',sad:'sad',dizzy:'embarrassed',shy:'embarrassed'};
const EMOTIONS={neutral:'neutral',smile:'happy',teasing:'happy',thinking:'neutral',surprised:'surprised',annoyed:'angry',embarrassed:'neutral',serious:'neutral',sad:'sad'};
const DIRECTIONS={neutral:'自然接话，不刻意表演。',smile:'带一点笑意，轻松说话，不夸张。',teasing:'像对熟悉的搭档轻轻补刀，克制地调侃，不用感谢观众的口气。',thinking:'边想边说，语气有少量迟疑，不机械拖长。',surprised:'短暂意外，随后正常接话，不尖叫。',annoyed:'略带不服气，认真顶一句，不大吼，不撒娇。',embarrassed:'被熟人揭短，稍微心虚，仍想嘴硬。',serious:'收起玩笑，认真平实地说，不播音、不说教。',sad:'有一点失落，轻声说清楚，不哭腔。'};
export function performanceFields(value={}){
 const out={};
 if(EXPRESSIONS.includes(value.expression))out.expression=value.expression;
 if(LISTENER_REACTIONS.includes(value.listenerReaction))out.listenerReaction=value.listenerReaction;
 if(typeof value.delivery==='string'){
  const delivery=value.delivery.replace(/[\x00-\x1f\x7f]/gu,' ').trim().slice(0,80);
  if(delivery)out.delivery=delivery;
 }
 if(Number.isFinite(value.pauseBeforeMs))out.pauseBeforeMs=Math.max(0,Math.min(800,Math.round(value.pauseBeforeMs)));
 if(Object.hasOwn(LEGACY,value.emotion))out.emotion=value.emotion;
 return out;
}
export function resolvePerformance(turn={}){
 const fields=performanceFields(turn),text=String(turn.text||'');
 // Conservative fallback for old scripts: punctuation alone carries no emotional meaning.
 let expression=fields.expression||LEGACY[fields.emotion];
 if(!expression){
  expression=/才怪|得了吧|你最勤快|你可真|上次谁|少装|借口/u.test(text)?'teasing':
   /是我错|怪我|被你发现|别提了/u.test(text)?'embarrassed':
   /说真的|认真说|我承认/u.test(text)?'serious':'neutral';
 }
 return {expression,emotion:EMOTIONS[expression],delivery:fields.delivery||DIRECTIONS[expression],
  listenerReaction:fields.listenerReaction||(expression==='teasing'?'caught':expression==='serious'?'attentive':'none'),pauseBeforeMs:fields.pauseBeforeMs??0};
}
export const PERFORMANCE_PROMPT='可按语境为少量台词添加独立表演字段：expression 从 neutral/smile/teasing/thinking/surprised/annoyed/embarrassed/serious/sad 选；delivery 为最多80字的简短说话方式；listenerReaction 从 attentive/amused/skeptical/caught/softened/none 选，表示对方听这句的无声反应；pauseBeforeMs 为0～800的接话前停顿毫秒。多数句正常接话，省略字段即可；停顿只留给真正的迟疑或包袱，不每句加动作，不固定谁补刀或谁出糗。表演字段与 text 分开，不把动作、语气说明和笑声标签写进朗读文本。';
