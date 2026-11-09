import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {Storage,readSave} from './storage.mjs';
import {DouyinEvents,GIFT_MAP,roomNumber,validateGiftMap} from './douyin-events.mjs';
export class Douyin {
 constructor({root,dataDir,handle,onChange=()=>{},spawnProcess=spawn,restartDelayMs=2000}){
  this.root=root;this.handle=handle;this.onChange=onChange;this.spawnProcess=spawnProcess;this.restartDelayMs=restartDelayMs;this.restartTimer=null;this.watchdog=null;this.restarts=0;this.store=new Storage(path.join(dataDir,'douyin-settings.json'));this.eventStore=new Storage(path.join(dataDir,'douyin-watermarks.json'));this.config={room:'',cookie:'',networkMode:'auto',giftMap:structuredClone(GIFT_MAP)};this.events=new DouyinEvents();this.state={state:'disconnected',message:'尚未连接，开播后填写直播间号',received:0,duplicates:0,stale:0,reconnects:0,lastEventAt:null,dependency:'checking',transport:'direct',retryAt:null};this.child=null;this.queue=Promise.resolve();this.generation=0;
 }
 async init(){const settings=await readSave(this.store.filename);if(settings){this.config={room:settings.room?roomNumber(settings.room):'',cookie:typeof settings.cookie==='string'?settings.cookie:'',networkMode:['auto','direct','system'].includes(settings.networkMode)?settings.networkMode:'auto',giftMap:validateGiftMap(settings.giftMap||GIFT_MAP)};}this.events=new DouyinEvents(await readSave(this.eventStore.filename));await this.check();}
 view(){return {...this.state,room:this.config.room,networkMode:this.config.networkMode,hasCookie:Boolean(this.config.cookie),giftMap:this.config.giftMap};}
 python(){
  if(process.env.AI_PYTHON)return process.env.AI_PYTHON;
  const exe=process.platform==='win32'?'python.exe':'bin/python';
  const venv=path.join(this.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(existsSync(venv))return venv;
  const here=path.join(this.root,'runtime','python',exe);
  if(existsSync(here))return here;
  return venv;
 }
 async check(){
  if(this.checking)return this.checking;
  this.state.dependency='checking';this.onChange();
  const job=new Promise(resolve=>{
   let done=false,output='',stderr='',timer;
   const finish=(ok,reason='')=>{if(done)return;done=true;clearTimeout(timer);this.state.dependency=ok?'ready':'missing';this.state.dependencyError=ok?'':reason;if(!ok)this.state.message='接入依赖未就绪：'+reason;else if(['disconnected','error'].includes(this.state.state))this.state.message='接入依赖正常，可以连接直播间';this.onChange();resolve(ok);};
   let child;try{child=this.spawnProcess(this.python(),[path.join(this.root,'integrations/douyin/worker.py')],{cwd:this.root,env:{...process.env,PYTHONIOENCODING:'utf-8'},windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{finish(false,'Python 无法启动，请安装依赖或使用 EXE 版');return;}
   timer=setTimeout(()=>{child.kill();finish(false,'依赖检查超时，请重试');},30000);
   child.stdout.on('data',b=>{output+=b.toString();});child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-4000);});child.stdin.on('error',()=>{});
   child.on('error',error=>finish(false,error.code==='ENOENT'?'未找到项目 Python，请安装依赖或使用 EXE 版':'Python 无法启动：'+(error.code||'未知错误')));
   child.on('close',code=>{const missing=stderr.match(/No module named ['"]?([A-Za-z0-9_.]+)/);const reason=missing?'缺少模块 '+missing[1]+'，请重新安装依赖':stderr.includes('DLL load failed')?'Python DLL 加载失败，请使用完整 EXE 版':'依赖或签名组件检查失败，请运行安装脚本查看详情';finish(code===0&&output.includes('"ready"'),reason);});child.stdin.end(JSON.stringify({action:'check'})+'\n');
  });
  this.checking=job;try{return await job;}finally{this.checking=null;}
 }
 async connectReady(){if(!this.config.room)throw new Error('请先填写直播间链接或直播间号');if(this.state.dependency!=='ready'&&!await this.check())throw new Error(this.state.message);return this.connect();}
 async configure(input){
  const next={...this.config};if(input.room!==undefined){if(typeof input.room!=='string')throw new Error('直播间号格式无效');next.room=input.room.trim()?roomNumber(input.room):'';}
  if(input.networkMode!==undefined){if(!['auto','direct','system'].includes(input.networkMode))throw new Error('连接方式无效');next.networkMode=input.networkMode;}
  if(input.cookie!==undefined){if(typeof input.cookie!=='string'||input.cookie.length>12000||/[\r\n]/.test(input.cookie))throw new Error('Cookie 格式无效');next.cookie=input.cookie.trim();}
  if(input.clearCookie===true)next.cookie='';if(input.giftMap!==undefined)next.giftMap=validateGiftMap(input.giftMap);
  await this.store.save(next);const changed=JSON.stringify(next)!==JSON.stringify(this.config);this.config=next;if(changed&&this.child)this.disconnect();this.onChange();return this.view();
 }
 connect(){
  if(!this.config.room)throw new Error('开播后请先填写直播间号');if(this.state.dependency!=='ready')throw new Error('抖音接入依赖尚未就绪');
  this.disconnect();const generation=++this.generation;this.started=Date.now();this.restarts=0;return this.spawnReceiver(generation);
 }
 spawnReceiver(generation){
  if(generation!==this.generation)return this.view();
  this.state.state=this.restarts?'reconnecting':'connecting';this.state.message=this.restarts?'接收进程恢复中，正在重新连接':'正在连接抖音直播间';this.state.retryAt=null;this.onChange();this.lastWorkerAt=Date.now();
  const child=this.spawnProcess(this.python(),[path.join(this.root,'integrations/douyin/worker.py')],{cwd:this.root,env:{...process.env,PYTHONIOENCODING:'utf-8'},windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{if(generation!==this.generation||this.child!==child)return;this.lastWorkerAt=Date.now();try{const m=JSON.parse(line);if(m.kind==='status'){this.state.state=['connected','connecting','reconnecting','offline','error'].includes(m.state)?m.state:'error';this.state.message=String(m.message||'').slice(0,240);if(m.transport)this.state.transport=m.transport;if(m.state==='connected'){this.restarts=0;this.state.retryAt=null;}this.onChange();}else if(m.kind==='event'){if(Number(m.event.timestamp)&&Number(m.event.timestamp)*1000<this.started-60000){this.state.stale++;return;}this.ingest(m.event).catch(()=>{});}else if(m.kind==='retry'){this.state.retryAt=Date.now()+Number(m.seconds||2)*1000;this.state.reconnects++;this.onChange();}else if(m.kind==='health'){this.state.lastHeartbeatAt=new Date().toISOString();}else if(m.kind==='warning'){this.state.message=String(m.message).slice(0,240);this.onChange();}}catch{this.state.message='接入进程输出格式异常';this.onChange();}});
  let restarted=false;const recover=()=>{if(restarted||generation!==this.generation||this.child!==child)return;restarted=true;clearInterval(this.watchdog);this.watchdog=null;this.child=null;lines.close();this.state.state='reconnecting';this.state.message='接收进程已退出，正在自动恢复';this.state.reconnects++;const delay=Math.min(15000,this.restartDelayMs*2**Math.min(this.restarts++,3));this.state.retryAt=Date.now()+delay;this.onChange();this.restartTimer=setTimeout(()=>{this.restartTimer=null;if(generation===this.generation)this.spawnReceiver(generation);},delay);this.restartTimer.unref?.();};
  child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',recover);child.on('close',recover);
  this.watchdog=setInterval(()=>{if(generation===this.generation&&Date.now()-this.lastWorkerAt>90000){recover();child.kill();}},5000);this.watchdog.unref?.();
  child.stdin.end(JSON.stringify(this.config)+'\n');return this.view();
 }
 disconnect(){this.generation++;clearTimeout(this.restartTimer);clearInterval(this.watchdog);this.restartTimer=null;this.watchdog=null;if(this.child){this.child.kill();this.child=null;}this.state.state='disconnected';this.state.retryAt=null;this.state.message='已断开抖音连接';this.onChange();}
 ingest(raw,source='douyin'){
  const job=this.queue.catch(()=>{}).then(async()=>{const e=this.events.normalize(raw,this.config.giftMap,source);if(!e){this.state.duplicates++;this.onChange();return {duplicate:true};}await this.handle(e);await this.eventStore.save(this.events.serialize());this.state.received++;this.state.lastEventAt=new Date().toISOString();this.onChange();return {duplicate:false,event:e};}).catch(error=>{this.state.message='事件处理异常：'+error.message;this.onChange();throw error;});this.queue=job;return job;
 }
 async stop(){this.disconnect();await this.queue.catch(()=>{});}
}
