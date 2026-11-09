import http from 'node:http';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {createReadStream,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {DebateRuntime,validateScript} from './runtime.mjs';

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.mp3':'audio/mpeg','.moc3':'application/octet-stream'};
function json(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req){let size=0;const chunks=[];for await(const part of req){size+=part.length;if(size>1024*1024)throw new Error('请求不能超过 1 MB');chunks.push(part);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw new Error('请求 JSON 无效');}}
export function pythonSpeech(root) {
  const bundled=path.join(root,'runtime','python',process.platform==='win32'?'python.exe':'bin/python3');
  const venv=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const executable=process.env.AI_PYTHON||(existsSync(bundled)?bundled:venv);
  return (payload,{signal}={})=>new Promise((resolve,reject)=>{
    signal?.throwIfAborted();
    const child=spawn(executable,[path.join(root,'lib','tts.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='',settled=false;
    const done=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{child.kill();done(signal.reason||new Error('语音任务已取消'));};
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{child.kill();done(new Error('Edge 语音合成超时'));},30000);
    child.stdout.on('data',chunk=>out+=chunk.toString('utf8'));child.stderr.on('data',chunk=>err=(err+chunk.toString('utf8')).slice(-1000));
    child.on('error',()=>done(new Error('未找到 Python 运行时，请运行 setup-audio.cmd')));child.stdin.on('error',()=>{});
    child.on('close',code=>{if(code!==0)return done(new Error(err||'Edge 语音合成失败'));try{done(null,JSON.parse(out));}catch{done(new Error('语音返回格式错误'));}});
    child.stdin.end(JSON.stringify(payload));
  });
}
export async function createApplication({root,dataDir=path.join(root,'data'),...options}) {
  let edge={available:false,checking:true,message:'正在检查 Edge 语音运行时'};
  const edgeSpeech=options.edgeSpeech||pythonSpeech(root);
  const runtime=await new DebateRuntime({root,dataDir,edgeSpeech,edgeStatus:()=>edge,...options}).init();
  edgeSpeech({action:'check'}).then(()=>{edge={available:true,checking:false,message:'Edge 语音已就绪，合成需要联网'};runtime.emit();},error=>{edge={available:false,checking:false,message:error.message};runtime.emit();});
  const publicDir=path.join(root,'public'),audioDir=path.join(dataDir,'audio');
  const peers=new Set();let coreJob;
  const send=snapshot=>{const packet='data: '+JSON.stringify(snapshot)+'\n\n';for(const peer of peers)if(peer.writableLength<1024*1024)peer.write(packet);else peer.destroy();};
  runtime.listeners.add(send);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    try {
      const url=new URL(req.url,'http://127.0.0.1');
      if(req.method==='GET'&&url.pathname==='/api/events'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
        res.write('data: '+JSON.stringify(runtime.snapshot())+'\n\n');peers.add(res);req.on('close',()=>peers.delete(res));return;
      }
      if(req.method==='GET'){
        if(url.pathname==='/api/health')return json(res,200,{ok:true,app:'ai-bianlun',mode:'long-form'});
        if(url.pathname==='/api/state')return json(res,200,runtime.snapshot());
        if(url.pathname==='/api/script')return json(res,200,runtime.runner.view());
        if(url.pathname==='/api/cycle')return json(res,200,runtime.cycle.view());
        if(url.pathname==='/api/safety')return json(res,200,runtime.safety.settings());
        if(url.pathname==='/voices.json'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(await readFile(path.join(root,'voices.json')));}
        if(url.pathname==='/api/scripts')return json(res,200,{scripts:runtime.scripts});
        if(url.pathname==='/api/scripts/export')return json(res,200,await runtime.loadScript(url.searchParams.get('id')));
        if(url.pathname==='/api/avatar/core.js'){
          // Keep proprietary Core outside the source distribution. Fetch only from Live2D's official host.
          const file=path.join(dataDir,'live2d','core.js');
          if(!existsSync(file)){
            coreJob ||= (async()=>{const response=await fetch('https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',{signal:AbortSignal.timeout(20000),redirect:'error'});if(!response.ok)throw new Error('Live2D Core 下载失败');const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<10000||bytes.length>4*1024*1024)throw new Error('Live2D Core 文件无效');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,bytes);})().finally(()=>coreJob=null);
            await coreJob;
          }
          res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(await readFile(file));
        }
      }
      if(req.method==='POST'){
        const expected=new Set(['http://'+req.headers.host]);
        if(req.headers.origin&&!expected.has(req.headers.origin))return json(res,403,{error:'只接受本机工作台请求'});
        if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'不接受跨站请求'});
        const input=await body(req);let result={};
        switch(url.pathname){
          case '/api/config':result={config:await runtime.configure(input)};break;
          case '/api/llm/settings':if(runtime.busy)throw new Error('请先停止场次再修改模型');result={llm:await runtime.llm.configure(input)};break;
          case '/api/llm/test':await runtime.complete([{role:'user',content:'只回复：接口正常'}],{maxTokens:20,timeoutMs:15000});result={message:'模型接口正常'};break;
          case '/api/llm/models':result={models:await runtime.llm.models()};break;
          case '/api/voice/settings':if(runtime.busy)throw new Error('请先停止场次再修改语音');result={voice:await runtime.cloudVoice.configure(input)};break;
          case '/api/voice/test':{
            const settings={...runtime.engine.config,voiceName:input.side==='B'?runtime.engine.config.opponentVoice:runtime.engine.config.voiceName};
            result=await runtime.voice.render({text:'这里是 AI 辩论现场。道理讲清楚，观点交给你。',emotion:'happy'},settings);break;
          }
          case '/api/live/settings':if(!runtime.platform)throw new Error('未启用平台接入');result={platform:await runtime.platform.configure(input)};break;
          case '/api/live/connect':if(!runtime.platform)throw new Error('未启用平台接入');result={platform:await runtime.platform.connectReady()};break;
          case '/api/live/disconnect':runtime.platform?.disconnect();break;
          case '/api/script/generate':result={operation:runtime.generate(input)};break;
          case '/api/scripts/generate-batch':result={operation:runtime.generateBatch(input)};break;
          case '/api/scripts/enabled':await runtime.setScriptEnabled(input.scriptId,input.enabled);break;
          case '/api/scripts/audio':result={operation:runtime.preRender(input.scriptId)};break;
          case '/api/script/start':result={operation:runtime.startSingle(input)};break;
          case '/api/script/import':{
            runtime.assertFree();const script=validateScript(input.script,runtime.safety);script.id='import-'+randomUUID();script.meta={...script.meta,generatedAt:script.meta.generatedAt||new Date().toISOString(),ready:true,estTotalSec:script.turns.reduce((sum,t)=>sum+t.estSec,0)};await runtime.saveScript(script);result={scriptId:script.id};break;
          }
          case '/api/script/pause':result={paused:runtime.runner.pause()};break;
          case '/api/script/resume':result=runtime.runner.resume();runtime.engine.state.running=runtime.runner.active;break;
          case '/api/script/skip':result=runtime.skip();break;
          case '/api/script/rewrite':result=await runtime.rewrite(Number(input.act));break;
          case '/api/script/stop':case '/api/cycle/stop':await runtime.stop();break;
          case '/api/cycle/start':result={operation:runtime.startCycle(input)};break;
          case '/api/vote/lock':if(runtime.cycle.phase!=='vote')throw new Error('当前不在投票阶段');result={result:runtime.cycle.vote.lock({topicId:input.topicId||''})};break;
          case '/api/vote/cast':result=runtime.cycle.vote.cast(input);break;
          case '/api/events':result=await runtime.receive(input);break;
          case '/api/safety':result={safety:await runtime.safety.configure(input)};runtime.safeAudio.clear();runtime.engine.utterances=[];runtime.epoch++;await runtime.refreshScripts();break;
          case '/api/player':{
            if(typeof input.id!=='string'||input.id.length>100||!input.id)throw new Error('播放器编号无效');
            if(input.action==='release'){if(runtime.player.id===input.id)runtime.player={id:'',until:0};}
            else{if(runtime.player.until>Date.now()&&runtime.player.id!==input.id)return json(res,409,{error:'另一个页面正在播放声音'});runtime.player={id:input.id,until:Date.now()+10000};}break;
          }
          case '/api/speech':{
            const item=runtime.engine.utterances.find(x=>x.id===input.id);if(!item)throw new Error('这条台词已过期');
            if(runtime.safety.check(item.text).blocked)throw new Error('台词命中播出屏蔽规则');
            if(item.audio){runtime.safeAudio.set(item.audio,runtime.safety.revision);result={url:item.audio,durationMs:item.durationMs||0};}
            else result=await runtime.voice.render(item,{...runtime.engine.config,voiceName:item.voice});break;
          }
          case '/api/playback':{
            if(runtime.player.id!==input.playerId||runtime.player.until<Date.now())throw new Error('播放权已过期');
            if(input.id===null)runtime.playback.until=0;
            else{const item=runtime.engine.utterances.find(x=>x.id===input.id);if(!item)throw new Error('台词已过期');if(!Number.isFinite(input.duration)||input.duration<=0||input.duration>180)throw new Error('播放时长无效');runtime.runner.voiceStarted(item.id);runtime.playback={id:item.id,text:item.text,speaker:item.speaker,emotion:item.emotion,level:0,until:Date.now()+input.duration*1000};}break;
          }
          case '/api/meter':if(runtime.player.id===input.playerId)runtime.playback.level=Math.max(0,Math.min(1,Number(input.level)||0));break;
          default:return json(res,404,{error:'接口不存在'});
        }
        runtime.emit();return json(res,200,{ok:true,...result});
      }
      if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'不支持此方法'});
      if(url.pathname.startsWith('/api/'))return json(res,404,{error:'接口不存在'});
      const isAudio=url.pathname.startsWith('/audio/');
      if(isAudio&&runtime.safeAudio.get(url.pathname)!==runtime.safety.revision)return json(res,403,{error:'音频尚未通过本次播出检查'});
      const base=isAudio?audioDir:publicDir,relative=decodeURIComponent(isAudio?url.pathname.slice(7):url.pathname==='/'?'index.html':url.pathname.slice(1));
      const filename=path.resolve(base,relative),rel=path.relative(base,filename);
      if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||relative.includes('\0'))return json(res,403,{error:'路径无效'});
      const info=await stat(filename);if(!info.isFile())return json(res,404,{error:'文件不存在'});
      res.writeHead(200,{'Content-Type':MIME[path.extname(filename)]||'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache'});
      if(req.method==='HEAD')return res.end();createReadStream(filename).on('error',()=>res.destroy()).pipe(res);
    }catch(error){if(!res.headersSent)json(res,error.code==='ENOENT'?404:400,{error:error.code==='ENOENT'?'文件不存在':error.message});else res.destroy();}
  });
  const heartbeat=setInterval(()=>runtime.emit(),500);heartbeat.unref();
  const close=async()=>{clearInterval(heartbeat);await runtime.close();for(const peer of peers)peer.end();await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});};
  return {server,runtime,close};
}
