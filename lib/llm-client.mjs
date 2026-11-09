import path from 'node:path';
import {Storage,readSave} from './storage.mjs';
export function baseURL(value) {
  let url;try{url=new URL(value);}catch{throw new Error('API 基础地址无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('请填写不带参数的 API 基础地址');
  return url.href.replace(/\/chat\/completions\/?$/u,'').replace(/\/$/u,'');
}
// One global limiter covers candidate writers, repairs and live interaction.
export class LLMClient {
  constructor({dataDir,fetcher=fetch}={}) {
    this.fetcher=fetcher;this.store=new Storage(path.join(dataDir,'llm-settings.json'));
    this.config={baseUrl:process.env.AI_LLM_BASE_URL||'https://api.openai.com/v1',model:process.env.AI_LLM_MODEL||'',apiKey:process.env.AI_LLM_API_KEY||''};
    this.active=0;this.waiters=[];this.limit=2;
  }
  async init(){const saved=await readSave(this.store.filename);if(saved)this.config={...this.config,...saved};}
  view(){const {apiKey,...rest}=this.config;return {...rest,hasKey:Boolean(apiKey),active:this.active,queued:this.waiters.length};}
  async configure(input) {
    const next={...this.config};
    if(input.baseUrl!==undefined)next.baseUrl=baseURL(input.baseUrl);
    for(const key of ['model','apiKey'])if(input[key]!==undefined){if(typeof input[key]!=='string'||input[key].length>2000||/[\r\n]/u.test(input[key]))throw new Error('模型配置格式无效');if(input[key].trim()||key==='model')next[key]=input[key].trim();}
    if(new URL(next.baseUrl).origin!==new URL(this.config.baseUrl).origin&&!input.apiKey)next.apiKey='';
    if(input.clearKey)next.apiKey='';
    this.config=next;await this.store.save(next);return this.view();
  }
  async acquire(signal) {
    signal?.throwIfAborted();
    if(this.active<this.limit){this.active++;return;}
    await new Promise((resolve,reject)=>{
      const job={resolve:()=>{signal?.removeEventListener('abort',abort);resolve();}};
      const abort=()=>{const index=this.waiters.indexOf(job);if(index>=0)this.waiters.splice(index,1);reject(signal.reason);};
      this.waiters.push(job);signal?.addEventListener('abort',abort,{once:true});
    });
  }
  release(){const next=this.waiters.shift();if(next)next.resolve();else this.active--;}
  async request(endpoint,payload,{signal,timeoutMs=180000}={}) {
    const config={...this.config};if(!config.apiKey)throw new Error('请先保存模型 API Key');
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      const deadline=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,deadline]):deadline;
      const response=await this.fetcher(config.baseUrl+endpoint,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.apiKey},redirect:'error',signal:combined,...(payload?{body:JSON.stringify(payload)}:{})});
      if(!response.ok)throw new Error('模型接口返回 HTTP '+response.status);
      return await response.json();
    }catch(error){if(signal?.aborted)throw new Error('任务已取消');if(error.name==='TimeoutError')throw new Error('模型接口超时');if(error.message?.startsWith('模型接口'))throw error;throw new Error('模型请求失败，请检查地址、模型和网络');}
    finally{this.release();}
  }
  async complete(messages,{maxTokens=2000,signal,timeoutMs=180000}={}) {
    if(!this.config.model)throw new Error('请先填写模型 ID');
    const body=await this.request('/chat/completions',{model:this.config.model,messages,temperature:1,max_tokens:maxTokens,stream:false},{signal,timeoutMs});
    const text=body?.choices?.[0]?.message?.content;
    if(typeof text!=='string'||!text.trim())throw new Error('模型返回空内容');return text.trim();
  }
  async models(){const body=await this.request('/models');return (body.data||[]).map(x=>x.id).filter(x=>typeof x==='string').slice(0,500);}
}
