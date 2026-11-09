import {post,connect} from './api.js';
const $=id=>document.getElementById(id);
const node=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
let snapshot,loaded=false,scriptSignature='',actSignature='',historySignature='',toastTimer,voiceList=[];
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
async function run(button,job){if(button)button.disabled=true;try{return await job();}catch(error){toast(error.message);}finally{if(button)button.disabled=false;}}
function bind(id,path,input={},message){$(id).addEventListener('click',event=>run(event.currentTarget,async()=>{await post(path,typeof input==='function'?input():input);if(message)toast(message);}));}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(tab=>tab.hidden=tab.id!=='tab-'+button.dataset.tab);
  document.querySelectorAll('[data-tab]').forEach(nav=>nav.classList.toggle('active',nav===button));$('page-label').textContent=button.textContent.trim();
}));
const phases={idle:'准备中',write:'读取库存剧本',match:'正赛进行中',result:'本场已结束',vote:'观众选题中',ready:'下一场准备中'};
function render(data){
  snapshot=data;const {script,cycle,operation,system}=data;
  if(!loaded){
    $('topic').replaceChildren(...data.topics.map(item=>{const option=node('option',item.topic);option.value=item.id;return option;}));
    $('topic').options[0].selected=true;
    fillSettings(data);loaded=true;
  }
  const busy=operation.state==='running';
  $('run-status').textContent=script.active?(script.paused?'已暂停':'正赛进行中'):busy?(phases[cycle.phase]||'准备中'):'等待开场';
  $('operation').textContent=operation.message;$('phase-status').textContent=`第 ${cycle.round||0} 场`;
  $('library-operation').textContent=operation.message;
  for(const id of ['generate','demo','topic','batch-count','repeat-library','play-script','import-script'])$(id).disabled=busy;
  $('stop-production').disabled=!busy;
  $('library-stock').textContent=`${data.library.available} 份可轮播`;
  $('start-cycle').disabled=busy||!data.library.available;$('start-single').disabled=busy||!data.library.available;
  const production=data.production;
  $('production-status').textContent=production.total?`${production.running?'正在准备':'本批结果'}：${production.done}/${production.total} 份 · ${production.succeeded} 份就绪 · ${production.failed} 份失败或未就绪${!production.running&&production.done<production.total?' · 已停止':''}`:'尚未开始批量写稿。';
  $('production-errors').replaceChildren(...production.items.filter(item=>!item.ok).map(item=>node('p',`${item.topic}：${item.error}`)));
  $('pause').disabled=!script.active;$('pause').textContent=script.active&&script.paused?'▶ 继续':'Ⅱ 暂停';$('skip').disabled=!script.active;$('stop').disabled=!busy&&!script.active;
  $('progress-text').textContent=script.active?`${Math.floor(script.elapsedMs/60000)} 分钟 · ${script.paused?'暂停中':'播出中'}`:script.total?'本场已结束':'尚未开播';
  $('line-count').textContent=`${Math.min(script.index+Number(script.active),script.total)} / ${script.total} 句`;
  $('progress-fill').style.width=(script.total?Math.min(100,script.index/script.total*100):0)+'%';
  $('current-line').textContent=script.current?`${script.current.name}：${script.current.text}`:'下一句有分量的话，从这里开始。';
  const actSig=JSON.stringify(script.acts);
  if(actSig!==actSignature){actSignature=actSig;$('acts').replaceChildren(...(script.acts.length?script.acts.map(row=>{
    const li=node('li',undefined,row.state);li.append(node('b',String(row.act).padStart(2,'0')),node('span',row.label));
    return li;
  }):[node('li','开场后显示每一幕的进度。','empty')]));}
  $('stat-reaction').textContent=script.stats.reactions;$('stat-mention').textContent=script.mention?.stats?.replied||0;$('stat-gift').textContent=script.gifts?.stats?.played||0;
  $('audience-status').textContent=script.reaction.pool?`${script.reaction.pool} 条候选弹幕`:'等待弹幕';
  $('receipts').replaceChildren(...(script.receipts.length?script.receipts.slice(-4).reverse().map(row=>node('p',`${row.name} · ${row.kind==='bubble'?'已听见':row.name2+'：'+row.said}`)):[node('p','被听见的声音，会留在这里。','empty')]));
  $('vote-card').hidden=cycle.phase!=='vote';$('lock-vote').disabled=cycle.vote.closed;
  $('vote-status').textContent=`发送 1～${cycle.vote.candidates.length||4} 投下一场；候选均为库存剧本。一人一票，可改票。${cycle.vote.closed?'已锁票，准备下一场。':`剩余约 ${Math.ceil((cycle.vote.remainingMs||0)/60000)} 分钟。`}`;
  $('vote-options').replaceChildren(...(cycle.vote.candidates||[]).map(row=>{const div=node('div',undefined,'vote-option');div.append(node('b',row.index),node('span',row.topic),node('em',row.count+' 票'));return div;}));
  const signature=JSON.stringify(data.scripts);
  if(signature!==scriptSignature){scriptSignature=signature;
    const selected=$('play-script').value;
    const auto=node('option','自动选择 · 优先未播与较久未播');auto.value='';
    $('play-script').replaceChildren(auto,...data.scripts.filter(row=>row.autoReady).map(row=>{const option=node('option',`${row.topic} · ${row.id.slice(-8)} · 已播 ${row.playCount} 次`);option.value=row.id;return option;}));
    if(data.scripts.some(row=>row.id===selected&&row.autoReady))$('play-script').value=selected;
    $('scripts').replaceChildren(...(data.scripts.length?data.scripts.map(row=>{
      const div=node('div',undefined,'script-row'),info=node('div');
      info.append(node('b',row.topic),node('small',`${row.id.slice(-8)} · ${row.turns} 句 · 约 ${row.minutes} 分钟 · ${!row.ready?'未就绪':!row.longForm?'短样稿':!row.enabled?'已移出轮播':'已加入轮播'}`),node('small',`已播 ${row.playCount} 次 · 完整播完 ${row.completedCount} 次${row.lastPlayedAt?' · 最近 '+new Date(row.lastPlayedAt).toLocaleString('zh-CN'):' · 尚未播出'}`));
      if(row.error)info.append(node('small',row.error,'script-error'));
      const actions=node('div',undefined,'script-actions');
      const action=(label,job,available=true)=>{const button=node('button',label);button.dataset.libraryAction=available?'ready':'unavailable';button.onclick=()=>run(button,job);actions.append(button);};
      action('播放',async()=>{await post('/api/script/start',{scriptId:row.id});document.querySelector('[data-tab=live]').click();toast('正在准备播放');},row.ready);
      action('预合成配音',async()=>{await post('/api/scripts/audio',{scriptId:row.id});toast('开始预合成配音，进度见顶部任务状态');},row.ready);
      if(row.ready&&row.longForm)action(row.enabled?'移出轮播':'加入轮播',()=>post('/api/scripts/enabled',{scriptId:row.id,enabled:!row.enabled}));
      const link=node('a','导出 JSON');link.href='/api/scripts/export?id='+encodeURIComponent(row.id);link.download=row.id+'.json';actions.append(link);div.append(info,actions);return div;
    }):[node('p','还没有剧本。先生成，或导入已有 JSON。','empty')]));
  }
  document.querySelectorAll('[data-library-action]').forEach(button=>button.disabled=busy||button.dataset.libraryAction==='unavailable');
  const history=JSON.stringify(data.library.history);
  if(history!==historySignature){historySignature=history;$('broadcast-history').replaceChildren(...(data.library.history.length?data.library.history.slice(0,8).map(row=>node('p',`${row.topic} · ${{playing:'播出中',completed:'已播完',interrupted:'中途结束',error:'播放异常'}[row.status]||row.status} · ${new Date(row.startedAt).toLocaleString('zh-CN')}`)):[node('p','正式开播后显示剧本的播出记录。','empty')]));}
  $('logs').replaceChildren(...data.logs.slice(0,20).map(row=>{const p=node('p');p.append(node('time',new Date(row.at).toLocaleTimeString('zh-CN',{hour12:false})),node('span',row.detail||row.title));return p;}));
  $('llm-status').textContent=system.llm.hasKey?'已保存密钥':'待配置';$('voice-status').textContent=system.voice.available?'可用':'待配置';$('edge-status').textContent=system.edge.message;
  $('platform-state').textContent={connected:'已连接',connecting:'连接中',reconnecting:'重连中',disconnected:'未连接',error:'连接异常'}[system.platform.state]||'未连接';$('platform-message').textContent=system.platform.message;
}
function fillSettings(data){const {config,system}=data;
  $('llm-base').value=system.llm.baseUrl;$('llm-model').value=system.llm.model;
  $('studio-title').value=config.title;$('name-a').value=config.characterName;$('name-b').value=config.opponentName;$('speech-rate').value=config.speechRate;$('voice-pitch').value=config.voicePitch;$('volume').value=config.volume;
  for(const id of ['voice-a','voice-b'])$(id).replaceChildren(...voiceList.map(voice=>{const option=node('option',voice.name+' · '+(voice.label||voice.id));option.value=voice.id;return option;}));
  $('voice-a').value=config.voiceName;$('voice-b').value=config.opponentVoice;
  $('voice-provider').value=system.voice.provider;$('voice-resource').value=system.voice.resourceId;$('cloud-speaker-a').value=system.voice.speaker;$('cloud-speaker-b').value=system.voice.opponentSpeaker||'';cloudFields();
  $('live-provider').value=system.platform.provider||'douyin';fillRoom();
}
function fillRoom(){const platform=snapshot?.system.platform||{},provider=$('live-provider').value;$('live-room').value=platform.rooms?.[provider]||'';$('cookie-label').hidden=provider!=='douyin';$('gift-names').value=provider===platform.provider?(platform.giftMap?.sunglasses||[]).join(','):'';}
function cloudFields(){$('cloud-fields').hidden=$('voice-provider').value!=='volcengine';}
$('voice-provider').onchange=cloudFields;$('live-provider').onchange=fillRoom;
bind('start-cycle','/api/cycle/start',()=>({scriptId:$('play-script').value,repeat:$('repeat-library').checked}),'正在从剧本库准备首场');
bind('start-single','/api/script/start',()=>({scriptId:$('play-script').value}),'正在读取库存剧本');
$('open-library').onclick=()=>document.querySelector('[data-tab=library]').click();
$('batch-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{await post('/api/scripts/generate-batch',{topicIds:[...$('topic').selectedOptions].map(option=>option.value),count:Number($('batch-count').value)});toast('批量写稿已开始，每份完成后自动入库');});};
bind('stop-production','/api/script/stop',{},'任务已停止，已入库剧本保留');
bind('stop','/api/script/stop',{},'已停止全部场次和生成任务');bind('skip','/api/script/skip',{},'已跳到下一幕');bind('lock-vote','/api/vote/lock',{},'已锁票，准备下一场');
$('pause').onclick=event=>run(event.currentTarget,()=>post(snapshot.script.paused?'/api/script/resume':'/api/script/pause'));
$('demo').onclick=event=>run(event.currentTarget,async()=>{const script=await fetch('/demo.json').then(r=>r.json());await post('/api/script/start',{script});toast('简短样稿已启动，请在 OBS 场景开启声音');});
$('import-script').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>1024*1024)throw new Error('剧本不能超过 1 MB');const script=JSON.parse(await file.text());await post('/api/script/import',{script});toast('剧本已导入');}catch(error){toast(error.message);}event.target.value='';};
$('test-event').onsubmit=event=>{event.preventDefault();const text=$('test-comment').value.trim();if(!text)return;run(event.submitter,async()=>{await post('/api/events',{type:'comment',name:'场控观众',userId:'studio-viewer',text,id:crypto.randomUUID()});$('test-comment').value='';toast('测试弹幕已发送');});};
bind('test-gift','/api/events',()=>({type:'gift',gift:'sunglasses',label:'墨镜',name:'场控观众',userId:'studio-viewer',count:1,id:crypto.randomUUID()}),'测试礼物已发送');
$('llm-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{await post('/api/llm/settings',{baseUrl:$('llm-base').value,model:$('llm-model').value,apiKey:$('llm-key').value});$('llm-key').value='';toast('模型设置已保存');});};
bind('test-llm','/api/llm/test',{},'模型接口正常');
$('studio-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{await post('/api/config',{title:$('studio-title').value,characterName:$('name-a').value,opponentName:$('name-b').value,voiceName:$('voice-a').value,opponentVoice:$('voice-b').value,speechRate:Number($('speech-rate').value),voicePitch:Number($('voice-pitch').value),volume:Number($('volume').value)});toast('辩手设置已保存');});};
$('voice-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{const input={provider:$('voice-provider').value};if(input.provider==='volcengine')Object.assign(input,{apiKey:$('voice-key').value,resourceId:$('voice-resource').value,speaker:$('cloud-speaker-a').value,opponentSpeaker:$('cloud-speaker-b').value});await post('/api/voice/settings',input);$('voice-key').value='';toast('语音设置已保存');});};
for(const side of ['a','b'])$('voice-test-'+side).onclick=event=>run(event.currentTarget,async()=>{const audio=await post('/api/voice/test',{side:side.toUpperCase()});$('voice-preview').hidden=false;$('voice-preview').src=audio.url;await $('voice-preview').play().catch(()=>{});});
$('live-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{const input={provider:$('live-provider').value,room:$('live-room').value};if($('live-cookie').value)input.cookie=$('live-cookie').value;await post('/api/live/settings',input);$('live-cookie').value='';toast('直播间已保存');});};
bind('connect-live','/api/live/connect',{},'正在连接直播间');bind('disconnect-live','/api/live/disconnect',{},'已断开直播间');
$('save-gifts').onclick=event=>run(event.currentTarget,async()=>{const map=structuredClone(snapshot.system.platform.giftMap);map.sunglasses=$('gift-names').value.split(/[,，]/u).map(x=>x.trim()).filter(Boolean);await post('/api/live/settings',{giftMap:map});toast('幕间回应礼物已更新');});
$('safety-form').onsubmit=event=>{event.preventDefault();run(event.submitter,async()=>{await post('/api/safety',{blockedTerms:$('blocked-terms').value.split('\n').map(x=>x.trim()).filter(Boolean)});toast('播出屏蔽词已更新');});};
$('obs-url').textContent=location.origin+'/scene.html?audio=1';$('copy-obs').onclick=()=>navigator.clipboard.writeText($('obs-url').textContent).then(()=>toast('OBS 地址已复制')).catch(()=>toast('请手动复制上方地址'));
voiceList=await fetch('/voices.json').then(r=>r.json());
connect(render,connected=>{$('connection-dot').classList.toggle('connected',connected);$('connection-status').textContent=connected?'本机连接正常':'正在重新连接';});
fetch('/api/safety').then(r=>r.json()).then(data=>{if(Array.isArray(data.blockedTerms))$('blocked-terms').value=data.blockedTerms.join('\n');}).catch(()=>{});
