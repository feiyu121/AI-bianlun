import {connect} from './api.js';
import {Speaker} from './speaker.js';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),preview=params.has('preview');
let data,avatars=[];
function fit(){const scale=Math.min(innerWidth/540,innerHeight/960);$('stage').style.transform=`translate(${(innerWidth-540*scale)/2}px,${(innerHeight-960*scale)/2}px) scale(${scale})`;}
addEventListener('resize',fit);fit();
const speaker=new Speaker((enabled,message)=>{$('sound-toggle').textContent=enabled?'关闭声音':'开启声音';$('sound-status').textContent=message;});
$('sound-toggle').onclick=()=>speaker.enabled?speaker.disable():speaker.enable().catch(error=>$('sound-status').textContent=error.message);
if(preview)$('scene-controls').hidden=true;
function element(tag,text){const el=document.createElement(tag);el.textContent=text;return el;}
function render(next){
  data=next;if(!preview)speaker.update(next);
  const {script,cycle,config,playback}=next;
  const nameA=script.sides?.find(side=>side.id==='A')?.name||config.characterName,nameB=script.sides?.find(side=>side.id==='B')?.name||config.opponentName;
  $('scene-brand').textContent=config.title;$('scene-name-a').textContent=nameA;$('scene-name-b').textContent=nameB;
  $('scene-meta').textContent=`${nameA} × ${nameB} · 长场辩论`;
  $('scene-topic').textContent=script.topic||'两个声音，一个值得争论的问题。';
  const act=script.acts.find(x=>x.state==='now');
  $('scene-status').textContent=script.active?(script.paused?'已暂停':'正赛进行中'):({write:'准备剧本',vote:'下一场选题',ready:'准备开场',result:'本场结束'}[cycle.phase]||'等待开场');
  $('scene-act').textContent=act?.label||(script.total?'本场已结束':'双方准备中');
  $('scene-progress').textContent=script.total?`${Math.min(script.index+Number(script.active),script.total)} / ${script.total} 句`:'长场剧本 · 约 30 分钟';
  $('scene-track').style.width=(script.total?script.index/script.total*100:0)+'%';
  const line=next.state.scriptLine;
  $('scene-speaker').textContent=line?.side==='B'?nameB:line?nameA:'辩';
  $('scene-line').textContent=line?.text||'观点可以不同，道理值得讲清楚。';$('scene-line').classList.toggle('long',(line?.text.length||0)>120);
  const talking=playback.text?playback.speaker:script.active&&!script.paused?next.state.speakingSide:'';
  for(const side of ['A','B'])$('side-'+side.toLowerCase()).dataset.speaking=String(talking===side);
  for(const [side,key]of [['A','a'],['B','b']]){
    const stance=script.sides?.find(x=>x.id===side)?.stance||'';$('stance-'+key).textContent=stance||(side==='A'?'用证据与推理，把问题拆开。':'从具体的人，找到另一种答案。');
  }
  const wall=script.wall.slice(-3);$('scene-wall').replaceChildren(...(wall.length?wall.map(row=>{const div=element('div','');div.className='wall-row';div.dataset.state=row.state;div.append(element('b',row.name),element('span',row.text),element('small',row.state==='replied'?'已回应':row.state==='heard'?'已听见':''));return div;}):[Object.assign(element('p','发出你的观点，让现场听见。'),{className:'wall-empty'})]));
  const receipt=[...script.receipts].reverse().find(row=>row.kind!=='bubble'&&Date.now()-row.at<6500);
  $('scene-receipt').hidden=!receipt;if(receipt){$('receipt-name').textContent=`${receipt.name} · ${receipt.name2} 接话`;$('receipt-text').textContent=receipt.said;}
  const intermission=!script.active&&['result','vote','ready','write'].includes(cycle.phase);$('intermission').hidden=!intermission;
  if(intermission){
    const voting=cycle.phase==='vote';$('intermission-label').textContent=voting?'YOUR NEXT QUESTION':'BETWEEN THE ROUNDS';
    $('intermission-title').textContent=voting?'下一场，观众说了算。':cycle.phase==='write'?'下一场的观点，正在准备。':cycle.phase==='ready'?'观点就位，准备开场。':'本场辩论，暂告一段落。';
    $('intermission-note').textContent=voting?'发送 1～4 选择下一场。一人一票，可以改票。':cycle.topic?.topic||'精彩的交锋，需要一点准备时间。';
    $('scene-vote').replaceChildren(...(voting?(cycle.vote.candidates||[]).map(row=>{
      const card=element('div','');card.className='vote-card';const bar=element('i','');bar.className='vote-bar';bar.style.width=Math.round(row.share*100)+'%';const content=element('div','');content.append(element('span',row.topic),element('small',row.count+' 票'));card.append(bar,element('b',row.index),content);return card;
    }):[Object.assign(element('p',cycle.phase==='result'?`双方完成 ${script.stats.turns} 句交锋。观众的下一道问题，会让这场讨论继续。`:'剧本分幕生成，声音逐句预热。准备完成后自动开场。'),{className:'summary-row'})]));
    $('scene-vote-footer').textContent=voting?(cycle.vote.closed?'已锁票，下一场马上开始':`投票窗口剩余约 ${Math.ceil((cycle.vote.remainingMs||0)/60000)} 分钟`):'';
  }
}
connect(render,ok=>{if(!ok)$('scene-status').textContent='连接恢复中';});
async function loadAvatars(){
  const specs=[{side:'A',host:'avatar-a',pack:'/avatar/live2d/doubao/2.0.model3.json'},{side:'B',host:'avatar-b',pack:'/avatar/live2d/ds-whale-girl/c_0120.model3.json'}];
  await Promise.all(specs.map(async spec=>{
    try{
      const host=$(spec.host),renderer=await window.AvatarRenderers.live2d(host,{pack:spec.pack,display:{charHeight:275,anchorX:145,anchorY:290},mouthGain:1.1});
      host.dataset.ready='true';avatars.push({...spec,renderer});
    }catch(error){$('model-status').textContent='形象加载失败：'+error.message;$(spec.host).dataset.error=error.message;}
  }));
}
loadAvatars();
let time=0,last=performance.now();
function frame(now){
  const dt=Math.min(.1,(now-last)/1000);last=now;time+=dt;
  if(data){const playback=data.playback,side=playback.text?playback.speaker:data.script.active&&!data.script.paused?data.state.speakingSide:'';for(const avatar of avatars){try{const active=side===avatar.side;avatar.renderer.playEmotion(active?({focus:'neutral',question:'surprised',smug:'happy'}[playback.emotion]||playback.emotion||'neutral'):'neutral');avatar.renderer.frame(time,active?(speaker.level||playback.level||.12):0);}catch{}}}
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
if(!preview&&params.get('audio')==='1')speaker.enable().catch(error=>$('sound-status').textContent='点击开启声音 · '+error.message);
