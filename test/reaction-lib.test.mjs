import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ReactionLibrary,similarity,dedupeLines,tooClose,LIB_VERSION} from '../lib/script/reaction-lib.mjs';

const A={id:'A',name:'鱼丸',stance:'摸鱼是本事',style:'爱自嘲，句子短'};
const B={id:'B',name:'鲸鱼娘',stance:'摸鱼是偷',style:'冷静，爱算账'};

// 按调用顺序返回预设文本；用尽就返回空数组。
function server(...replies){
 let index=0;
 const calls=[];
 const complete=async(messages,options)=>{
  calls.push({messages,options});
  return index<replies.length?replies[index++]:'[]';
 };
 return {complete,calls};
}

function seeded(seed=7){
 let state=seed;
 return ()=>{state=(state*1664525+1013904223)%4294967296;return state/4294967296;};
}

test('相似度与去重：近乎一样的句子只留一句，先来的优先',()=>{
 assert.equal(similarity('夸我没用，我今天是来算账的','夸我没用，我今天是来算账的'),1);
 assert.ok(similarity('夸我没用，我今天是来算账的','夸我没用，我今天是来收账的')>0.5);
 assert.ok(similarity('夸我没用，我今天是来算账的','笑得这么齐，心里都有数')<0.2);
 const kept=dedupeLines(['夸我没用，我今天是来算账的','夸我没用，我今天是来收账的','笑得这么齐，心里都有数']);
 assert.equal(kept.length,2);
 assert.equal(kept[0],'夸我没用，我今天是来算账的');
 assert.deepEqual(dedupeLines(['一','二','三'],{max:2}),['一','二']);
});

test('跨方去重：同一句要挡，同一个开头不挡',()=>{
 // 本方内部按「前 5 字撞车」拦；跨方只按相似度拦——
 // 两个人一起笑，开头都是「笑得这么……」，按字面拦会把整批判死（实测 B 方 20 条被拦 17 条）。
 const kept=dedupeLines(['笑得这么齐，心里都有数','笑得这么齐，是心虚了吗','账不认脸，只认数'],{block:['笑得这么齐，心里都有数']});
 assert.deepEqual(kept,['笑得这么齐，是心虚了吗','账不认脸，只认数']);
 assert.equal(tooClose('笑得这么齐，心里都有数','笑得这么齐，是心虚了吗'),true,'本方内部仍按开头拦');
 assert.equal(tooClose('夸我没用，我今天是来算账的','账不认脸，只认数'),false);
});

test('社交库：校验丢掉的句子要补写，直到写满',async()=>{
 const first=['夸我没用，我今天是来算账的','笑得这么齐，心里都有数','嘘我也得说，这话我不收回',
  '夸我没用，我今天是来算账的','摸鱼这事我不让','超长缓存内容'.repeat(20)];
 const second=['起哄归起哄，我照旧这么讲','怕你们笑，我更得把话说完','你们越喊，我越站得住'];
 const fake=server(JSON.stringify(first),JSON.stringify(second));
 const lib=new ReactionLibrary({sides:[A],complete:fake.complete,rng:seeded()});
 const total=await lib.buildSocial({count:6});
 assert.equal(total,6,'3 条合格 + 3 条补写');
 const dropped=lib.snapshot().stats.dropped;
 assert.equal(dropped,3,'重复 1 + 太短（还沾了摸鱼）1 + 太长 1');
 assert.equal(fake.calls.length,2,'第一次没写满，必须再要一次');
 assert.match(fake.calls[1].messages[0].content,/已经有了/,'补写时要带上已有的，否则会一直重复');
});

test('社交库：三次都写不满就停手，不无限重试',async()=>{
 const fake=server('["我是一个AI","谢谢你的支持"]','[]','[]');
 const lib=new ReactionLibrary({sides:[A],complete:fake.complete});
 const total=await lib.buildSocial({count:10,attempts:3});
 assert.equal(total,0);
 assert.equal(fake.calls.length,3);
});

test('反问单元：一次不过要重写，两次都不过就空着（不阻塞整库）',async()=>{
 const bad='抱歉我不能';
 const good=JSON.stringify({question:'在座的，谁没在周报里编过字数？',echo:'刚有人说了【词】，这账就好算了。',echoPlain:'行，有人认了，那我就当你们都认。',quiet:'没声了，那这事就算默认了。'});
 const fake=server(bad,good,bad,bad);
 const lib=new ReactionLibrary({sides:[A,B],complete:fake.complete});
 const total=await lib.buildAsk({topic:'摸鱼是本事还是偷',turns:{A:'摸鱼是本事',B:'摸鱼是偷'},count:1,attempts:2});
 assert.equal(total,1,'A 第二次成功，B 两次都失败');
 assert.equal(lib.snapshot().sides.B.ask,0);
 assert.equal(lib.snapshot().stats.retries,3);
 assert.match(fake.calls[0].messages[0].content,/摸鱼是本事/,'反问要贴着这一方的话头往下递');
});

test('取用：一轮之内不重复，用完才重洗',()=>{
 const lib=new ReactionLibrary({sides:[A],rng:seeded(3)});
 lib.fromJSON({version:LIB_VERSION,sides:{A:{social:['一','二','三','四','五'],ask:[]}}});
 const seen=[];
 for(let i=0;i<5;i++)seen.push(lib.pick('A'));
 assert.equal(new Set(seen).size,5,'5 条必须全用到才允许重复');
 assert.ok(lib.pick('A'));
 assert.equal(lib.snapshot().sides.A.unused,0);
 assert.equal(lib.pick('空方'),null,'没有库时返回 null，由调用方降级');
 assert.equal(lib.snapshot().stats.missed,1);
});

test('占位符替换：观众那个词进不了提示词，只进这一句',()=>{
 const lib=new ReactionLibrary({sides:[A]});
 const unit={question:'谁没编过字数？',echo:'好，有人说【词】，那就对了。',echoPlain:'有人答了，我当你们默认。',quiet:'没人吭声，那就是都干过。'};
 assert.equal(lib.fillEcho(unit,'我也编过'),'好，有人说我也编过，那就对了。');
 assert.equal(lib.fillEcho(unit,'<b>【词】</b>'),'好，有人说b词/b，那就对了。','尖括号和占位符都要剥掉，剩下的按字面念');
 assert.equal(lib.fillEcho(unit,''),unit.echoPlain,'没人答就走预渲染那条');
 assert.equal(lib.fillEcho(null,'x'),'');
});

test('焐热：没给 render 直接报错，不静默跳过',async()=>{
 const lib=new ReactionLibrary({sides:[A]});
 await assert.rejects(()=>lib.warm({}),/缺少 render/);
});

test('焐热（带 render）：2 社交 + 1 组反问 = 5 条音频，echo 不焐',async()=>{
 const calls=[];
 let count=0;
 const lib=new ReactionLibrary({sides:[A],render:async(item,settings)=>{
  calls.push({text:item.text,voice:settings.voiceName});
  count++;
  if(count===3)throw new Error('合成超时');
  return {cached:count===1};
 }});
 lib.fromJSON({version:LIB_VERSION,sides:{A:{social:['夸我没用，我今天是来算账的','笑得这么齐，心里都有数'],ask:[{
  question:'谁没编过字数？',echo:'好，有人说【词】，那就对了。',echoPlain:'有人答了，我当你们默认。',quiet:'没人吭声，那就是都干过。'
 }]}}});
 const result=await lib.warm({settingsFor:id=>({voiceName:'v-'+id})});
 assert.equal(result.total,5,'2 社交 + 问 + echoPlain + quiet');
 assert.ok(!calls.some(call=>call.text.includes('【词】')),'带占位符的句子永远不该预渲染');
 assert.equal(result.cached,1);
 assert.equal(result.synth,3);
 assert.equal(result.failed,1,'一条失败不中断整批');
 assert.equal(result.cached+result.synth+result.failed,5);
 assert.equal(calls[0].voice,'v-A');
});

test('落盘：重启不重花钱，版本不一致就作废',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'reaction-lib-'));
 try{
  const lib=new ReactionLibrary({sides:[A],dir});
  lib.fromJSON({version:LIB_VERSION,sides:{A:{social:['夸我没用，我今天是来算账的'],ask:[]}}});
  assert.equal(await lib.save(),true);
  const again=new ReactionLibrary({sides:[A],dir});
  assert.equal(await again.load(),true);
  assert.equal(again.snapshot().sides.A.social,1);
  const stale=new ReactionLibrary({sides:[A],dir});
  assert.equal(stale.fromJSON({version:LIB_VERSION+1,sides:{A:{social:['旧句子'],ask:[]}}}),false,'版本一变旧库就不该再用');
  assert.equal(stale.snapshot().sides.A.social,0);
  assert.equal(stale.fromJSON({version:2,sides:{A:{social:['旧的温和风格回应'],ask:[]}}}),false,'相爱相杀升级后不复用旧人物缓存');
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});

test('没有 dir 时不落盘，也不报错',async()=>{
 const lib=new ReactionLibrary({sides:[A]});
 assert.equal(await lib.save(),false);
 assert.equal(await lib.load(),false);
});
test('现场备用缓存每条只说一次，用尽后不循环套话',()=>{
 const lib=new ReactionLibrary({sides:[A]});lib.bank('A').social=['嗯。','谢啦。','先听她说。'];
 const used=Array.from({length:3},()=>lib.pick('A',{once:true}));
 assert.equal(new Set(used).size,3);assert.equal(lib.pick('A',{once:true}),null);assert.equal(lib.pick('A',{once:true}),null);
});
