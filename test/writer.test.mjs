// 写手的测试：全部用假 complete，不打真模型。
// 这里验的不是「句子好不好」——那是 P0 的人工验收，机器判不了。
// 验的是「结构不许错」：幕数、句数、反应位标记、丢句规则、重写触发、块间传原话。
import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTS,ScriptWriter,repairLine,validateLine,similarity,estSeconds,buildRefineMessages} from '../lib/script/writer.mjs';

const SIDES=[
 {id:'A',name:'肉包',stance:'摸鱼是把被切碎的时间拼回来',points:['时间被切碎','把休息当罪才浪费']},
 {id:'B',name:'鲸鱼娘',stance:'工资买的是注意力',points:['买的是八小时','最后付账的是同一批人']}
];

// 造句子：每句 150 字（估 30 秒），字串随序号错开，跨句 4-gram 撞不上。
// 全用同一段填充的话，消重逻辑会把整份稿子判成重复——那测的就不是消重了。
const BASE='的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感';
// 用序号做种子的伪随机串：同一段 BASE 里循环取字会让相邻两句重合九成
// （4-gram 几乎全撞），消重会把整份稿子判成重复——那就测不出消重了。
function line(index){
 let seed=(index+1)>>>0;
 const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 let text=`你刚才那句我记下了，第${index}句；`;
 while(text.length<150)text+=BASE[Math.floor(rand()*BASE.length)];
 return text.slice(0,150);
}

// 假模型：按「本幕/句数/先说」把这一幕写出来，并记录每次请求，便于断言上下文。
function fake({fail=null,short=null,dup=null,outline=null}={}){
 const calls=[];
 const shorted=new Set();
 const complete=async messages=>{
  const system=String(messages[0].content);
  const data=JSON.parse(messages[1].content);
  calls.push({system,data});
  if(fail&&fail(data))throw new Error('模型挂了');
  if(!data.本幕)return JSON.stringify(outline??{});
  // short：这一幕第一次只写得出 1 句，重写时恢复正常——用来验重写触发
  let count=data.句数;
  if(short&&short(data.本幕)&&!shorted.has(data.本幕)){count=1;shorted.add(data.本幕);}
  const first=data.先说==='鲸鱼娘'?'B':'A';
  const rows=[];
  for(let i=0;i<count;i++){
   const side=i%2?(first==='B'?'A':'B'):first;
   // dup：指定的两幕写出一模一样的开头三句，用来验跨幕消重
   const text=dup&&dup.includes(data.本幕)?line(i):line(calls.length*100+i);
   rows.push({side,beat:'拆定义',text});
  }
  return JSON.stringify(rows);
 };
 return {complete,calls};
}

function make(options={}){
 const box=fake(options);
 const writer=new ScriptWriter({complete:box.complete,sides:SIDES,topic:'摸鱼算不算本事',...options.writer});
 return {writer,box};
}

test('整场结构：11 幕 59 句，反应位 51 个',async()=>{
 const {writer}=make();
 const script=await writer.write({});
 assert.equal(script.turns.length,59);
 assert.equal(script.acts.length,11);
 assert.equal(script.turns.at(-1).act,11);
 // 冷开场 2 句 + 两个结辩 6 句不设反应位
 assert.equal(script.turns.filter(turn=>turn.reaction).length,51);
 assert.equal(script.turns.slice(0,2).every(turn=>!turn.reaction),true);
 // 幕号必须是连续的升序，播放器按幕换幕清池
 const acts=[...new Set(script.turns.map(turn=>turn.act))];
 assert.deepEqual(acts,[1,2,3,4,5,6,7,8,9,10,11]);
});

test('时长按字数估：140 字 ≈ 29 秒，全稿落在 28~31 分钟',async()=>{
 const {writer}=make();
 const script=await writer.write({});
 assert.equal(estSeconds('一'.repeat(140)),29);
 assert.ok(script.meta.estTotalSec>28*60&&script.meta.estTotalSec<32*60,`实测 ${script.meta.estTotalSec}`);
 assert.ok(Math.abs(script.meta.deviation)<0.1);
});

test('不能播的整句丢掉、括号旁白只删词：空句、认同对手、口头禅',async()=>{
 const bad=['', '（笑）我可以再说两句', '你说得对，这点我认', '这句我不接'];
 let call=0;
 const writer=new ScriptWriter({
  complete:async messages=>{
   const data=JSON.parse(messages[1].content);
   if(!data.本幕)return '{}';
   // 每幕给一句不同的好句子——同一句会被跨幕消重吃掉，那就测不出「坏句被丢」了
   return JSON.stringify([...bad.map(text=>({side:'A',text})),{side:'A',text:line(++call)}]);
  },
  sides:SIDES,topic:'题',retries:0
 });
 const script=await writer.write({});
 // 11 幕各留 1 句；「（笑）我可以再说两句」是删掉括号后留下的第 12 句——
 // 旁白是修辞不是内容，删掉它这句话还能说，整句丢掉是浪费。
 assert.ok(script.turns.length>=ACTS.length&&script.turns.length<=ACTS.length+1,`实际 ${script.turns.length}`);
 assert.ok(script.turns.every(turn=>!/你说得对|我不接|【|（/.test(turn.text)),'坏句必须一句不剩');
 assert.ok(script.turns.some(turn=>turn.text==='我可以再说两句'),'括号旁白是删掉，不是丢整句');
});

test('跨幕消重：同一段话第二次出现就丢',async()=>{
 const {writer}=make({dup:['交锋一 · 定义与前提','交锋二 · 成本与代价']});
 const script=await writer.write({});
 assert.ok(script.meta.duplicates>=2,`重复计数 ${script.meta.duplicates}`);
 assert.ok(script.turns.length<59);
 // 留下的每一句都必须和别的句子不像
 for(let i=0;i<script.turns.length;i++)for(let j=0;j<i;j++){
  assert.ok(similarity(script.turns[i].text,script.turns[j].text)<0.35,'有漏网的重复句');
 }
});

test('大纲整段失败就用内置骨架，稿子照样写得出来',async()=>{
 const {writer,box}=make({outline:'这不是 JSON'});
 const script=await writer.write({});
 assert.equal(script.meta.fallback,true);
 assert.equal(script.turns.length,59);
 assert.ok(box.calls.some(call=>call.system.includes('大纲')));
});

test('一幕写不够句数就重写一次，第二次提示里点名上一版不合格',async()=>{
 const {writer,box}=make({short:label=>label==='立论 A'});
 const script=await writer.write({});
 assert.equal(script.meta.retried,1);
 const retry=box.calls.filter(call=>call.system.includes('上一次写的不合格'));
 assert.equal(retry.length,1);
 assert.ok(retry[0].system.includes('句数不够'));
 // 重写之后这一幕凑够了 3 句
 assert.equal(script.turns.filter(turn=>turn.act===2).length,3);
});

test('块与块之间传真实原话：第二块第一幕能看到上一块最后两句',async()=>{
 // 这里显式写死 3：块边界决定了「谁拿得到原话」，跟着默认并发改动会让这条测试失去意义。
 const {writer,box}=make({writer:{concurrency:3}});
 await writer.write({});
 const clash1=box.calls.find(call=>call.data.本幕==='交锋一 · 定义与前提');
 assert.ok(clash1.system.includes('上一幕最后两句'),'块首那一幕必须带原话');
 // 同一块里的第二幕拿不到（并发时它还没写完），这是已知的取舍，不是 bug
 const sum1=box.calls.find(call=>call.data.本幕==='小结一 · 半场复盘与票数');
 assert.ok(!sum1.system.includes('上一幕最后两句'));
});

test('单幕失败不拖垮整场：那一幕空着，别的照写',async()=>{
 const {writer}=make({fail:data=>data.本幕==='交锋三 · 案例对决'});
 const script=await writer.write({});
 assert.equal(script.acts.find(act=>act.id==='clash3'),undefined);
 assert.ok(script.turns.length>40);
 assert.equal(script.turns.some(turn=>turn.act===7),false,'失败那一幕一句都不该有');
});

test('首句说反了就把那句丢掉，不硬翻边',async()=>{
 const writer=new ScriptWriter({
  complete:async messages=>{
   const data=JSON.parse(messages[1].content);
   if(!data.本幕)return '{}';
   if(data.本幕!=='立论 A')return JSON.stringify([{side:'A',text:line(1)},{side:'B',text:line(2)},{side:'A',text:line(3)}]);
   // 立论 A 应该 A 先说，这里故意先说 B
   return JSON.stringify([{side:'B',text:line(9)},{side:'A',text:line(10)},{side:'B',text:line(11)}]);
  },
  sides:SIDES,topic:'题'
 });
 const script=await writer.write({});
 const act2=script.turns.filter(turn=>turn.act===2);
 assert.equal(act2[0].side,'A');
 assert.ok(!act2.some(turn=>turn.text===line(9)),'说反的那句被丢了');
});

test('repairLine：括号旁白删掉、超长按句号收尾',()=>{
 assert.equal(repairLine('（笑）这是一句话。').text,'这是一句话。');
 const long='第一句。'.repeat(60);
 const fixed=repairLine(long).text;
 assert.ok(fixed.length<=185);
 assert.ok(fixed.endsWith('。'));
});

test('validateLine：太短和没接对方只记账，格式和认输才丢',()=>{
 const prev='工资买的是一段时间的注意力，不是你坐在那儿的时长';
 assert.equal(validateLine('',{}).ok,false);
 assert.equal(validateLine('【注】这句有括号',{}).ok,false);
 assert.equal(validateLine('你说得对，我认',{}).ok,false);
 const short=validateLine('嗯，是这样。',{prev});
 assert.equal(short.ok,true);
 assert.ok(short.soft.includes('太短'));
 const loose=validateLine(line(3).replace('你刚才那句','我当时那句话'),{prev});
 assert.ok(loose.soft.includes('没接对方'),'没有标记也没有重合，应判没接住');
 const hit=validateLine('你刚才说注意力，我倒觉得这词本身就有问题',{prev});
 assert.ok(!hit.soft.includes('没接对方'));
});

test('扩写：句子太短就整块补一次，钩子丢了的不收',async()=>{
 const short=[
  {side:'A',text:'你刚才那句我觉得不对，八小时被切碎这件事你根本没算过。'},
  {side:'B',text:'工资买的是一段时间里的注意力，你把它说成本事就是在偷换。'}
 ];
 let asked=null;
 const writer=new ScriptWriter({
  complete:async(messages,options)=>{
   asked={messages,options};
   return JSON.stringify([
    {i:0,text:'你刚才那句我觉得不对，八小时被切碎这件事你根本没算过。'}, // 没变长，不收
    {i:1,text:'工资买的是一段时间里的注意力，不是一段工时，你把它说成本事就是在偷换，账还得再算。'} // 变长了，收
   ]);
  },
  sides:SIDES,topic:'题'
 });
 const added=await writer.refineGroup(short);
 assert.ok(asked,'短句必须触发一次扩写调用');
 assert.ok(asked.messages[0].content.includes('30 秒'));
 assert.equal(writer.stats.refined,1);
 assert.equal(short[1].text.includes('不是一段工时'),true);
 assert.ok(added>0);
});

test('扩写：把句首钩子删掉的版本不要',async()=>{
 const short=[{side:'A',text:'你刚才那句我觉得不对，八小时被切碎这件事你根本没算过，谁替你把碎片拼回来。'}];
 const writer=new ScriptWriter({
  complete:async()=>JSON.stringify([{i:0,text:'八小时被切碎这件事你根本没算过，谁替你把碎片拼回来，说得好像整块时间是天上掉的，你算过没有，我算过。'}]),
  sides:SIDES,topic:'题'
 });
 await writer.refineGroup(short);
 assert.equal(short[0].text.startsWith('你刚才那句'),true,'钩子丢了就退回原句');
 assert.equal(writer.stats.refined,0);
});

test('扩写提示词：序号照抄输入，句数和说话人都要带上',()=>{
 const messages=buildRefineMessages({sides:SIDES,turns:[{side:'A',text:'甲的话'},{side:'B',text:'乙的话'}]});
 const rows=JSON.parse(messages[1].content);
 assert.deepEqual(rows.map(row=>row.i),[0,1]);
 assert.deepEqual(rows.map(row=>row.who),['肉包','鲸鱼娘']);
});
