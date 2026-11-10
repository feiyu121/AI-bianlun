export function renderCamps(data,prefix='',{compact=false}={}){
  const $=id=>document.getElementById(prefix+id),camps=data.camps||{},voting=data.cycle.phase==='vote';
  const active=camps.state==='open'&&data.script.active;
  for(const [id,key,fallback] of [['A','a',data.config.characterName],['B','b',data.config.opponentName]]){
    const side=camps.sides?.find(row=>row.id===id);
    $('camp-name-'+key).textContent=side?.name||fallback;
    $('camp-count-'+key).textContent=`${side?.votes??side?.count??0} 票`;
    const total=camps.session?.sides?.find(row=>row.id===id);
    let sessionLabel=$('camp-count-'+key).parentElement.querySelector('.camp-session');
    if(!sessionLabel){sessionLabel=document.createElement('small');sessionLabel.className='camp-session';$('camp-count-'+key).parentElement.append(sessionLabel);}
    sessionLabel.textContent=`本次直播 ${total?.votes??side?.votes??0} 票`;
  }
  const a=camps.sides?.find(row=>row.id==='A'),totalVotes=camps.totalVotes??camps.total??0,share=totalVotes?(a?.votes??a?.count??0)/totalVotes:0.5;
  $('camp-bar-a').style.width=(share*100)+'%';
  $('camp-bar').setAttribute('aria-label',`支持票：${$('camp-name-a').textContent} ${$('camp-count-a').textContent}，${$('camp-name-b').textContent} ${$('camp-count-b').textContent}`);
  const nameA=$('camp-name-a').textContent,nameB=$('camp-name-b').textContent;
  $('camp-rule').textContent=voting?`场间发数字选下一题；本题 ${totalVotes} 票已封存。`:active?`发 1 / 支持${nameA}，发 2 / 支持${nameB} · 一人一票，可换阵营`:
    camps.state==='closed'?`本题 ${totalVotes} 票已封存 · 本次直播累计保留`:`开场后发 1 支持${nameA}，发 2 支持${nameB}`;
  if(compact&&active)$('camp-rule').textContent=`发 1 支持${nameA} · 发 2 支持${nameB} · 一人一票`;
  const platform=data.system.platform,groups=['A','B'].map((id,index)=>{
    const gifts=(camps.giftRules||[]).filter(rule=>rule.side===id&&platform.giftMap?.[rule.gift]?.length!==0).map(rule=>`${platform.giftMenu?.[rule.gift]?.[0]||platform.giftMap?.[rule.gift]?.[0]||rule.label}+${rule.weight}`);
    return gifts.length?`${gifts.join(' / ')} → ${index?nameB:nameA}`:'';
  }).filter(Boolean);
  const hints=[...groups,...(platform.giftMap?.sunglasses?.length!==0?[`${platform.giftMenu?.sunglasses?.[0]||platform.giftMap?.sunglasses?.[0]||'墨镜'}礼物 · 换一句幕间回嘴`]:[])];
  if(!hints.length)hints.push('发送 1 或 2，支持你喜欢的角色');
  $('camp-gift-rule').textContent=compact?hints[Math.floor(Date.now()/6000)%hints.length]:groups.length?groups.join(' · '):'弹幕加入 1 票，指定礼物追加支持票';
  $('camp-gift-rule').title=groups.join(' · ');
}
