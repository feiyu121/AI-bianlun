import path from 'node:path';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {Studio} from './studio.mjs';
import {Storage,readSave} from './storage.mjs';
import {Safety,SAFETY_PROMPT} from './safety.mjs';
import {LLMClient} from './llm-client.mjs';
import {CloudVoice} from './cloud-voice.mjs';
import {LivePlatforms} from './live-platforms.mjs';
import {DebateCycle} from './debate-cycle.mjs';
import {DEBATE_TOPICS,DEBATE_PERSONAS} from './debate-topics.mjs';
import {ScriptWriter,ACTS} from './script/writer.mjs';
import {ScriptRunner} from './script/runner.mjs';
import {ReactionStage} from './script/stage.mjs';
import {ReactionLibrary} from './script/reaction-lib.mjs';
import {MentionRouter} from './mention.mjs';
import {GiftQueue} from './script/gifts.mjs';
import {buildReactionMessages,buildMentionMessages,buildGiftMessages,repairReaction,validateReaction,validateMention,validateGift} from './script/prompts.mjs';
import {estimateDuration} from './speech.mjs';

export const SCRIPT_ID=/^[A-Za-z0-9_-]{1,80}$/u;
export function validateScript(script,safety) {
  if(!script||!Array.isArray(script.turns)||!script.turns.length||script.turns.length>300)throw new Error('剧本需要 1～300 句台词');
  if(typeof script.topic!=='string'||!script.topic.trim()||script.topic.length>100)throw new Error('剧本需要有效辩题');
  if(safety?.check(script.topic).blocked)throw new Error('辩题命中播出屏蔽规则');
  const turns=script.turns.map((turn,index)=>{
    if(!['A','B'].includes(turn.side)||typeof turn.text!=='string'||!turn.text.trim()||turn.text.length>600)throw new Error(`第 ${index+1} 句格式无效`);
    if(safety?.check(turn.text).blocked)throw new Error(`第 ${index+1} 句命中播出屏蔽规则`);
    if(!Number.isInteger(turn.act)||turn.act<1||turn.act>30)throw new Error(`第 ${index+1} 句幕号无效`);
    // Imported audio URLs are discarded: no external fetches, stale cache or forged durations.
    return {id:`t${String(index+1).padStart(3,'0')}`,act:turn.act,side:turn.side,text:turn.text.trim(),reaction:turn.reaction!==false,estSec:estimateDuration(turn.text)/1000,keywords:Array.isArray(turn.keywords)?turn.keywords.filter(x=>typeof x==='string').slice(0,8):[]};
  });
  for(let i=1;i<turns.length;i++)if(turns[i].act<turns[i-1].act)throw new Error('幕号必须按播出顺序排列');
  const safeText=(value,max)=>{if(typeof value!=='string')return '';if(safety?.check(value).blocked)throw new Error('剧本角色信息命中播出屏蔽规则');return value.trim().slice(0,max);};
  const sides=(Array.isArray(script.sides)?script.sides:[]).filter(side=>side&&['A','B'].includes(side.id)).map(side=>({id:side.id,name:safeText(side.name,30),stance:safeText(side.stance,300),points:Array.isArray(side.points)?side.points.slice(0,10).map(x=>safeText(x,300)):[]}));
  return {version:1,id:typeof script.id==='string'?script.id:'',topic:script.topic.trim(),topicId:typeof script.topicId==='string'?script.topicId:'',sides,acts:Array.isArray(script.acts)?script.acts.slice(0,30).map(act=>({label:safeText(act?.label,80)})):[],meta:{generatedAt:safeText(script.meta?.generatedAt,40)},turns};
}

export class DebateRuntime {
  constructor({root,dataDir,edgeSpeech,edgeStatus,renderVoice=null,llm=null,platformEnabled=true,cycleLimits={}}) {
    Object.assign(this,{root,dataDir,edgeSpeech,edgeStatus,renderVoice,platformEnabled,cycleLimits});
    this.llm=llm;this.listeners=new Set();this.safeAudio=new Map();this.player={id:'',until:0};
    this.playback={text:'',until:0,level:0};this.epoch=0;this.busy=false;this.task=null;
    this.operation={state:'idle',message:'工作台已就绪'};this.scripts=[];this.preparing=new Map();
    this.seen=new Set();this.chatUsers=new Map();this.chatPending=0;this.closed=false;
    this.controller=new AbortController();this.jobs=new Set();
  }
  async init() {
    await mkdir(path.join(this.dataDir,'scripts'),{recursive:true});await mkdir(path.join(this.dataDir,'audio'),{recursive:true});
    this.store=new Storage(path.join(this.dataDir,'session.json'));
    this.safety=new Safety({dataDir:this.dataDir});await this.safety.init();
    this.engine=new Studio({saved:await readSave(this.store.filename),safety:this.safety});
    this.llm ||= new LLMClient({dataDir:this.dataDir});await this.llm.init?.();
    this.cloudVoice=new CloudVoice({dataDir:this.dataDir,audioDir:path.join(this.dataDir,'audio'),edgeSpeech:this.edgeSpeech,edgeStatus:this.edgeStatus});await this.cloudVoice.init();
    const render=this.renderVoice||this.cloudVoice.render.bind(this.cloudVoice);
    this.voice={render:async(item,settings)=>{
      if(this.safety.check(item.text,{stage:'tts',record:true}).blocked)throw new Error('台词命中播出屏蔽规则');
      const signal=this.controller.signal;signal.throwIfAborted();
      const audio=await this.track(render(item,{...settings,cloudSpeaker:settings.voiceName===this.engine.config.opponentVoice?this.cloudVoice.config.opponentSpeaker||'':undefined},{signal}));
      signal.throwIfAborted();
      if(this.safety.check(item.text).blocked)throw new Error('台词已被新增规则拦截');
      if(audio?.url)this.safeAudio.set(audio.url,this.safety.revision);return audio;
    }};
    this.library=new ReactionLibrary({sides:this.sides(DEBATE_TOPICS[0]),dir:path.join(this.dataDir,'reaction-lib'),complete:(m,o)=>this.complete(m,o),render:(item,settings)=>this.voice.render(item,settings)});
    await this.library.load();
    // A useful local L0 exists even before the first model request. No names, vote numbers or topic facts.
    for(const [id,lines] of Object.entries({A:['台下笑得这么齐，对面这道理可得再站稳一点。','这声加油我听见了，先看对面能不能答上这一句。','夸我也得讲道理，这个问题还没说完呢。'],B:['台下先别急着鼓掌，这个说法可还没过关呢。','笑归笑，把这一步的代价想清楚再站队。','你们的热闹我收到了，对面的问题我可还记着。']}))if(!this.library.bank(id).social.length)this.library.bank(id).social=lines;
    this.runner=new ScriptRunner({engine:this.engine,cloudVoice:this.voice,safety:this.safety,
      draft:(item,turn,slot)=>this.draft('reaction',item,turn,slot?.side),
      mentionDraft:(item,{turn})=>this.draft('mention',item,turn,item.personaId),
      giftDraft:(item,{turn})=>this.draft('gift',item,turn,item.side),
      gifts:new GiftQueue(),voiceExpected:()=>this.player.until>Date.now(),
      onChange:()=>this.emit(),onEnd:()=>{this.engine.state.speakingSide='';this.playback.until=0;this.emit();}});
    this.cycle=new DebateCycle({bank:DEBATE_TOPICS,prepare:topic=>this.prepare(topic),play:(script)=>this.play(script),
      announce:async(script,{topic})=>this.announce(`投票结束。下一场辩：${topic.topic}。双方准备，稍后开场。`),
      onPhase:()=>this.emit(),onChange:()=>this.emit(),log:message=>this.log(message),limits:this.cycleLimits});
    if(this.platformEnabled){
      this.platform=new LivePlatforms({root:this.root,dataDir:this.dataDir,handle:event=>this.receive(event),onChange:()=>this.emit(),onSwitch:()=>this.log('直播平台已切换')});
      await this.platform.init();
    }
    await this.refreshScripts();return this;
  }
  log(message,type='system'){this.engine.log(type,'长场辩论',message);this.emit();}
  emit(){if(!this.engine)return;for(const listener of this.listeners){try{listener(this.snapshot());}catch{}}}
  snapshot(){return {...this.engine.view(),script:{...this.runner.view(),sides:this.runner.sides},cycle:this.cycle.view(),topics:DEBATE_TOPICS.map(({id,topic})=>({id,topic})),scripts:this.scripts,
    playback:this.playback.until>Date.now()?this.playback:{text:'',until:0,level:0},epoch:this.epoch,operation:this.operation,
    system:{app:'ai-bianlun',version:'1.0.0',playerActive:this.player.until>Date.now(),llm:this.llm.view(),voice:this.cloudVoice.view(),edge:this.edgeStatus(),platform:this.platform?.view()||{state:'disconnected',message:'未接入直播间'},safety:this.safety.view()}};}
  sides(topic){const c=this.engine.config;return [
    {id:'A',name:c.characterName,voice:c.voiceName,...topic.fan,style:DEBATE_PERSONAS.fan.style+topic.fan.style},
    {id:'B',name:c.opponentName,voice:c.opponentVoice,...topic.pro,style:DEBATE_PERSONAS.pro.style+topic.pro.style}
  ];}
  complete(messages,options={}){return this.llm.complete(messages,{...options,signal:options.signal||this.controller.signal});}
  track(pending){this.jobs.add(pending);pending.finally(()=>this.jobs.delete(pending)).catch(()=>{});return pending;}
  assertFree(){if(this.closed||this.busy||this.runner.active||this.cycle.running)throw new Error('已有场次或任务正在运行，请先停止');}
  launch(message,work){
    this.assertFree();this.busy=true;this.controller=new AbortController();this.operation={state:'running',message};
    this.task=Promise.resolve().then(work).catch(error=>{this.controller.abort();this.cycle.stop();this.runner.stop();this.engine.state.running=false;this.operation={state:'error',message:error.message};this.log(error.message,'error');})
      .finally(()=>{this.busy=false;if(this.controller.signal.aborted)this.controller=new AbortController();if(this.operation.state==='running')this.operation={state:'idle',message:'任务已完成'};this.emit();});
    this.emit();return this.operation;
  }
  topic(id){const topic=DEBATE_TOPICS.find(item=>item.id===id);if(!topic)throw new Error('辩题不存在');return topic;}
  async prepare(topic) {
    if(this.preparing.has(topic.id))return this.preparing.get(topic.id);
    const signal=this.controller.signal;
    const job=(async()=>{
      signal.throwIfAborted();this.log('开始写稿：'+topic.topic);
      const writer=new ScriptWriter({complete:(m,o)=>{signal.throwIfAborted();return this.complete(m,{...o,signal});},topic:topic.topic,sides:this.sides(topic),log:message=>this.log(message)});
      const raw=await writer.write();signal.throwIfAborted();
      const script=validateScript({...raw,id:topic.id+'-'+Date.now(),topicRef:topic},this.safety);
      script.sides=this.sides(topic);script.topicId=topic.id;
      const covered=new Set(script.turns.map(turn=>turn.act));
      const duration=script.turns.reduce((sum,turn)=>sum+turn.estSec,0);
      const ready=script.turns.length>=40&&covered.size===ACTS.length&&duration>=22*60;
      script.meta={...raw.meta,estTotalSec:duration,ready};
      await this.saveScript(script);
      if(!ready){this.log(`剧本未就绪：${script.turns.length} 句、${covered.size}/11 幕、约 ${Math.round(duration/60)} 分钟`,'error');return {script,ready:false,error:'幕数、句数或时长不足，请重写'};}
      for(const turn of script.turns.slice(0,6)){
        signal.throwIfAborted();try{const audio=await this.voice.render({text:turn.text,emotion:'happy'},{...this.engine.config,voiceName:script.sides.find(s=>s.id===turn.side).voice});turn.audio=audio.url;turn.durationMs=audio.durationMs||estimateDuration(turn.text);}catch(error){if(signal.aborted)throw error;this.log('起播音频预热失败：'+error.message,'error');break;}
      }
      signal.throwIfAborted();await this.saveScript(script);this.log('剧本已就绪：'+topic.topic);return {script,ready:true};
    })();
    this.preparing.set(topic.id,job);try{return await job;}finally{this.preparing.delete(topic.id);}
  }
  async saveScript(script){if(!SCRIPT_ID.test(script.id))throw new Error('剧本编号无效');await new Storage(path.join(this.dataDir,'scripts',script.id+'.json')).save(script);await this.refreshScripts();}
  async refreshScripts(){
    const files=(await readdir(path.join(this.dataDir,'scripts'))).filter(x=>/^[A-Za-z0-9_-]+\.json$/u.test(x));
    const rows=await Promise.all(files.map(async file=>{try{const s=JSON.parse(await readFile(path.join(this.dataDir,'scripts',file),'utf8'));return {id:file.slice(0,-5),topic:s.topic,turns:s.turns?.length||0,minutes:Math.round((s.meta?.estTotalSec||0)/60),ready:s.meta?.ready!==false,generatedAt:s.meta?.generatedAt||''};}catch{return null;}}));
    this.scripts=rows.filter(Boolean).sort((a,b)=>b.id.localeCompare(a.id));this.emit();
  }
  async loadScript(id){if(!SCRIPT_ID.test(id))throw new Error('剧本编号无效');return JSON.parse(await readFile(path.join(this.dataDir,'scripts',id+'.json'),'utf8'));}
  async play(script){
    this.controller.signal.throwIfAborted();if(this.runner.active)throw new Error('已有剧本正在播放');
    this.playingTopic=script.topicRef||DEBATE_TOPICS.find(t=>t.id===script.topicId)||DEBATE_TOPICS[0];
    const defaults=this.sides(this.playingTopic);
    script={...script,sides:defaults.map(side=>{const declared=(script.sides||[]).find(item=>item?.id===side.id);return {...side,...declared,name:declared?.name||side.name,voice:side.voice};})};
    this.library.sides=new Map(script.sides.map(side=>[side.id,side]));
    this.epoch++;this.playback.until=0;this.engine.utterances=[];this.engine.state.running=true;this.engine.state.scriptLine=null;
    this.runner.mention=new MentionRouter({personas:script.sides.map(side=>({id:side.id,name:side.name,aliases:side.id==='A'?['正方']:['反方','小鲸鱼','阿鲸']}))});
    this.runner.stage=new ReactionStage({library:this.library,draft:(item,slot)=>this.draft('reaction',item,this.runner.turns[slot?.index],slot?.side)});
    await this.runner.start({script});this.emit();await this.runner.running;
    if(!this.cycle.running)this.engine.state.running=false;this.emit();
  }
  startSingle({topicId,scriptId,script}={}){return this.launch('准备单场辩论',async()=>{
    let next=script?validateScript(script,this.safety):scriptId?validateScript(await this.loadScript(scriptId),this.safety):null;
    if(!next){const entry=await this.prepare(this.topic(topicId));if(!entry.ready)throw new Error(entry.error);next=entry.script;}
    await this.play(next);
  });}
  generate(topicId){return this.launch('生成长场剧本',async()=>{const out=await this.prepare(this.topic(topicId));if(!out.ready)throw new Error(out.error);});}
  startCycle({topicId,rounds}={}){return this.launch('长场循环运行中',async()=>{this.engine.state.running=true;await this.cycle.run({first:topicId?this.topic(topicId):null,rounds:Number.isInteger(rounds)&&rounds>0?rounds:Infinity});this.engine.state.running=false;});}
  async stop(){
    this.controller.abort();this.cycle.stop();this.runner.stop();this.epoch++;this.engine.utterances=[];this.playback.until=0;this.engine.state.running=false;
    await this.runner.running?.catch(()=>{});await this.task;await Promise.allSettled([...this.jobs]);
    this.controller=new AbortController();
    this.operation={state:'idle',message:'已停止，场次不会自动重启'};this.emit();
  }
  skip(){this.epoch++;this.engine.utterances=[];this.playback.until=0;const result=this.runner.skip();this.emit();return result;}
  async draft(kind,item,turn,sideId='A') {
    const side=this.runner.side(sideId),opponent=this.runner.side(sideId==='B'?'A':'B');
    const common={side,opponent,topic:this.runner.topic,turn:{text:turn?.text||''},stanceWords:side.points||[]};
    let messages,verdict;
    if(kind==='reaction')messages=buildReactionMessages({...common,comment:item.text,mood:item.mood,social:item.social});
    else if(kind==='mention')messages=buildMentionMessages({...common,audience:{name:item.name,text:item.text}});
    else messages=buildGiftMessages({...common,gift:{label:item.label,count:item.count,name:item.name}});
    try{
      const raw=await this.complete(messages,{maxTokens:400,timeoutMs:kind==='reaction'?11000:25000});
      const text=repairReaction(raw,{minChars:kind==='reaction'?12:20,maxChars:kind==='reaction'?28:48}).text;
      verdict=kind==='reaction'?validateReaction(text,{source:item.text,social:item.social,stanceWords:turn?.keywords||[]}):kind==='mention'?validateMention(text):validateGift(text);
      return verdict.ok?this.safety.output(text,{stage:'script-'+kind}):'';
    }catch{return '';}
  }
  async announce(text){
    if(this.controller.signal.aborted)return;const epoch=this.epoch;
    const settings={...this.engine.config};let audio;
    try{audio=await this.voice.render({text,emotion:'happy'},settings);}catch{}
    if(this.controller.signal.aborted||epoch!==this.epoch)return;
    const item=this.engine.say(text,'happy');if(audio){item.audio=audio.url;item.durationMs=audio.durationMs;}
    this.emit();await this.cycle.sleep(audio?.durationMs||estimateDuration(text));
  }
  async receive(event){
    if(!event||!['comment','gift','like','enter'].includes(event.type))throw new Error('事件类型无效');
    if(event.type==='comment'&&(typeof event.text!=='string'||!event.text.trim()||event.text.length>500))throw new Error('弹幕需要 1～500 字');
    if(event.id&&this.seen.has(event.id))return {duplicate:true};
    const check=this.safety.ingress(event);if(check.blocked){this.emit();return {blocked:true};}event=check.next;
    if(event.id){this.seen.add(event.id);if(this.seen.size>4000)this.seen.delete(this.seen.values().next().value);}
    if(event.type==='comment'){
      if(this.cycle.phase==='vote'){
        const vote=this.cycle.vote.cast(event);if(vote.ok){this.emit();return {vote};}
      }
      if(this.runner.active){const result=this.runner.comment(event);this.emit();return result;}
      // Intermission chat is part of this show; it has no work, lounge or music subsystem.
      const user=event.userId||event.name||'anonymous',now=Date.now();
      if(this.chatPending<2&&now-(this.chatUsers.get(user)||0)>10000&&this.llm.view().hasKey){
        this.chatUsers.set(user,now);this.chatPending++;const epoch=this.epoch;
        const job=this.complete([{role:'system',content:`你是辩论直播的暖场主播${this.engine.config.characterName}。用一句12到35字的口语接观众的话；不要报票数，不编造场上事实，不输出旁白。${SAFETY_PROMPT}`},{role:'user',content:JSON.stringify({弹幕:event.text})}],{maxTokens:150,timeoutMs:12000})
          .then(text=>{if(epoch===this.epoch&&!this.runner.active&&!this.closed){this.engine.state.running=true;this.engine.say(text.slice(0,60),'happy');this.emit();}})
          .catch(()=>{}).finally(()=>this.chatPending--);this.track(job);
      }
      this.engine.log('comment',event.name,event.text);this.emit();return {heard:true};
    }
    if(event.type==='gift'){
      const count=Number(event.count??1);if(!Number.isInteger(count)||count<1||count>100000)throw new Error('礼物数量无效');
      const out=this.runner.active?this.runner.gift({...event,count}):{queued:false};
      this.engine.log('gift',event.name,`${event.label||event.giftName||event.gift||'礼物'} ×${count}${out?.queued?'，已排入幕间回应':'，已记录'}`);this.emit();return out;
    }
    return {heard:true};
  }
  async rewrite(actNumber){
    if(!this.runner.active||!this.playingTopic)throw new Error('没有正在播放的剧本');
    const act=ACTS[actNumber-1];if(!act)throw new Error('幕号无效');
    const writer=new ScriptWriter({complete:(m,o)=>this.complete(m,o),topic:this.playingTopic.topic,sides:this.sides(this.playingTopic)});
    const out=await writer.write({acts:[act]});this.controller.signal.throwIfAborted();
    for(const turn of out.turns)if(this.safety.check(turn.text).blocked)throw new Error('重写台词命中播出屏蔽规则');
    const result=this.runner.replaceAct(actNumber,out.turns);this.emit();return result;
  }
  async configure(input){if(this.busy)throw new Error('请先停止场次再修改辩手配置');this.engine.configure(input);await this.store.save(this.engine.serialize());return this.engine.config;}
  async close(){this.closed=true;await this.stop();await this.platform?.stop();await this.store.save(this.engine.serialize());}
}
