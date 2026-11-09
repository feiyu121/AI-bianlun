import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {Studio} from './studio.mjs';
import {Storage,readSave} from './storage.mjs';
import {ScriptLibrary,pickLibraryScripts} from './script-library.mjs';
import {Safety,SAFETY_PROMPT} from './safety.mjs';
import {LLMClient} from './llm-client.mjs';
import {CloudVoice} from './cloud-voice.mjs';
import {LivePlatforms} from './live-platforms.mjs';
import {DebateCycle} from './debate-cycle.mjs';
import {DEBATE_TOPICS} from './debate-topics.mjs';
import {debateSides,personaPrompt} from './personas.mjs';
import {ScriptWriter,ACTS} from './script/writer.mjs';
import {ScriptRunner} from './script/runner.mjs';
import {ReactionStage} from './script/stage.mjs';
import {ReactionLibrary} from './script/reaction-lib.mjs';
import {MentionRouter} from './mention.mjs';
import {GiftQueue} from './script/gifts.mjs';
import {buildReactionMessages,buildMentionMessages,buildGiftMessages,repairReaction,validateReaction,validateMention,validateGift} from './script/prompts.mjs';
import {estimateDuration} from './speech.mjs';
import {ConversationMemory,memoryPrompt} from './conversation-memory.mjs';
import {AudienceCamps,parseCamp} from './audience-camps.mjs';
import {REPLY_LIMITS,SOCIAL_LIMITS,MENTION_LINE,GIFT_LINE} from './script/prompts.mjs';

export const SCRIPT_ID=/^[A-Za-z0-9_-]{1,80}$/u;
export function customTopic(value){
  if(typeof value!=='string'||/[\r\n\x00-\x08\x0b-\x1f\x7f]/u.test(value))throw new Error('自定义辩题需要单行文字');
  const topic=value.replace(/[ \t]+/gu,' ').trim();
  if(!topic||topic.length>100)throw new Error('每道自定义辩题需要 1～100 字');
  return {id:'custom-'+createHash('sha256').update(topic.normalize('NFKC')).digest('hex').slice(0,16),topic};
}
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
  const sides=(Array.isArray(script.sides)?script.sides:[]).filter(side=>side&&['A','B'].includes(side.id)).map(side=>({id:side.id,name:safeText(side.name,30),stance:safeText(side.stance,300),...(side.style?{style:safeText(side.style,2000)}:{}),...(side.relationship?{relationship:safeText(side.relationship,500)}:{}),...(side.scene?{scene:safeText(side.scene,500)}:{}),...(side.backstory?{backstory:safeText(side.backstory,1000)}:{}),points:Array.isArray(side.points)?side.points.slice(0,10).map(x=>safeText(x,300)):[]}));
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
    this.memory=new ConversationMemory();
    this.camps=new AudienceCamps();
    this.production={running:false,total:0,done:0,succeeded:0,failed:0,items:[]};
    this.generation={state:'idle',phase:'',message:'尚未开始写稿',completedActs:0,totalActs:ACTS.length,turns:0,chars:0,estTotalSec:0};
  }
  async init() {
    await mkdir(path.join(this.dataDir,'scripts'),{recursive:true});await mkdir(path.join(this.dataDir,'audio'),{recursive:true});
    this.store=new Storage(path.join(this.dataDir,'session.json'));
    this.safety=new Safety({dataDir:this.dataDir});await this.safety.init();
    this.engine=new Studio({saved:await readSave(this.store.filename),safety:this.safety});
    this.catalog=await new ScriptLibrary(path.join(this.dataDir,'script-library.json')).init();await this.catalog.recover();
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
    this.runner=new ScriptRunner({engine:this.engine,cloudVoice:this.voice,safety:this.safety,
      draft:(item,turn,slot)=>this.draft('reaction',item,turn,slot?.side),
      mentionDraft:(item,{turn})=>this.draft('mention',item,turn,item.personaId),
      giftDraft:(item,{turn})=>this.draft('gift',item,turn,item.side),
      gifts:new GiftQueue(),voiceExpected:()=>this.player.until>Date.now(),
      onSpoken:(turn,{kind})=>{
        this.memory.remember({side:turn.side,text:turn.text,kind});
        if(kind==='script'&&this.broadcast&&!this.broadcast.started){
          const broadcast=this.broadcast;broadcast.started=true;
          broadcast.record=this.catalog.started(broadcast.script).then(async event=>{await this.refreshScripts();return event;});
          broadcast.record.catch(error=>this.log('播出记录保存失败：'+error.message,'error'));
        }
      },
      onChange:()=>this.emit(),onEnd:()=>{this.finishCamps();this.engine.state.speakingSide='';this.playback.until=0;this.emit();}});
    this.cycle=new DebateCycle({libraryOnly:true,bank:[],prepare:topic=>this.libraryEntry(topic.id,{automatic:true}),play:(script)=>this.play(script),
      pickCandidates:({avoid,n})=>pickLibraryScripts(this.scripts.filter(row=>!this.cycle.unavailable.has(row.id)),{avoid,n,used:[...this.cycle.used],repeat:this.repeatLibrary,currentId:this.cycle.current?.topic.id}),
      announce:async(script,{topic,by})=>this.announce(`${by==='rotation'?'下一场已经备好':'投票结束'}。下一场辩：${topic.topic}。双方准备，稍后开场。`),
      onPhase:()=>this.emit(),onChange:()=>this.emit(),log:message=>this.log(message),limits:this.cycleLimits});
    if(this.platformEnabled){
      this.platform=new LivePlatforms({root:this.root,dataDir:this.dataDir,handle:event=>this.receive(event),onChange:()=>this.emit(),onSwitch:()=>this.log('直播平台已切换')});
      await this.platform.init();
    }
    await this.refreshScripts();return this;
  }
  log(message,type='system'){this.engine.log(type,'长场辩论',message);this.emit();}
  emit(){if(!this.engine)return;for(const listener of this.listeners){try{listener(this.snapshot());}catch{}}}
  snapshot(){return {...this.engine.view(),script:{...this.runner.view(),sides:this.runner.sides},cycle:{...this.cycle.view(),repeat:Boolean(this.repeatLibrary)},topics:DEBATE_TOPICS.map(({id,topic})=>({id,topic})),scripts:this.scripts,
    library:{available:this.scripts.filter(row=>row.autoReady).length,history:this.catalog.history.slice(-30).reverse()},production:this.production,generation:{...this.generation},camps:this.camps.view(),
    playback:this.playback.until>Date.now()?this.playback:{text:'',until:0,level:0},epoch:this.epoch,operation:this.operation,
    system:{app:'ai-bianlun',version:'1.0.0',playerActive:this.player.until>Date.now(),llm:this.llm.view(),voice:this.cloudVoice.view(),edge:this.edgeStatus(),platform:this.platform?.view()||{state:'disconnected',message:'未接入直播间'},safety:this.safety.view()}};}
  sides(topic){return debateSides(topic,this.engine.config);}
  complete(messages,options={}){return this.llm.complete(messages,{...options,signal:options.signal||this.controller.signal});}
  track(pending){this.jobs.add(pending);pending.finally(()=>this.jobs.delete(pending)).catch(()=>{});return pending;}
  assertFree(){if(this.closed||this.busy||this.runner.active||this.cycle.running)throw new Error('已有场次或任务正在运行，请先停止');}
  launch(message,work){
    this.assertFree();this.busy=true;this.controller=new AbortController();this.operation={state:'running',message};
    this.task=Promise.resolve().then(work).catch(error=>{this.controller.abort();this.cycle.stop();this.runner.stop();this.engine.state.running=false;this.operation={state:'error',message:error.message};this.log(error.message,'error');})
      .finally(()=>{this.busy=false;if(this.controller.signal.aborted)this.controller=new AbortController();if(this.operation.state==='running')this.operation={state:'idle',message:'任务已完成'};this.emit();});
    this.emit();return this.operation;
  }
  topic(id){const topic=DEBATE_TOPICS.find(item=>item.id===id)||this.scripts.find(item=>item.topicId===id);if(!topic)throw new Error('辩题不存在');return topic.topicId?{id:topic.topicId,topic:topic.topic}:topic;}
  generationTopics({topicIds=[],customTopics=[]}={}){
    if(!Array.isArray(topicIds)||!Array.isArray(customTopics))throw new Error('辩题列表格式无效');
    const unique=new Map();
    for(const topic of [...new Set(topicIds)].map(id=>this.topic(id)).concat(customTopics.map(customTopic))){
      if(this.safety.check(topic.topic).blocked)throw new Error('辩题命中播出屏蔽规则：'+topic.topic);
      const key=topic.topic.normalize('NFKC').replace(/[ \t]+/gu,' ').trim();if(!unique.has(key))unique.set(key,topic);
    }
    if(!unique.size)throw new Error('请选择辩题或填写自定义辩题');return [...unique.values()];
  }
  async prepare(topic) {
    if(this.preparing.has(topic.id))return this.preparing.get(topic.id);
    const signal=this.controller.signal;
    const progress={state:'running',phase:'outline',message:'开始准备大纲',topic:topic.topic,topicId:topic.id,startedAt:Date.now(),phaseAt:Date.now(),completedActs:0,totalActs:ACTS.length,turns:0,chars:0,estTotalSec:0,requestPending:false};
    this.generation=progress;
    const update=(event)=>{
      if(signal.aborted)return;
      if(event.phase&&event.phase!==progress.phase||event.act&&event.act!==progress.act)progress.phaseAt=Date.now();
      Object.assign(progress,event,{updatedAt:Date.now()});this.emit();
    };
    const report=(message,event={})=>{update({message,...event});if(!signal.aborted)this.log(message,'generation');};
    const job=(async()=>{
      signal.throwIfAborted();this.log('开始写稿：'+topic.topic,'generation');
      const sides=this.sides(topic);
      const writer=new ScriptWriter({complete:async(m,o)=>{
        signal.throwIfAborted();update({requestPending:true,requestAt:Date.now()});
        const heartbeat=setInterval(()=>{if(!signal.aborted)this.log(`仍在等待模型返回：${progress.phase==='outline'?'大纲':progress.phase==='refine'?'内容扩写':`第 ${progress.act||'?'} 幕`}，已等待 ${Math.floor((Date.now()-progress.requestAt)/1000)} 秒`,'generation');},30000);heartbeat.unref?.();
        try{return await this.complete(m,{...o,signal});}
        finally{clearInterval(heartbeat);update({requestPending:false});}
      },topic:topic.topic,sides,signal,log:message=>{if(!signal.aborted)this.log(message,'generation');},onProgress:update});
      const raw=await writer.write();signal.throwIfAborted();
      report('正在检查剧本格式、内容规则与完整时长',{phase:'validate'});
      const script=validateScript({...raw,id:topic.id+'-'+randomUUID(),topicRef:topic},this.safety);
      script.sides=sides;script.topicId=topic.id;
      const covered=new Set(script.turns.map(turn=>turn.act));
      const duration=script.turns.reduce((sum,turn)=>sum+turn.estSec,0);
      const ready=script.turns.length>=40&&covered.size===ACTS.length&&ACTS.every((_,i)=>covered.has(i+1))&&duration>=22*60;
      script.meta={...raw.meta,estTotalSec:duration,ready};
      report(`检查完成：${script.turns.length} 句、${covered.size}/${ACTS.length} 幕、约 ${Math.round(duration/60)} 分钟，正在保存`,{phase:'save',turns:script.turns.length,chars:script.turns.reduce((sum,turn)=>sum+turn.text.length,0),estTotalSec:duration});
      await this.saveScript(script);
      if(!ready){report(`剧本已保存，但未达到开播门槛：${script.turns.length} 句、${covered.size}/11 幕、约 ${Math.round(duration/60)} 分钟`,{state:'error',phase:'not-ready',finishedAt:Date.now()});return {script,ready:false,error:'幕数、句数或时长不足，请重写'};}
      const audioTotal=Math.min(6,script.turns.length);let audioDone=0;
      report(`剧本已入库，正在预热前 ${audioTotal} 句配音`,{phase:'audio',audioDone,audioTotal});
      for(const turn of script.turns.slice(0,6)){
        signal.throwIfAborted();try{const audio=await this.voice.render({text:turn.text,emotion:'happy'},{...this.engine.config,voiceName:script.sides.find(s=>s.id===turn.side).voice});turn.audio=audio.url;turn.durationMs=audio.durationMs||estimateDuration(turn.text);audioDone++;report(`起播配音已预热 ${audioDone}/${audioTotal} 句`,{phase:'audio',audioDone});}catch(error){if(signal.aborted)throw error;report('起播音频预热失败：'+error.message+'，播放时可重新合成',{phase:'audio'});break;}
      }
      signal.throwIfAborted();await this.saveScript(script);report('剧本已就绪：'+topic.topic,{state:'completed',phase:'ready',finishedAt:Date.now()});return {script,ready:true};
    })();
    this.preparing.set(topic.id,job);try{return await job;}
    catch(error){Object.assign(progress,{state:signal.aborted?'cancelled':'error',phase:signal.aborted?'cancelled':'error',message:signal.aborted?'写稿已停止':error.message,requestPending:false,finishedAt:Date.now()});this.log(`${topic.topic}：${progress.message}`,'generation');throw error;}
    finally{this.preparing.delete(topic.id);}
  }
  async saveScript(script){if(!SCRIPT_ID.test(script.id))throw new Error('剧本编号无效');await new Storage(path.join(this.dataDir,'scripts',script.id+'.json')).save(script);await this.refreshScripts();}
  async refreshScripts(){
    const files=(await readdir(path.join(this.dataDir,'scripts'))).filter(x=>/^[A-Za-z0-9_-]+\.json$/u.test(x));
    const rows=await Promise.all(files.map(async file=>{try{
      const raw=JSON.parse(await readFile(path.join(this.dataDir,'scripts',file),'utf8'));let clean,error='';
      try{clean=validateScript(raw,this.safety);}catch(e){error=e.message;}
      const info=this.catalog.info(file.slice(0,-5)),duration=clean?.turns.reduce((sum,t)=>sum+t.estSec,0)||0;
      const covered=new Set(clean?.turns.map(t=>t.act)||[]);
      const ready=Boolean(clean&&raw.meta?.ready!==false),longForm=Boolean(clean&&clean.turns.length>=40&&covered.size===ACTS.length&&ACTS.every((_,i)=>covered.has(i+1))&&duration>=22*60);
      return {id:file.slice(0,-5),topic:typeof raw.topic==='string'?raw.topic:'无效剧本',topicId:clean?.topicId||'',turns:clean?.turns.length||0,minutes:Math.round(duration/60),ready,longForm,autoReady:ready&&longForm&&info.enabled,...info,error,generatedAt:raw.meta?.generatedAt||''};
    }catch{return null;}}));
    this.scripts=rows.filter(Boolean).sort((a,b)=>b.id.localeCompare(a.id));this.emit();
  }
  async loadScript(id){if(!SCRIPT_ID.test(id))throw new Error('剧本编号无效');return JSON.parse(await readFile(path.join(this.dataDir,'scripts',id+'.json'),'utf8'));}
  async libraryEntry(id,{automatic=false}={}){
    const row=this.scripts.find(item=>item.id===id);if(!row)throw new Error('剧本不在库中');
    if(!row.ready||(automatic&&!row.autoReady))throw new Error(row.error||'剧本未就绪或未加入长场轮播');
    const raw=await this.loadScript(id),script=validateScript(raw,this.safety);script.id=id;
    return {script,ready:true};
  }
  async setScriptEnabled(id,enabled){this.assertFree();if(!this.scripts.some(row=>row.id===id))throw new Error('剧本不在库中');await this.catalog.setEnabled(id,enabled);await this.refreshScripts();}
  async play(script){
    this.controller.signal.throwIfAborted();if(this.runner.active)throw new Error('已有剧本正在播放');
    this.playingTopic=script.topicRef||DEBATE_TOPICS.find(t=>t.id===script.topicId)||{id:script.topicId||'',topic:script.topic};
    const defaults=this.sides(this.playingTopic);
    script={...script,sides:defaults.map(side=>{const declared=(script.sides||[]).find(item=>item?.id===side.id);return {...side,...declared,name:declared?.name||side.name,voice:side.voice};})};
    this.library.sides=new Map(script.sides.map(side=>[side.id,side]));
    this.memory=new ConversationMemory();
    this.epoch++;this.playback.until=0;this.engine.utterances=[];this.engine.state.running=true;this.engine.state.scriptLine=null;
    this.runner.mention=new MentionRouter({personas:script.sides.map(side=>({id:side.id,name:side.name,aliases:side.id==='A'?['正方']:['反方','小鲸鱼','阿鲸']}))});
    this.runner.stage=new ReactionStage({library:this.library,draft:(item,slot)=>this.draft('reaction',item,this.runner.turns[slot?.index],slot?.side)});
    const broadcast=this.scripts.some(row=>row.id===script.id)?{script,started:false,record:null}:null;
    this.broadcast=broadcast;
    this.camps.open(script.sides);
    try{await this.runner.start({script});this.emit();await this.runner.running;}
    finally{
      this.finishCamps();
      this.broadcast=null;
      if(broadcast?.record){
        try{const event=await broadcast.record;await this.catalog.ended(event,this.runner.error?'error':this.runner.stopped||this.runner.stats.turns<this.runner.turns.length?'interrupted':'completed');await this.refreshScripts();}
        catch(error){this.log('播出记录保存失败：'+error.message,'error');}
      }
      if(!this.cycle.running)this.engine.state.running=false;this.emit();
    }
  }
  startSingle({topicId,scriptId,script}={}){return this.launch('从剧本库准备单场',async()=>{
    await this.refreshScripts();
    if(topicId)this.topic(topicId);
    const id=scriptId||pickLibraryScripts(this.scripts.filter(row=>!topicId||row.topicId===topicId),{n:1})[0]?.id;
    const next=script?validateScript(script,this.safety):id?(await this.libraryEntry(id)).script:null;
    if(!next)throw new Error('没有可播剧本，请先到剧本库生成或导入');
    await this.play(next);
  });}
  generate(input){const {topicId,topic}=typeof input==='string'?{topicId:input}:input||{};return this.generateBatch({topicIds:topicId?[topicId]:[],customTopics:topic===undefined?[]:[topic]});}
  generateBatch({topicIds=[],customTopics=[],count=1}={}){
    if(!Number.isInteger(count)||count<1||count>5)throw new Error('每题生成 1～5 份');
    const topics=this.generationTopics({topicIds,customTopics});if(topics.length*count>20)throw new Error('每批最多生成 20 份剧本');
    return this.launch('批量生成剧本',async()=>{
      const queue=topics.flatMap(topic=>Array.from({length:count},()=>topic));
      this.production={running:true,total:queue.length,done:0,succeeded:0,failed:0,items:[]};
      try{for(const topic of queue){
        this.controller.signal.throwIfAborted();this.operation.message=`批量写稿 ${this.production.done+1}/${queue.length}：${topic.topic}`;this.emit();
        let item;try{const out=await this.prepare(topic);item={topic:topic.topic,scriptId:out.script?.id,ok:out.ready,error:out.error||''};}
        catch(error){this.controller.signal.throwIfAborted();item={topic:topic.topic,ok:false,error:error.message};}
        this.production.items.push(item);this.production.done++;this.production[item.ok?'succeeded':'failed']++;this.emit();
      }
      this.operation={state:this.production.failed?'error':'idle',message:`批量写稿完成：${this.production.succeeded} 份就绪，${this.production.failed} 份失败或未就绪`};
      }finally{this.production.running=false;this.emit();}
    });
  }
  preRender(scriptId){return this.launch('预合成剧本配音',async()=>{
    await this.refreshScripts();const {script}=await this.libraryEntry(scriptId);
    for(let i=0;i<script.turns.length;i++){
      this.controller.signal.throwIfAborted();const turn=script.turns[i];this.operation.message=`预合成配音 ${i+1}/${script.turns.length}：${script.topic}`;this.emit();
      await this.voice.render({text:turn.text,emotion:'happy'},{...this.engine.config,voiceName:turn.side==='B'?this.engine.config.opponentVoice:this.engine.config.voiceName});
    }
    this.operation={state:'idle',message:'整场配音已缓存；使用相同语音设置播放时会直接复用'};
  });}
  startCycle({topicId,scriptId,rounds,repeat=false}={}){
    if(typeof repeat!=='boolean')throw new Error('循环复播设置无效');
    return this.launch('剧本库连续直播运行中',async()=>{
      await this.refreshScripts();this.repeatLibrary=repeat;
      if(topicId)this.topic(topicId);
      const row=scriptId?this.scripts.find(item=>item.id===scriptId&&item.autoReady):pickLibraryScripts(this.scripts.filter(item=>!topicId||item.topicId===topicId),{n:1})[0];
      if(!row)throw new Error('剧本库没有可轮播的长场剧本，请先生成或导入完整剧本');
      this.cycle.bank=this.scripts.filter(item=>item.autoReady).map(item=>({id:item.id,topic:item.topic,topicId:item.topicId}));
      this.engine.state.running=true;
      try{await this.cycle.run({first:{id:row.id,topic:row.topic},rounds:Number.isInteger(rounds)&&rounds>0?rounds:Infinity});}
      finally{this.engine.state.running=false;}
    });
  }
  async stop(){
    this.controller.abort();this.cycle.stop();this.runner.stop();this.finishCamps();this.epoch++;this.engine.utterances=[];this.playback.until=0;this.engine.state.running=false;
    await this.runner.running?.catch(()=>{});await this.task;await Promise.allSettled([...this.jobs]);
    this.controller=new AbortController();
    this.operation={state:'idle',message:'已停止，场次不会自动重启'};this.emit();
  }
  skip(){this.epoch++;this.engine.utterances=[];this.playback.until=0;const result=this.runner.skip();this.emit();return result;}
  async draft(kind,item,turn,sideId='A') {
    const side=this.runner.side(sideId),opponent=this.runner.side(sideId==='B'?'A':'B');
    const common={side,opponent,topic:this.runner.topic,turn:{text:turn?.text||''},memory:this.memory.snapshot()};
    let messages,verdict;
    if(kind==='reaction')messages=buildReactionMessages({...common,comment:item.text,mood:item.mood,social:item.social});
    else if(kind==='mention')messages=buildMentionMessages({...common,audience:{name:item.name,text:item.text}});
    else messages=buildGiftMessages({...common,gift:{label:item.label,count:item.count,name:item.name}});
    try{
      const raw=await this.complete(messages,{maxTokens:400,timeoutMs:kind==='reaction'?11000:25000});
      const limits=kind==='reaction'?(item.social?SOCIAL_LIMITS:REPLY_LIMITS):kind==='mention'?MENTION_LINE:GIFT_LINE;
      const text=repairReaction(raw,limits).text;
      verdict=kind==='reaction'?validateReaction(text,{source:item.text,social:item.social}):kind==='mention'?validateMention(text):validateGift(text);
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
    const hasAudienceName=typeof event.name==='string'&&Boolean(event.name.trim());
    const check=this.safety.ingress(event);if(check.blocked){this.emit();return {blocked:true};}event=check.next;
    if(event.id){this.seen.add(event.id);if(this.seen.size>4000)this.seen.delete(this.seen.values().next().value);}
    if(event.type==='comment'){
      if(this.cycle.phase==='vote'){
        const vote=this.cycle.vote.cast(event);if(vote.ok){this.emit();return {vote};}
      }
      const campSide=parseCamp(event.text,this.camps.sides.length?this.camps.sides:[{id:'A',name:this.engine.config.characterName},{id:'B',name:this.engine.config.opponentName}]);
      if(campSide){
        // Consume commands so repeated joins never enter model queues or mentions.
        const camp=this.runner.active?this.camps.cast({...event,name:hasAudienceName?event.name:''},campSide):{ok:false,reason:'closed'};
        if(camp.ok&&!camp.duplicate){
          const side=this.camps.sides.find(row=>row.id===campSide);
          this.engine.log('camp',event.name,`${event.name||'观众'}${camp.changed?' 转入':' 加入'}${side.name}阵营${camp.weak?'（按昵称去重）':''}`);
        }
        this.emit();return {camp};
      }
      if(this.runner.active){const result=this.runner.comment(event);this.emit();return result;}
      // Intermission chat is part of this show; it has no work, lounge or music subsystem.
      const user=event.userId||event.name||'anonymous',now=Date.now();
      if(this.chatPending<2&&now-(this.chatUsers.get(user)||0)>10000&&this.llm.view().hasKey){
        this.chatUsers.set(user,now);this.chatPending++;const epoch=this.epoch;
        const job=this.complete([{role:'system',content:`你是辩论直播的暖场主播${this.engine.config.characterName}。自然接观众的话，简短优先，最多60字，短答也可以；不报票数，不捏造场上事实，不输出旁白。${personaPrompt(this.runner.side('A')||{style:debateSides(null,this.engine.config)[0].style})}${memoryPrompt(this.memory.snapshot())}${SAFETY_PROMPT}`},{role:'user',content:JSON.stringify({弹幕:event.text})}],{maxTokens:150,timeoutMs:12000})
          .then(text=>{if(epoch===this.epoch&&!this.runner.active&&!this.closed){this.engine.state.running=true;this.engine.say(text.slice(0,60),'happy');this.emit();}})
          .catch(()=>{}).finally(()=>this.chatPending--);this.track(job);
      }
      this.engine.log('comment',event.name,event.text);this.emit();return {heard:true};
    }
    if(event.type==='gift'){
      const count=Number(event.count??1);if(!Number.isInteger(count)||count<1||count>100000)throw new Error('礼物数量无效');
      const giftVote=this.runner.active?this.camps.gift({...event,count}):{ok:false,reason:'closed'};
      const out=this.runner.active?this.runner.gift({...event,count}):{queued:false};
      const credit=giftVote.ok&&!giftVote.duplicate?`，${this.camps.sides.find(side=>side.id===giftVote.side).name} +${giftVote.points} 票`:'';
      const note=!credit&&!out?.queued&&['missing-id','capacity','invalid-count','overflow'].includes(giftVote.reason)?`，未计票：${{ 'missing-id':'缺少消息 ID',capacity:'本场礼物记录已满','invalid-count':'数量无效',overflow:'票数超出范围'}[giftVote.reason]}`:'';
      this.engine.log('gift',event.name,`${event.label||event.giftName||event.gift||'礼物'} ×${count}${credit}${out?.queued?'，已排入幕间回应':credit?'':'，已记录'}${note}`);this.emit();return {...out,giftVote};
    }
    return {heard:true};
  }
  finishCamps(){
    if(!this.camps.close())return;
    const camps=this.camps.view();
    this.engine.log('camp','本场阵营支持',`${camps.sides.map(side=>`${side.name} ${side.votes} 票`).join(' · ')}，共 ${camps.totalVotes} 票；下一场重新计票`);
  }
  async rewrite(actNumber){
    if(!this.runner.active||!this.playingTopic)throw new Error('没有正在播放的剧本');
    const act=ACTS[actNumber-1];if(!act)throw new Error('幕号无效');
    const writer=new ScriptWriter({complete:(m,o)=>this.complete(m,o),topic:this.runner.topic,sides:this.runner.sides,memory:this.memory});
    const out=await writer.write({acts:[act]});this.controller.signal.throwIfAborted();
    for(const turn of out.turns)if(this.safety.check(turn.text).blocked)throw new Error('重写台词命中播出屏蔽规则');
    const result=this.runner.replaceAct(actNumber,out.turns);this.emit();return result;
  }
  async configure(input){if(this.busy)throw new Error('请先停止场次再修改辩手配置');this.engine.configure(input);await this.store.save(this.engine.serialize());return this.engine.config;}
  async close(){this.closed=true;await this.stop();await this.platform?.stop();await this.store.save(this.engine.serialize());}
}
