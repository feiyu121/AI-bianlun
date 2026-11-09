import {defaultSafety} from './safety.mjs';
export const DEFAULTS=Object.freeze({
  title:'AI 辩论现场',characterName:'小澜',opponentName:'鲸鱼娘',
  voiceName:'zh-CN-XiaoxiaoNeural',opponentVoice:'zh-CN-XiaoyiNeural',
  speechRate:0,voicePitch:0,volume:0.85
});
export class Studio {
  constructor({saved,safety=defaultSafety}={}) {
    this.safety=safety;this.config={...DEFAULTS};this.configure(saved?.config||{});
    this.sequence=0;this.logs=[];this.utterances=[];
    this.state={running:false,broadcastMode:'debate',mode:'debate',subtitle:'',speakingSide:'',emotion:'focus'};
  }
  configure(input) {
    const next={...this.config};
    for(const [key,value] of Object.entries(input)) {
      if(!(key in DEFAULTS))throw new Error('未知设置：'+key);
      if(['volume','speechRate','voicePitch'].includes(key)) {
        const [min,max]=key==='volume'?[0,1]:key==='speechRate'?[-5,5]:[-30,30];
        if(!Number.isFinite(value)||value<min||value>max)throw new Error(key+' 超出允许范围');
        if(key!=='volume'&&!Number.isInteger(value))throw new Error(key+' 需要整数');
      } else if(typeof value!=='string'||!value.trim()||value.length>(key.includes('Voice')||key==='voiceName'?100:30))throw new Error(key+' 格式无效');
      if(typeof value==='string'&&this.safety.check(value).blocked)throw new Error('设置命中屏蔽规则');
      next[key]=typeof value==='string'?value.trim():value;
    }
    if(next.voiceName===next.opponentVoice)throw new Error('两位辩手请选择不同音色');
    this.config=next;return next;
  }
  log(type,title,detail='',source='local') {
    this.logs.unshift({id:++this.sequence,at:new Date().toISOString(),type,title,detail,source});
    this.logs.length=Math.min(this.logs.length,100);
  }
  say(text,emotion='focus',priority=2,speaker='A') {
    const item={id:++this.sequence,at:new Date().toISOString(),text:this.safety.output(text),emotion,priority,speaker,kind:'announcement',voice:speaker==='B'?this.config.opponentVoice:this.config.voiceName};
    this.utterances.push(item);if(this.utterances.length>96)this.utterances.shift();return item;
  }
  start(){this.state.running=true;}
  view(){return {state:{...this.state},config:{...this.config},utterances:this.utterances,logs:this.logs};}
  serialize(){return {version:1,config:this.config};}
}
