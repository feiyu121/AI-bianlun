import {connect} from './api.js';
import {Speaker} from './speaker.js';
import {captionAt} from './captions.js';
import {fitCaptionPages} from './caption-layout.js';
import {renderCamps} from './camps.js';
import {currentPerformance,avatarPerformance} from './stage-performance.js';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),preview=params.has('preview');
let data,avatars=[],captionCache;
function fit(){captionCache=null;const scale=Math.min(innerWidth/540,innerHeight/960);$('stage').style.transform=`translate(${(innerWidth-540*scale)/2}px,${(innerHeight-960*scale)/2}px) scale(${scale})`;}
addEventListener('resize',fit);fit();
document.fonts.ready.then(()=>{captionCache=null;});
const speaker=new Speaker((enabled,message)=>{$('sound-toggle').textContent=enabled?'关闭声音':'开启声音';$('sound-status').textContent=message;});
$('sound-toggle').onclick=()=>speaker.enabled?speaker.disable():speaker.enable().catch(error=>$('sound-status').textContent=error.message);
if(preview)$('scene-controls').hidden=true;
function element(tag,text){const el=document.createElement(tag);el.textContent=text;return el;}
function paintCaption(){
  const line=data?.state.scriptLine;
  if(line&&captionCache?.text!==line.text)captionCache={text:line.text,pages:fitCaptionPages(line.text,$('scene-line'))};
  const text=line?captionAt(line.text,Date.now()-line.at,line.durationMs,captionCache.pages):'观点可以不同，道理值得讲清楚。';
  if($('scene-line').textContent!==text)$('scene-line').textContent=text;
}
function render(next){
  data=next;if(!preview)speaker.update(next);
  renderCamps(next,'scene-',{compact:true});
  const {script,cycle,config,playback}=next;
  const nameA=script.sides?.find(side=>side.id==='A')?.name||config.characterName,nameB=script.sides?.find(side=>side.id==='B')?.name||config.opponentName;
  $('scene-brand').textContent=config.title;$('scene-name-a').textContent=nameA;$('scene-name-b').textContent=nameB;
  $('scene-meta').textContent=`${nameA} × ${nameB} · 一题聊一会儿`;
  $('scene-topic').textContent=script.topic||'两个声音，一个值得争论的问题。';
  const act=script.acts.find(x=>x.state==='now');
  $('scene-status').textContent=script.active?(script.paused?'已暂停':'正赛进行中'):({write:'准备剧本',vote:'下一场选题',ready:'准备开场',result:'本场结束'}[cycle.phase]||'等待开场');
  $('scene-act').textContent=act?.label||(script.total?'本场已结束':'双方准备中');
  $('scene-progress').textContent=script.total?`${Math.min(script.index+Number(script.active),script.total)} / ${script.total} 句`:'每题约 6～8 分钟';
  $('scene-track').style.width=(script.total?script.index/script.total*100:0)+'%';
  const line=next.state.scriptLine;
  $('scene-speaker').textContent=line?.side==='B'?nameB:line?nameA:'辩';
  const kind=line?.kind||'script',context={reaction:'接观众弹幕',mention:'点名回应',gift:'礼物回嘴'}[kind]||'';
  $('scene-context').hidden=!context;
  $('scene-context').textContent=context+(line?.audienceName?` · ${line.audienceName}`:'');
  $('scene-context').title=$('scene-context').textContent;
  $('scene-context').dataset.kind=kind;
  $('scene-speaker').dataset.side=line?.side||'';
  paintCaption();
  const liveCue=currentPerformance(next),talking=liveCue?.phase==='speaking'?liveCue.side:'';
  for(const side of ['A','B'])$('side-'+side.toLowerCase()).dataset.speaking=String(talking===side);
  for(const [side,key]of [['A','a'],['B','b']]){
    const stance=script.sides?.find(x=>x.id===side)?.stance||'';$('stance-'+key).textContent=stance||(side==='A'?'嘴上不饶人，也会心软和改口。':'慢悠悠补刀，也会被逗笑。');
  }
  const intermission=!script.active&&['result','vote','ready','write'].includes(cycle.phase);$('intermission').hidden=!intermission;
  if(intermission){
    const voting=cycle.phase==='vote';$('intermission-label').textContent=voting?'YOUR NEXT QUESTION':'BETWEEN THE ROUNDS';
    $('intermission-title').textContent=voting?'下一场，观众说了算。':cycle.phase==='write'?'下一场的观点，正在准备。':cycle.phase==='ready'?'观点就位，准备开场。':'本场辩论，暂告一段落。';
    $('intermission-note').textContent=voting?`发 1～${cycle.vote.candidates?.length||4} 选下一题，也可以接着聊天。`:cycle.topic?.topic||'马上接着聊。';
    $('scene-vote').replaceChildren(...(voting?(cycle.vote.candidates||[]).map(row=>{
      const card=element('div','');card.className='vote-card';const bar=element('i','');bar.className='vote-bar';bar.style.width=Math.round(row.share*100)+'%';const content=element('div','');content.append(element('span',row.topic),element('small',row.count+' 票'));card.append(bar,element('b',row.index),content);return card;
    }):[Object.assign(element('p',cycle.phase==='result'?`双方完成 ${script.stats.turns} 句交锋。观众的下一道问题，会让这场讨论继续。`:'剧本分幕生成，声音逐句预热。准备完成后自动开场。'),{className:'summary-row'})]));
    const camps=next.camps;
    $('scene-vote-footer').textContent=(voting?(cycle.vote.closed?'已锁票，下一场马上开始':`选题剩余 ${Math.ceil((cycle.vote.remainingMs||0)/1000)} 秒`):'')+(camps?.state==='closed'?`${voting?' · ':''}本题支持：${camps.sides.map(side=>`${side.name} ${side.votes} 票`).join(' / ')}`:'');
    const chatting=next.utterances.find(item=>item.id===playback.id&&item.kind==='chat');
    $('intermission-chat').hidden=!chatting||!playback.text;
    $('intermission-chat-name').textContent=chatting?.name||'';
    $('intermission-chat-line').textContent=chatting?playback.text:'';
  }
}
connect(render,ok=>{if(!ok)$('scene-status').textContent='连接恢复中';});
async function loadAvatars(){
  const specs=[{side:'A',profile:'roubao',host:'avatar-a',pack:'/avatar/live2d/doubao/2.0.model3.json'},{side:'B',profile:'whale',host:'avatar-b',pack:'/avatar/live2d/ds-whale-girl/c_0120.model3.json'}];
  await Promise.all(specs.map(async spec=>{
    try{
      const host=$(spec.host),renderer=await window.AvatarRenderers.live2d(host,{pack:spec.pack,performanceProfile:spec.profile,display:{charHeight:275,anchorX:145,anchorY:290},mouthGain:1.1});
      host.dataset.ready='true';avatars.push({...spec,renderer});
    }catch(error){$('model-status').textContent='形象加载失败：'+error.message;$(spec.host).dataset.error=error.message;}
  }));
}
loadAvatars();
let time=0,last=performance.now();
function frame(now){
  const dt=Math.min(.1,(now-last)/1000);last=now;time+=dt;
  paintCaption();
  if(data){
    const cue=currentPerformance(data),blend=1-Math.exp(-dt*7);
    for(const avatar of avatars){try{
      const performance=avatarPerformance(cue,avatar.side);
      avatar.pose ||= {yaw:0,pitch:0,roll:0,gazeX:0,gazeY:0};
      for(const [key,target]of Object.entries(performance.pose))avatar.pose[key]+=(target-avatar.pose[key])*blend;
      avatar.renderer.playEmotion(performance.expression);avatar.renderer.setPose(avatar.pose);
      $('side-'+avatar.side.toLowerCase()).dataset.speaking=String(performance.speaking);
      $(avatar.host).dataset.expression=performance.expression;
      $(avatar.host).dataset.expressionAsset=avatar.renderer.getPerformance().asset||'';
      const measured=data.playback.text?(speaker.enabled?speaker.level||0:data.playback.level||0):.12;
      avatar.renderer.frame(time,performance.speaking?measured:0);
    }catch{}}
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if(!preview&&params.get('audio')==='1')speaker.enable().catch(error=>$('sound-status').textContent='点击开启声音 · '+error.message);
