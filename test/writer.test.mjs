// 写手的测试：全部用假 complete，不打真模型。
// 这里验的不是「句子好不好」——那是 P0 的人工验收，机器判不了。
// 验的是「结构不许错」：幕数、句数、反应位标记、丢句规则、重写触发、块间传原话。
import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTS,ScriptWriter,repairLine,validateLine,similarity,estSeconds,buildRefineMessages,LINE_LIMITS,isRedundant} from '../lib/script/writer.mjs';
import {PERSONA_VERSION} from '../lib/personas.mjs';

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
 while(text.length<90)text+=BASE[Math.floor(rand()*BASE.length)];
 return text.slice(0,90);
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

test('写稿进度依次报告大纲、分幕完成数与合并，累计台词与结果一致',async()=>{
 const events=[],logs=[];
 const {writer}=make({writer:{onProgress:event=>events.push(event),log:message=>logs.push(message)}});
 const script=await writer.write();
 assert.equal(events[0].phase,'outline');assert.equal(events.some(e=>e.phase==='refine'),false);assert.equal(events.at(-1).phase,'assemble');
 assert.deepEqual(events.filter(e=>e.completedActs!==undefined).map(e=>e.completedActs),Array.from({length:ACTS.length},(_,i)=>i+1));
 assert.equal(events.at(-1).turns,script.turns.length);assert.equal(events.at(-1).chars,script.turns.reduce((sum,t)=>sum+t.text.length,0));
 assert.equal(events.at(-1).estTotalSec,script.meta.estTotalSec);assert.ok(logs.some(line=>line.includes('第 5/5 幕')));
});

test('进度能显示同一幕重试，缺少有效句不会伪装成一次成功',async()=>{
 const events=[],logs=[];const {writer}=make({fail:(()=>{let once=false;return data=>Boolean(data.本幕)&&!once&&(once=true);})(),writer:{onProgress:event=>events.push(event),log:message=>logs.push(message)}});
 await writer.write();assert.ok(events.some(e=>e.phase==='act'&&e.act===1&&e.attempt===2));assert.ok(logs.some(line=>line.includes('准备重试')));
});

test('取消写稿立即退出，不重试模型或生成后续分幕和回退大纲',async()=>{
 const controller=new AbortController(),logs=[];let calls=0;
 const writer=new ScriptWriter({signal:controller.signal,log:message=>logs.push(message),complete:async()=>{calls++;controller.abort(new Error('手动停止'));throw new Error('请求取消');}});
 await assert.rejects(writer.write(),/手动停止/);assert.equal(calls,1);assert.ok(!logs.some(line=>line.includes('内置幕骨架')));
});

test('整场结构：五段参考24轮，允许自然长短变化',async()=>{
 const {writer}=make();
 const script=await writer.write({});
 assert.equal(script.turns.length,24);
 assert.equal(script.acts.length,5);
 assert.equal(script.turns.at(-1).act,5);
 // 冷开场 2 句 + 两个结辩 6 句不设反应位
 assert.equal(script.turns.filter(turn=>turn.reaction).length,22);
 assert.equal(script.turns.slice(0,2).every(turn=>!turn.reaction),true);
 // 幕号必须是连续的升序，播放器按幕换幕清池
 const acts=[...new Set(script.turns.map(turn=>turn.act))];
 assert.deepEqual(acts,[1,2,3,4,5]);
});

test('时长按字数估：140 字 ≈ 29 秒，参考稿约七分钟',async()=>{
 const {writer}=make();
 const script=await writer.write({});
 assert.equal(estSeconds('一'.repeat(140)),29);
 assert.ok(script.meta.estTotalSec>=6*60&&script.meta.estTotalSec<=8*60,`实测 ${script.meta.estTotalSec}`);
 assert.ok(Math.abs(script.meta.deviation)<0.1);
});

test('不可播内容丢弃，旁白剥除，局部认同保留',async()=>{
 const bad=['', '（笑）我可以再说两句', '你说得对，这点我认', '我是一个AI'];
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
 assert.ok(script.turns.length>=ACTS.length,`实际 ${script.turns.length}`);
 assert.ok(script.turns.some(turn=>turn.text.includes('你说得对')));
 assert.ok(script.turns.every(turn=>!/我是一个AI|【|（/.test(turn.text)),'坏句必须一句不剩');
 assert.ok(script.turns.some(turn=>turn.text==='我可以再说两句'),'括号旁白是删掉，不是丢整句');
});

test('跨幕消重：同一段话第二次出现就丢',async()=>{
 const {writer}=make({dup:['交锋','换个角度']});
 const script=await writer.write({});
 assert.ok(script.meta.duplicates>=2,`重复计数 ${script.meta.duplicates}`);
 assert.ok(script.turns.length<24);
 // 留下的每一句都必须和别的句子不像
 for(let i=0;i<script.turns.length;i++)for(let j=0;j<i;j++){
  assert.ok(similarity(script.turns[i].text,script.turns[j].text)<0.35,'有漏网的重复句');
 }
});

test('大纲整段失败就用内置骨架，稿子照样写得出来',async()=>{
 const {writer,box}=make({outline:'这不是 JSON'});
 const script=await writer.write({});
 assert.equal(script.meta.fallback,true);
 assert.equal(script.turns.length,24);
 assert.ok(box.calls.some(call=>call.system.includes('大纲')));
});

test('一幕自然写短也保留，不为凑够参考轮数重写',async()=>{
 const {writer,box}=make({short:label=>label==='接着聊'});
 const script=await writer.write({});
 assert.equal(script.meta.retried,0);
 const retry=box.calls.filter(call=>call.system.includes('上一次写的不合格'));
 assert.equal(retry.length,0);

 // 重写之后这一幕凑够了 3 句
 assert.equal(script.turns.filter(turn=>turn.act===2).length,1);
});

test('块与块之间传真实原话：第二块第一幕能看到上一块最后两句',async()=>{
 // 这里显式写死 3：块边界决定了「谁拿得到原话」，跟着默认并发改动会让这条测试失去意义。
 const {writer,box}=make({writer:{concurrency:3}});
 await writer.write({});
 const clash1=box.calls.find(call=>call.data.本幕==='换个角度');
 assert.ok(clash1.system.includes('上一幕最后几句'),'块首那一幕必须带原话');
 // 同一块里的第二幕拿不到（并发时它还没写完），这是已知的取舍，不是 bug
 const sum1=box.calls.find(call=>call.data.本幕==='尾声');
 assert.ok(!sum1.system.includes('上一幕最后几句'));
});

test('单幕失败不拖垮整场：那一幕空着，别的照写',async()=>{
 const {writer}=make({fail:data=>data.本幕==='交锋'});
 const script=await writer.write({});
 assert.equal(script.acts.find(act=>act.id==='clash1'),undefined);
 assert.ok(script.turns.length>10);
 assert.equal(script.turns.some(turn=>turn.act===3),false,'失败那一幕一句都不该有');
});

test('默认不分配谁先开口，B 起话也保留',async()=>{
 const writer=new ScriptWriter({
  complete:async messages=>{
   const data=JSON.parse(messages[1].content);
   if(!data.本幕)return '{}';
   if(data.本幕!=='接着聊')return JSON.stringify([{side:'A',text:line(1)},{side:'B',text:line(2)},{side:'A',text:line(3)}]);
   // 接着聊 · 1 应该 A 先说，这里故意先说 B
   return JSON.stringify([{side:'B',text:line(9)},{side:'A',text:line(10)},{side:'B',text:line(11)}]);
  },
  sides:SIDES,topic:'题'
 });
 const script=await writer.write({});
 const act2=script.turns.filter(turn=>turn.act===2);
 assert.equal(act2[0].side,'B');
 assert.ok(act2.some(turn=>turn.text===line(9)),'自然起话不应丢句');
});

test('repairLine：括号旁白删掉、超长按句号收尾',()=>{
 assert.equal(repairLine('（笑）这是一句话。').text,'这是一句话。');
 const long='第一句。'.repeat(60);
 const fixed=repairLine(long).text;
 assert.ok(fixed.length<=LINE_LIMITS.maxChars);
 assert.ok(fixed.endsWith('。'));
});

test('validateLine：自然短答与局部认同通过，无需固定引用词',()=>{
 const prev='工资买的是一段时间的注意力，不是你坐在那儿的时长';
 assert.equal(validateLine('',{}).ok,false);
 assert.equal(validateLine('【注】这句有括号',{}).ok,false);
 assert.equal(validateLine('你说得对，我认',{}).ok,true);
 const short=validateLine('嗯，是这样。',{prev});
 assert.equal(short.ok,true);
 assert.deepEqual(short.soft,[]);
 const loose=validateLine(line(3).replace('你刚才那句','我当时那句话'),{prev});
 assert.deepEqual(loose.soft,[],'不靠词面重合强制使用固定接话句式');
 const hit=validateLine('你刚才说注意力，我倒觉得这词本身就有问题',{prev});
 assert.ok(!hit.soft.includes('没接对方'));
});

test('扩写：内容不足时补充有展开空间的发言',async()=>{
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

test('扩写：含义衔接保留即可，允许改变句首钩子',async()=>{
 const short=[{side:'A',text:'你刚才那句我觉得不对，八小时被切碎这件事你根本没算过，谁替你把碎片拼回来。'}];
 const writer=new ScriptWriter({
  complete:async()=>JSON.stringify([{i:0,text:'八小时被切碎这件事你根本没算过，谁替你把碎片拼回来，说得好像整块时间是天上掉的，你算过没有，我算过。'}]),
  sides:SIDES,topic:'题'
 });
 await writer.refineGroup(short);
 assert.equal(short[0].text.startsWith('八小时'),true,'可以调整措辞');
 assert.equal(writer.stats.refined,1);
});

test('扩写提示词：序号照抄输入，句数和说话人都要带上',()=>{
 const messages=buildRefineMessages({sides:SIDES,turns:[{side:'A',text:'甲的话'},{side:'B',text:'乙的话'}]});
 const rows=JSON.parse(messages[1].content);
 assert.deepEqual(rows.map(row=>row.i),[0,1]);
 assert.deepEqual(rows.map(row=>row.who),['肉包','鲸鱼娘']);
});

test('默认逐幕承接前一幕真实原话，人物完整写入剧本',async()=>{
 const sides=SIDES.map(side=>({...side,style:'会认真想，也愿意认错',relationship:'熟悉的搭档',scene:'本场虚构状态：有些犹豫'}));
 const {writer,box}=make({writer:{sides}});
 const script=await writer.write();
 const acts=box.calls.filter(call=>call.data.本幕);
 assert.equal(acts.length,ACTS.length);
 for(let i=1;i<acts.length;i++){
  const previous=script.turns.filter(turn=>turn.act===i).at(-1);
  assert.ok(acts[i].system.includes(previous.text),'下一幕应看见前一幕最后一句');
  for(const field of ['style','relationship','scene'])assert.ok(acts[i].system.includes(sides[0][field]));
 }
 assert.deepEqual(script.sides.map(({style,relationship,scene})=>({style,relationship,scene})),sides.map(({style,relationship,scene})=>({style,relationship,scene})));
 assert.equal(script.meta.personaVersion,PERSONA_VERSION);
 assert.ok(acts.at(-1).system.includes(script.turns[0].text),'尾声仍能看到开场留下的话，而非只保留最后四句');
});

test('回扣旧话并增加新结论不会被文字消重误删',async()=>{
 const anchor='你当时说只要把工作做完就行，可后来连交接的时间也省了，留下的人总得知道下一步怎么办。';
 const callback=anchor+'现在我把交接清单也补上了，你是不是可以放心一起走了？';
 assert.equal(isRedundant(anchor,anchor),true);assert.equal(isRedundant(callback,anchor),false);
 const writer=new ScriptWriter({sides:SIDES,retries:0,complete:async messages=>{
  const data=JSON.parse(messages[1].content);if(!data.本幕)return '{}';
  return JSON.stringify([{side:'A',text:data.本幕===ACTS[0].label?anchor:callback},{side:'B',text:'行吧。'}]);
 }});
 const script=await writer.write({acts:ACTS.slice(0,2)});
 assert.ok(script.turns.some(turn=>turn.text===callback));assert.equal(script.meta.duplicates,0);
});

test('参考轮数可拆短问短答，相同短回声跨幕仍保留',async()=>{
 const writer=new ScriptWriter({sides:SIDES,topic:'题',retries:0,complete:async messages=>{
  const data=JSON.parse(messages[1].content);
  if(!data.本幕)return '{}';
  return JSON.stringify([{side:'A',text:'为什么？'},{side:'B',text:'你说得对。'},{side:'A',text:'那换个条件呢？'},{side:'B',text:'这个我再想想。'}]);
 }});
 const script=await writer.write({acts:[ACTS[0],ACTS.at(-1)]});
 assert.equal(script.turns.length,8);
 assert.equal(script.turns.filter(turn=>turn.text==='你说得对。').length,2);
 assert.equal(script.meta.duplicates,0);assert.equal(writer.stats.refined,0);
});

test('总预算已够不再扩写；不足时只补实质内容并保持原顺序',async()=>{
 const calls=[];
 const writer=new ScriptWriter({sides:SIDES,complete:async messages=>{
  const rows=JSON.parse(messages[1].content);calls.push(rows);
  return JSON.stringify(rows.map(row=>({i:row.i,text:row.text+'具体还得看看交接时谁能做什么，别先替别人答应下来。'})));
 }});
 const long=line(900);
 assert.equal(await writer.refineGroup([{side:'A',text:long}],{targetSeconds:20}),0);
 assert.equal(calls.length,0);
 const turns=[{side:'A',text:'为什么？'},{side:'B',text:line(901).slice(0,45)},{side:'A',text:line(902).slice(0,70)},{side:'B',text:'你说得对。'}];
 const originals=turns.map(turn=>turn.text);
 await writer.refineGroup(turns,{targetSeconds:120});
 assert.deepEqual(calls[0].map(row=>row.text),[originals[1],originals[2]],'不能按长度排序打乱对话');
 assert.equal(turns[0].text,originals[0]);assert.equal(turns[3].text,originals[3]);
 assert.ok(turns[1].text.length>originals[1].length);assert.ok(turns[2].text.length>originals[2].length);
});
