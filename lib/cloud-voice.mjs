import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {stat,writeFile,rename,unlink,readFile} from 'node:fs/promises';
import {Storage,readSave} from './storage.mjs';

export const CLOUD_VOICE_DEFAULTS=Object.freeze({provider:'edge',authMode:'api-key',apiKey:'',appId:'',accessToken:'',resourceId:'seed-tts-2.0',speaker:'zh_female_vv_uranus_bigtts',opponentSpeaker:'',speechRate:0,pitch:0,style:'像俏皮的虚拟主播和观众聊天，口语自然，有轻松的起伏和停顿，不要播音腔，不要机械逐字朗读。',emotionMode:'auto',emotionScale:3,fallback:true});
const RESOURCES=new Set(['seed-tts-2.0','seed-tts-1.0','seed-tts-1.0-concurr','seed-icl-2.0','seed-icl-1.0','seed-icl-1.0-concurr']);
const EMOTIONS=new Set(['auto','neutral','happy','angry','sad','surprised']);
export const VOICE_ENDPOINT='https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse';
const instruction={happy:'带着开心的笑意说话，像和熟悉的观众接梗。',love:'温柔、亲切地表达感谢，有轻轻的笑意。',angry:'用可爱的、略带生气的撒娇口气说话，不要大吼。',excited:'用兴奋、轻快、有活力的语气说话。',shock:'带一点惊讶和慌张，自然地说话。',dizzy:'有一点委屈、迷糊的口气，保持清楚。',focus:'轻松自然地聊天，不要播音腔。',neutral:'自然地说话，有正常停顿。',sad:'用柔和、略带失落的口气说话。',surprised:'用惊讶的口气说话。'};
const emotionNames={love:'happy',excited:'happy',shock:'surprised',dizzy:'sad',focus:'neutral'};

// 音频真实时长。原先排程按「字数 × 210ms」估，声音和气泡就是两条独立时间线：
// 实测同一个 speechRate 下，Xiaoxiao 比估算短 3~10%，HsiaoYu 却长 22%。
// 短了每句结尾空 0.5~1 秒，长了队列积压、气泡跑到声音前面——两种都是观众能直接看出来的。
// 合成完文件就在本地，量一下比猜便宜。
export function mp3Duration(buf){
 let i=0;
 if(buf.length>10&&buf.slice(0,3).toString()==='ID3')i=10+(((buf[6]&0x7f)<<21)|((buf[7]&0x7f)<<14)|((buf[8]&0x7f)<<7)|(buf[9]&0x7f));
 const brV1=[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
 const brV2=[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
 const rates={3:[44100,48000,32000],2:[22050,24000,16000],0:[11025,12000,8000]};
 let samples=0,rate=24000;
 while(i+4<=buf.length){
  if(buf[i]!==0xFF||(buf[i+1]&0xE0)!==0xE0){i++;continue;}
  const ver=(buf[i+1]>>3)&3,layer=(buf[i+1]>>1)&3;
  const brIdx=(buf[i+2]>>4)&0xF,srIdx=(buf[i+2]>>2)&3,pad=(buf[i+2]>>1)&1;
  // 只认 Layer III；采样率索引 3 是保留值，码率 0/15 不是合法帧。
  if(layer!==1||srIdx===3||brIdx===0||brIdx===15){i++;continue;}
  const v1=ver===3,bitrate=(v1?brV1:brV2)[brIdx]*1000,sr=rates[v1?3:ver===2?2:0][srIdx];
  const len=Math.floor((v1?144:72)*bitrate/sr)+pad;
  if(len<=0){i++;continue;}
  samples+=v1?1152:576;rate=sr;i+=len;
 }
 const seconds=samples/rate;
 // 不到 0.2 秒大概是解析失败或半截文件，宁可回 0 让调用方退回字数估算。
 return seconds>=0.2?Math.round(seconds*1000):0;
}

function textField(value,name,max){if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new Error(name+'格式无效');return value.trim();}
export function validateVoiceSettings(input,current=CLOUD_VOICE_DEFAULTS){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('语音配置必须是对象');
 const next={...current};for(const key of Object.keys(input))if(!(key in CLOUD_VOICE_DEFAULTS)&&!['clearKey','clearToken'].includes(key))throw new Error('未知语音配置：'+key);
 for(const [key,max]of [['apiKey',2000],['appId',100],['accessToken',2000],['speaker',160],['opponentSpeaker',160],['style',400]])if(input[key]!==undefined)next[key]=textField(input[key],key,max);
 for(const [key,allowed]of [['provider',['edge','volcengine']],['authMode',['api-key','legacy']],['resourceId',RESOURCES],['emotionMode',EMOTIONS]])if(input[key]!==undefined){if(![...allowed].includes(input[key]))throw new Error(key+'选项无效');next[key]=input[key];}
 for(const [key,min,max]of [['speechRate',-50,100],['pitch',-12,12],['emotionScale',1,5]])if(input[key]!==undefined){if(!Number.isInteger(input[key])||input[key]<min||input[key]>max)throw new Error(key+'需要为'+min+'～'+max+'的整数');next[key]=input[key];}
 if(input.fallback!==undefined){if(typeof input.fallback!=='boolean')throw new Error('自动备用需要布尔值');next.fallback=input.fallback;}
 if(input.clearKey===true)next.apiKey='';if(input.clearToken===true)next.accessToken='';
 if(next.opponentSpeaker&&!/^[A-Za-z0-9_-]{1,160}$/.test(next.opponentSpeaker))throw new Error('反方云端音色 ID 无效');
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(next.speaker))throw new Error('请填写控制台中的音色 ID，不是音色名称');
 if(next.appId&&!/^[A-Za-z0-9_-]+$/.test(next.appId))throw new Error('App ID 格式无效');
 return next;
}
export function cloudReady(c){return c.authMode==='api-key'?Boolean(c.apiKey):Boolean(c.appId&&c.accessToken);}
export function voiceRequest(item,c){
 const audio_params={format:'mp3',sample_rate:24000,bit_rate:64000,speech_rate:c.speechRate};
 const additions={post_process:{pitch:c.pitch}};
 const selected=c.emotionMode==='auto'?(item.emotion||'happy'):c.emotionMode;
 if(c.resourceId==='seed-tts-2.0'){
  const directions=[c.style,c.emotionMode==='neutral'?'':instruction[selected]||instruction.happy].filter(Boolean).join(' ');
  if(directions)additions.context_texts=[directions];
 }else if(c.resourceId.includes('1.0')&&c.emotionMode!=='neutral'){
  const emotion=emotionNames[selected]||selected;if(['happy','angry','sad','surprised'].includes(emotion)){audio_params.emotion=emotion;audio_params.emotion_scale=c.emotionScale;}
 }
 // 指令走独立字段，避免将“开心地说”读进台词，也不改变字幕原文。
 return {user:{uid:'ai-bianlun'},req_params:{text:item.text,speaker:c.speaker,audio_params,additions:JSON.stringify(additions)}};
}
function redact(value,c){let result=String(value);for(const key of [c.apiKey,c.accessToken])if(key)result=result.split(key).join('[已隐藏]');return result.slice(0,320);}
function cloudError(message,code,c,logId=''){
 const hint=code===401?'鉴权失败，请检查语音 API Key 或 Access Token':code===403||code===45000000?'音色未授权或资源 ID 与音色不匹配':code===429?'语音并发受限或额度不足':code===404?'语音接口不存在':redact(message,c);
 return new Error('豆包语音：'+hint+(code?'（'+code+'）':'')+(logId?'；请求号 '+logId:''));
}
export async function readVoiceStream(response,c){
 if(!response.body)throw new Error('豆包语音返回空响应');
 const chunks=[];let pending='',bytes=0,wire=0,complete=false;const decoder=new TextDecoder();
 const parse=raw=>{
  raw=raw.trim();if(!raw||raw.startsWith(':')||/^(event|id|retry):/.test(raw))return;
  if(raw.startsWith('data:'))raw=raw.slice(5).trim();if(raw==='[DONE]'){complete=true;return;}
  let row;try{row=JSON.parse(raw);}catch{throw new Error('豆包语音响应格式错误，请核对服务接口');}
  if(typeof row.code!=='number')throw new Error('豆包语音响应缺少状态码');
  if(row.code!==0&&row.code!==20000000)throw cloudError(row.message||'合成失败',row.code,c,response.headers.get('x-tt-logid'));
  if(row.code===20000000)complete=true;
  if(row.data!==null&&row.data!==undefined&&row.data!==''){
   if(typeof row.data!=='string'||row.data.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(row.data))throw new Error('豆包语音返回无效音频编码');
   const audio=Buffer.from(row.data,'base64');bytes+=audio.length;if(bytes>8*1024*1024)throw new Error('单句语音超过8MB限制');chunks.push(audio);
  }
 };
 for await(const part of response.body){
  wire+=part.length;if(wire>16*1024*1024)throw new Error('语音响应超过16MB限制');
  pending+=decoder.decode(part,{stream:true});if(pending.length>12*1024*1024)throw new Error('语音数据帧过大');
  let index;while((index=pending.indexOf('\n'))>=0){parse(pending.slice(0,index));pending=pending.slice(index+1);}
 }
 pending+=decoder.decode();if(pending.trim())parse(pending);
 if(!complete)throw new Error('豆包语音连接提前中断，未收到合成完成标记');
 if(bytes<64)throw new Error('豆包语音没有返回有效音频');
 const data=Buffer.concat(chunks,bytes);
 if(data.subarray(0,3).toString()!=='ID3'&&!(data[0]===255&&(data[1]&224)===224))throw new Error('豆包语音返回内容不是 MP3 音频');
 return data;
}
export class CloudVoice{
 constructor({dataDir,audioDir,fetcher=fetch,edgeSpeech,edgeStatus=()=>({available:false,checking:true,message:'检测中'})}){
  this.store=new Storage(path.join(dataDir,'cloud-voice-settings.json'));this.audioDir=audioDir;this.fetcher=fetcher;this.edgeSpeech=edgeSpeech;this.edgeStatus=edgeStatus;this.config={...CLOUD_VOICE_DEFAULTS};this.jobs=new Map();this.tail=Promise.resolve();this.revision=0;
  this.status={verified:false,lastError:'',lastProvider:'',message:'尚未配置云端语音；当前沿用原音色'};
 }
 async init(){const saved=await readSave(this.store.filename);if(saved)this.config=validateVoiceSettings(saved);}
 view(){const {apiKey,accessToken,...config}=this.config;const edge=this.edgeStatus(),ready=cloudReady(this.config);return {...config,hasKey:Boolean(apiKey),hasToken:Boolean(accessToken),configured:ready,available:this.config.provider==='edge'?edge.available:(ready||(this.config.fallback&&edge.available)),checking:this.config.provider==='edge'?edge.checking:false,...this.status};}
 health(){const v=this.view();if(v.provider==='edge')return {provider:'edge-neural',...this.edgeStatus(),cloud:v};return {available:v.available,checking:false,provider:'volcengine',message:v.message,cloud:v};}
 async configure(input){
  // 空密钥表示沿用已存值；只有显式清除按钮才会删除，避免浏览器刷新把密钥覆盖为空。
  const update={...input};for(const key of ['apiKey','accessToken'])if(update[key]==='')delete update[key];
  const next=validateVoiceSettings(update,this.config);
  if(next.provider==='volcengine'&&(!next.opponentSpeaker||next.opponentSpeaker===next.speaker))throw new Error('请填写不同的正反方云端音色 ID');
  if(next.provider==='volcengine'&&!cloudReady(next))throw new Error(next.authMode==='api-key'?'启用前请填写豆包语音 API Key':'启用前请填写 App ID 和 Access Token');
  const changed=JSON.stringify(next)!==JSON.stringify(this.config);await this.store.save(next);this.config=next;
  if(changed){this.revision++;this.status={verified:false,lastError:'',lastProvider:'',message:next.provider==='volcengine'?'云端语音已启用，等待真实试听验证':'已切回原有 Edge 音色'};}
  return this.view();
 }
 capture(provider){return {...this.config,...(provider?{provider}:{}),revision:this.revision};}
 async cloud(item,c,{strict=true,signal:cancel}={}){
  if(!cloudReady(c))throw new Error(c.authMode==='api-key'?'请先保存豆包语音 API Key':'请先保存 App ID 和 Access Token');
  const headers={'Content-Type':'application/json','X-Api-Resource-Id':c.resourceId,'X-Api-Request-Id':randomUUID()};
  if(c.authMode==='api-key')headers['X-Api-Key']=c.apiKey;else{headers['X-Api-App-Id']=c.appId;headers['X-Api-Access-Key']=c.accessToken;}
  const deadline=AbortSignal.timeout(strict?18000:10000),signal=cancel?AbortSignal.any([cancel,deadline]):deadline;let response;
  try{response=await this.fetcher(VOICE_ENDPOINT,{method:'POST',headers,body:JSON.stringify(voiceRequest(item,c)),redirect:'error',signal});}
  catch(error){throw new Error(error.name==='TimeoutError'||signal.aborted?'豆包语音请求超时':'豆包语音连接失败，请检查网络');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw cloudError('HTTP '+response.status,response.status,c,response.headers.get('x-tt-logid'));}
  try{return await readVoiceStream(response,c);}catch(error){if(signal.aborted)throw new Error('豆包语音响应超时');throw error;}
 }
 async render(item,settings,{strict=false,provider,force=false,signal}={}){
  signal?.throwIfAborted();
  const c=this.capture(provider);if(settings.cloudSpeaker)c.speaker=settings.cloudSpeaker;if(typeof item.text!=='string'||!item.text.trim()||item.text.length>600)throw new Error('语音文本需要1～600字');
  const effective=voiceRequest(item,c);
  const identity=[c.provider,c.authMode,createHash('sha256').update(c.apiKey+'\0'+c.accessToken).digest('hex'),effective,settings.voiceName,settings.speechRate,settings.voicePitch,strict,c.fallback];
  const key=createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,32);
  if(!force&&this.jobs.has(key))return this.jobs.get(key);
  // 每个出口都带上真实时长；量不出来就留 0，调用方自己退回字数估算。
  // 缓存路径也要量——第二次播出走的就是这条，漏了它等于只有第一场准。
  const settle=async result=>{
   const file=path.join(this.audioDir,String(result.url||'').replace(/^\/audio\//,''));
   const durationMs=await readFile(file).then(mp3Duration).catch(()=>0);
   return {...result,durationMs};
  };
  const job=this.tail.catch(()=>{}).then(async()=>{
   signal?.throwIfAborted();
   const filename='speech-'+key+(force?'-'+randomUUID().slice(0,8):'')+'.mp3',target=path.join(this.audioDir,filename);
   const exists=await stat(target).catch(()=>null);
   if(!force&&exists?.size>64)return settle({url:'/audio/'+filename,provider:c.provider,cached:true});
   let actual=c.provider,warning='';
   try{
    if(c.provider==='volcengine'){
     const bytes=await this.cloud(item,c,{strict,signal}),temporary=target+'.'+randomUUID()+'.part';
     signal?.throwIfAborted();
     try{await writeFile(temporary,bytes);await rename(temporary,target);}finally{await unlink(temporary).catch(()=>{});}
    }else{
     if(!this.edgeStatus().available)throw new Error(this.edgeStatus().message);await this.edgeSpeech({text:item.text,voice:settings.voiceName,rate:settings.speechRate,pitch:settings.voicePitch,output:target,interactive:!strict},{signal});
    }
    if(c.revision===this.revision&&c.provider==='volcengine')this.status={verified:true,lastError:'',lastProvider:'volcengine',message:'豆包语音合成成功 · '+c.speaker};
   }catch(error){
    if(signal?.aborted)throw signal.reason;
    const message=redact(error.message,c);if(c.revision===this.revision)this.status={verified:false,lastError:message,lastProvider:'',message};
    if(c.provider!=='volcengine'||strict||!c.fallback||!this.edgeStatus().available)throw new Error(message);
    // 备用音频单独命名且不缓存到云端音色，防止以后误把旧音色当作云端成功。
    const fallbackName='fallback-'+key+'-'+randomUUID().slice(0,8)+'.mp3';
    await this.edgeSpeech({text:item.text,voice:settings.voiceName,rate:settings.speechRate,pitch:settings.voicePitch,output:path.join(this.audioDir,fallbackName),interactive:true},{signal});
    actual='edge';warning=message+'；本句已使用原有音色';if(c.revision===this.revision)this.status={verified:false,lastError:message,lastProvider:'edge',message:warning};
    return settle({url:'/audio/'+fallbackName,provider:actual,fallback:true,warning});
   }
   return settle({url:'/audio/'+filename,provider:actual,fallback:false,warning});
  });
  this.tail=job;this.jobs.set(key,job);job.then(result=>{if(force||result.fallback)this.jobs.delete(key);},()=>this.jobs.delete(key));
  while(this.jobs.size>100)this.jobs.delete(this.jobs.keys().next().value);return job;
 }
}
