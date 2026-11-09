import {post} from './api.js';
export class Speaker {
  constructor(status=()=>{}){
    this.status=status;this.id=crypto.randomUUID();this.enabled=false;this.seen=new Set();this.queue=[];this.generation=0;this.audio=new Audio();this.audio.preload='auto';this.busy=false;this.latest=null;
    this.timer=setInterval(()=>{if(this.enabled)post('/api/player',{id:this.id}).catch(error=>this.disable(error.message));},3000);
    addEventListener('pagehide',()=>{if(this.enabled)navigator.sendBeacon('/api/player',new Blob([JSON.stringify({id:this.id,action:'release'})],{type:'application/json'}));});
  }
  async enable(){
    // Resume and play inside the user gesture, before waiting for the HTTP lease.
    this.context ||= new AudioContext();this.context.resume().catch(()=>{});
    if(!this.analyser){this.analyser=this.context.createAnalyser();this.analyser.fftSize=512;this.samples=new Float32Array(512);this.context.createMediaElementSource(this.audio).connect(this.analyser);this.analyser.connect(this.context.destination);}
    this.audio.src='data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAACAgA==';
    await this.audio.play().catch(()=>{});await post('/api/player',{id:this.id});this.enabled=true;this.status(true,'声音已开启');
    if(this.latest)this.update(this.latest);
    if(!this.meter)this.meter=setInterval(()=>{
      if(!this.enabled||!this.busy||this.audio.paused)return;
      this.analyser.getFloatTimeDomainData(this.samples);const rms=Math.sqrt(this.samples.reduce((s,x)=>s+x*x,0)/this.samples.length);
      this.level=Math.min(1,rms*4);post('/api/meter',{playerId:this.id,level:this.level}).catch(()=>{});
    },180);
  }
  update(data){
    if(this.latest&&data.epoch!==this.latest.epoch)this.cancel();
    this.latest=data;this.audio.volume=data.config.volume;
    if(!this.enabled){for(const item of data.utterances)this.seen.add(item.id);return;}
    if(!data.state.running){this.cancel();for(const item of data.utterances)this.seen.add(item.id);return;}
    for(const item of data.utterances){if(this.seen.has(item.id))continue;this.seen.add(item.id);if(Date.now()-Date.parse(item.at)<60000)this.queue.push(item);}
    if(this.seen.size>300)this.seen=new Set(data.utterances.map(x=>x.id));
    this.pump();
  }
  cancel(){this.generation++;this.queue=[];this.abort?.abort();this.audio.pause();this.finish?.();this.finish=null;this.busy=false;this.level=0;}
  disable(message='声音已关闭'){this.enabled=false;this.cancel();post('/api/player',{id:this.id,action:'release'}).catch(()=>{});this.status(false,message);}
  async pump(){
    if(this.busy||!this.enabled||!this.queue.length)return;
    const item=this.queue.shift(),generation=this.generation;this.busy=true;
    try{
      const response=item.audio?{url:item.audio,durationMs:item.durationMs}:await post('/api/speech',{id:item.id});
      if(generation!==this.generation||!this.enabled)return;
      this.audio.src=response.url;this.audio.load();
      await new Promise((resolve,reject)=>{
        let timer;const cleanup=()=>{clearTimeout(timer);this.audio.removeEventListener('ended',end);this.audio.removeEventListener('error',fail);this.audio.removeEventListener('playing',started);};
        const end=()=>{cleanup();resolve();};const fail=()=>{cleanup();reject(new Error('语音播放失败，请检查音频输出'));};
        const started=()=>{const duration=Number.isFinite(this.audio.duration)?this.audio.duration:(response.durationMs||3000)/1000;post('/api/playback',{playerId:this.id,id:item.id,duration}).catch(()=>{});};
        this.finish=end;this.audio.addEventListener('ended',end,{once:true});this.audio.addEventListener('error',fail,{once:true});this.audio.addEventListener('playing',started,{once:true});
        timer=setTimeout(fail,180000);this.audio.play().catch(error=>{cleanup();reject(error);});
      });
      if(generation===this.generation)post('/api/playback',{playerId:this.id,id:null}).catch(()=>{});
    }catch(error){if(generation===this.generation)this.status(true,error.name==='NotAllowedError'?'浏览器阻止自动播放，请再次点击开启声音':error.message);}
    finally{if(generation===this.generation){this.busy=false;this.finish=null;this.level=0;this.pump();}}
  }
}
