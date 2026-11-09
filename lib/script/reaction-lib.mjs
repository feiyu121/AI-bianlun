// L0 反应库：把「不需要贴语境」的两类台词先生成好、再焐热成缓存。
// 设计见 DEBATE-SCRIPT.md §6.5.5，但有一处按成本实测改掉的做法：
//
//   文档写「社交库 40 句 × 2 方，随每轮辩题生成」。按立场写确实更贴，但 CloudVoice
//   的 render 是 this.tail 串行（cloud-voice.mjs:164），一条 ~1.2 秒——一轮 4 个候选题
//   就是 320 条 ≈ 6.4 分钟纯合成，投票窗全吃掉都不够。改成按人格生成，一个直播周期
//   只做 80 条，随便复用。代价是句子不能提具体的事，而这本来就是「不需要贴语境」的定义。
//
// 所以本模块管两样东西，生命周期不同：
//   社交库 social  每方 N 条，按人格 → 整个周期复用
//   反问单元 ask   每方 M 组，按当场的句子 → 每题重做（只 3 组，18 条音频）
//
// 焐热的本质是「提前把缓存焐热」，不是新链路：合成缓存的 key 里含文本
// （cloud-voice.mjs:130 的 identity 里塞了 voiceRequest()），只要文本+音色+情绪一致，
// /api/speech 直接返回 cached:true。
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {buildSocialBankMessages,buildAskMessages,parseJSONReply,validateSocialBank,validateAskUnit} from './prompts.mjs';

// 提示词或校验规则一改，旧库的句子就不该再用了——版本号进文件名，升级即换新。
export const LIB_VERSION=1;

// 二元组 Jaccard。40 条两两比是 780 次 × 16×16，忽略不计，不需要更聪明的算法。
export function similarity(a,b){
 const gram=text=>{
  const value=String(text??'').replace(/[\s，。！？、；：""''（）]/g,'');
  const set=new Set();
  for(let i=0;i+2<=value.length;i++)set.add(value.slice(i,i+2));
  return set;
 };
 const left=gram(a),right=gram(b);
 if(!left.size||!right.size)return 0;
 let hit=0;
 for(const item of left)if(right.has(item))hit++;
 return hit/(left.size+right.size-hit);
}

// 两条太像就只留先来的，后来的丢掉。
// 相似度之外还看「前 5 个字一样」：实测双方会各自撞出「笑得这么齐，……」这种同款开头，
// 而它们的 Jaccard 只有 0.28，光看相似度拦不住。10 字的句子里 5 字重合已经是一半，该拦。
export function tooClose(a,b,threshold=0.5){
 const left=String(a??'').trim(),right=String(b??'').trim();
 if(!left||!right)return false;
 if(left===right)return true;
 if(Math.min(left.length,right.length)>=6&&left.slice(0,5)===right.slice(0,5))return true;
 return similarity(left,right)>=threshold;
}

// block：别的方已经用掉的句子。双方说同一句最穿帮，但这里只按相似度拦，不套「前 5 字」那条：
// 实测两个角色一起笑的时候，开头十有八九都是「笑得这么……」，按字面拦会把整批判死
// （B 方第一轮 20 条被拦掉 17 条）。角色不同、措辞不同就够了，同一个笑点两个人都接得住。
export function dedupeLines(rows,{threshold=0.5,max=999,block=[]}={}){
 const out=[];
 for(const row of rows){
  const text=String(row??'').trim();
  if(!text)continue;
  if(out.some(kept=>tooClose(kept,text,threshold)))continue;
  if(block.some(other=>similarity(other,text)>=threshold||String(other??'').trim()===text))continue;
  out.push(text);
  if(out.length>=max)break;
 }
 return out;
}

function shuffle(list,rng){
 const out=[...list];
 for(let i=out.length-1;i>0;i--){
  const j=Math.floor(rng()*(i+1));
  [out[i],out[j]]=[out[j],out[i]];
 }
 return out;
}

export class ReactionLibrary{
 // complete(messages,{maxTokens}) -> 原始文本；render({text,emotion},settings) -> 语音。
 // 两个都注入，测试里换假的，运行时换 LLMClient 与 CloudVoice。
 constructor({sides=[],complete=null,render=null,emotion='happy',dir='',now=Date.now,rng=Math.random,log=()=>{}}={}){
  this.sides=new Map(sides.map(side=>[side.id,side]));
  this.complete=complete;
  this.render=render;
  this.emotion=emotion;
  this.dir=dir;
  this.file=dir?path.join(dir,`reaction-lib.v${LIB_VERSION}.json`):'';
  this.now=now;
  this.rng=rng;
  this.log=log;
  this.banks=new Map();     // id -> {social:[],ask:[],used:Map}
  this.queue=new Map();     // id -> 打乱后的待用下标，用尽再洗
  this.askQueue=new Map();
  this.stats={built:0,dropped:0,retries:0,failed:0,picked:0,missed:0,warm:{total:0,cached:0,synth:0,failed:0,ms:0}};
 }

 bank(id){
  if(!this.banks.has(id))this.banks.set(id,{social:[],ask:[],used:new Map()});
  return this.banks.get(id);
 }

 // ── 生成 ────────────────────────────────────────────────────────────────
 // 一次写不满就补写，这是必须的：校验会丢句子（长度/腔调/沾了具体话题/重复），
 // 20 条里丢掉 5 条很常见。不补的话库会越用越薄，L0 命中率掉下去全靠 L1 现场生成。
 //
 // 默认 16 而不是文档写的 40：实测双方的笑点池子是重叠的，硬要 40 条时第二方会卡在
 // 「全跟对方撞车」上，补写三四轮也填不满（67 秒只写出 36 条）。一场只消费 8~10 条社交句，
 // 16 条足够一个 6 小时直播周期轮着用。
 async buildSocial({count=16,attempts=3}={}){
  if(!this.complete)throw new Error('缺少 complete，无法生成社交库');
  for(const side of this.sides.values()){
   const bank=this.bank(side.id);
   // 对方已经拿走的句子，这边不能再要：两个角色说同一句话，观众当场就发现是同一套稿子。
   const others=[...this.banks].filter(([id])=>id!==side.id).flatMap(([,other])=>other.social);
   for(let attempt=0;attempt<attempts&&bank.social.length<count;attempt++){
    const need=count-bank.social.length;
    const raw=await this.complete(buildSocialBankMessages({side,count:need,existing:[...bank.social,...others]}),{maxTokens:320+need*60});
    const result=validateSocialBank(parseJSONReply(raw),{max:need});
    this.stats.dropped+=result.dropped.length;
    const fresh=dedupeLines([...bank.social,...result.lines],{max:count,block:others});
    if(fresh.length===bank.social.length)this.stats.retries++;
    bank.social=fresh;
    this.log(`社交库 ${side.name||side.id}：${bank.social.length}/${count}（本轮丢 ${result.dropped.length}）`);
   }
  }
  this.stats.built=this.count('social');
  return this.count('social');
 }

 // 反问单元按当场的句子做，所以每题重跑。每方 3 组就够：一场最多用 3 次反问。
 async buildAsk({topic='',turns={},count=3,attempts=2}={}){
  if(!this.complete)throw new Error('缺少 complete，无法生成反问单元');
  for(const side of this.sides.values()){
   const bank=this.bank(side.id);
   const turn={text:String(turns[side.id]||'')};
   for(let i=0;i<count;i++){
    let done=false;
    for(let attempt=0;attempt<attempts&&!done;attempt++){
     try{
      const raw=await this.complete(buildAskMessages({side,turn,topic,stanceWords:side.stanceWords||[]}),{maxTokens:500});
      const verdict=validateAskUnit(parseJSONReply(raw));
      if(verdict.ok){bank.ask.push(verdict.unit);done=true;}
      else{this.stats.retries++;this.stats.failed++;}
     }catch(error){this.stats.retries++;this.stats.failed++;this.log(`反问单元失败：${error.message}`);}
    }
    if(!done)this.log(`反问单元 ${side.name||side.id} 第 ${i+1} 组两次都没过，先空着`);
   }
  }
  return this.count('ask');
 }

 count(kind){
  let total=0;
  for(const bank of this.banks.values())total+=bank[kind].length;
  return total;
 }

 // ── 焐热 ────────────────────────────────────────────────────────────────
 // 只焐能直接播的：echo 里有【词】占位符，它是现场生成的，永远不该预渲染。
 // 顺序串行是有意的——CloudVoice 内部本来就是 this.tail 串行，这里开并发只是排队，
 // 反而让进度条乱跳。真要提高吞吐得改 CloudVoice，不在这一层的职责里。
 async warm({settingsFor=()=>null,onProgress=null}={}){
  if(!this.render)throw new Error('缺少 render，无法焐热音频');
  const jobs=[];
  for(const [id,bank] of this.banks){
   for(const text of bank.social)jobs.push({id,text,kind:'social'});
   for(const unit of bank.ask){
    for(const key of ['question','echoPlain','quiet'])jobs.push({id,text:unit[key],kind:'ask'});
   }
  }
  const startedAt=this.now();
  const result={total:jobs.length,cached:0,synth:0,failed:0,ms:0};
  for(const job of jobs){
   try{
    const audio=await this.render({text:job.text,emotion:this.emotion},settingsFor(job.id));
    if(audio?.cached)result.cached++;else result.synth++;
   }catch(error){
    result.failed++;
    this.log(`焐热失败（${job.kind}）：${job.text.slice(0,12)}… ${error.message}`);
   }
   onProgress?.({done:result.cached+result.synth+result.failed,...result});
  }
  result.ms=this.now()-startedAt;
  this.stats.warm=result;
  return result;
 }

 // ── 取用 ────────────────────────────────────────────────────────────────
 // 洗牌队列：一轮里每条都用过一次才会重复，避免「每次都播这一句」。
 pick(id){
  const bank=this.bank(id);
  if(!bank.social.length){this.stats.missed++;return null;}
  let queue=this.queue.get(id);
  if(!queue?.length){queue=shuffle(bank.social.map((_,i)=>i),this.rng);this.queue.set(id,queue);}
  const index=queue.pop();
  bank.used.set(index,(bank.used.get(index)||0)+1);
  this.stats.picked++;
  return bank.social[index];
 }

 pickAsk(id){
  const bank=this.bank(id);
  if(!bank.ask.length){this.stats.missed++;return null;}
  let queue=this.askQueue.get(id);
  if(!queue?.length){queue=shuffle(bank.ask.map((_,i)=>i),this.rng);this.askQueue.set(id,queue);}
  return bank.ask[queue.pop()];
 }

 // 运行时替换 echo 的占位符。观众答的那个词进不了提示词（那是注入面），只进这一句。
 fillEcho(unit,word){
  if(!unit?.echo)return '';
  const clean=String(word??'').replace(/[<>【】]/g,'').slice(0,6);
  if(!clean)return unit.echoPlain||'';
  return unit.echo.replace('【词】',clean);
 }

 // ── 落盘 ────────────────────────────────────────────────────────────────
 // 重启后不该重新花钱生成一遍。version 不一致直接当没有（提示词改了，句子也就该换）。
 toJSON(){
  const sides={};
  for(const [id,bank] of this.banks)sides[id]={social:bank.social,ask:bank.ask};
  return {version:LIB_VERSION,createdAt:this.now(),sides};
 }

 fromJSON(data){
  if(!data||data.version!==LIB_VERSION||!data.sides)return false;
  for(const [id,value] of Object.entries(data.sides)){
   const bank=this.bank(id);
   bank.social=Array.isArray(value.social)?value.social.filter(x=>typeof x==='string'):[];
   bank.ask=Array.isArray(value.ask)?value.ask.filter(x=>x&&typeof x.question==='string'):[];
  }
  return true;
 }

 async save(){
  if(!this.file)return false;
  await mkdir(this.dir,{recursive:true});
  await writeFile(this.file,JSON.stringify(this.toJSON()),'utf8');
  return true;
 }

 async load(){
  if(!this.file)return false;
  try{return this.fromJSON(JSON.parse(await readFile(this.file,'utf8')));}
  catch{return false;}
 }

 // 按配置的双方出快照，没建过库的一方显示 0 而不是缺字段——
 // 场控面板读 undefined 会显示成「-」，看起来像故障。
 snapshot(){
  const sides={};
  for(const id of this.sides.keys()){
   const bank=this.bank(id);
   sides[id]={
    social:bank.social.length,
    ask:bank.ask.length,
    unused:bank.social.filter((_,i)=>!bank.used.has(i)).length
   };
  }
  return {version:LIB_VERSION,sides,stats:{...this.stats,warm:{...this.stats.warm}}};
 }
}

export default ReactionLibrary;
