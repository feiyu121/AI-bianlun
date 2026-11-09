import {Storage,readSave} from './storage.mjs';

// Playback bookkeeping is separate from the scripts: replay never changes dialogue.
export class ScriptLibrary {
  constructor(filename){this.store=new Storage(filename);this.records={};this.history=[];}
  async init(){const saved=await readSave(this.store.filename);this.records=saved?.records||{};this.history=Array.isArray(saved?.history)?saved.history.slice(-200):[];return this;}
  info(id){return {enabled:true,playCount:0,completedCount:0,lastPlayedAt:'',...this.records[id]};}
  save(){return this.store.save({version:1,records:this.records,history:this.history});}
  async setEnabled(id,enabled){if(typeof enabled!=='boolean')throw new Error('轮播状态无效');this.records[id]={...this.info(id),enabled};await this.save();}
  async started(script,at=new Date().toISOString()){
    const info=this.info(script.id);
    this.records[script.id]={...info,playCount:info.playCount+1,lastPlayedAt:at};
    const event={id:script.id,topic:script.topic,startedAt:at,status:'playing'};
    this.history.push(event);this.history=this.history.slice(-200);await this.save();return event;
  }
  async ended(event,status){
    event.status=status;event.endedAt=new Date().toISOString();
    if(status==='completed'){const info=this.info(event.id);this.records[event.id]={...info,completedCount:info.completedCount+1};}
    await this.save();
  }
  async recover(){let changed=false;for(const event of this.history)if(event.status==='playing'){event.status='interrupted';changed=true;}if(changed)await this.save();}
}

// Prefer unseen scripts and older broadcasts. A ballot contains at most one
// version of a topic; other versions remain available for later rounds.
export function pickLibraryScripts(rows,{avoid=[],used=[],repeat=false,n=4,currentId=''}={}){
  const excluded=new Set(used),recent=new Set(avoid);
  let pool=rows.filter(row=>row.autoReady&&(repeat||!excluded.has(row.id)));
  if(pool.some(row=>row.id!==currentId))pool=pool.filter(row=>row.id!==currentId);
  const topics=new Set(),picked=[];
  pool.sort((a,b)=>Number(recent.has(a.id))-Number(recent.has(b.id))||a.playCount-b.playCount||a.lastPlayedAt.localeCompare(b.lastPlayedAt)||a.id.localeCompare(b.id));
  for(const row of pool){const key=row.topic.trim();if(topics.has(key))continue;topics.add(key);picked.push({id:row.id,topic:row.topic,topicId:row.topicId});if(picked.length>=n)break;}
  return picked;
}
