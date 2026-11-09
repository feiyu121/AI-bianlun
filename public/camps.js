export function renderCamps(data,prefix=''){
  const $=id=>document.getElementById(prefix+id),camps=data.camps||{},voting=data.cycle.phase==='vote';
  const active=camps.state==='open'&&data.script.active;
  for(const [id,key,fallback] of [['A','a',data.config.characterName],['B','b',data.config.opponentName]]){
    const side=camps.sides?.find(row=>row.id===id);
    $('camp-name-'+key).textContent=side?.name||fallback;
    $('camp-count-'+key).textContent=`${side?.votes??side?.count??0} 票`;
  }
  const a=camps.sides?.find(row=>row.id==='A'),totalVotes=camps.totalVotes??camps.total??0,share=totalVotes?(a?.votes??a?.count??0)/totalVotes:0.5;
  $('camp-bar-a').style.width=(share*100)+'%';
  $('camp-bar').setAttribute('aria-label',`支持票：${$('camp-name-a').textContent} ${$('camp-count-a').textContent}，${$('camp-name-b').textContent} ${$('camp-count-b').textContent}`);
  const nameA=$('camp-name-a').textContent,nameB=$('camp-name-b').textContent;
  $('camp-rule').textContent=voting?`场间发数字选下一题；本场 ${totalVotes} 票已封存。`:active?`发 1 / 支持${nameA}，发 2 / 支持${nameB} · 一人一票，可换阵营`:
    camps.state==='closed'?`本场 ${totalVotes} 票 · 已结束，下场重新计票`:`开场后发 1 支持${nameA}，发 2 支持${nameB}`;
  const platform=data.system.platform,groups=['A','B'].map((id,index)=>{
    const gifts=(camps.giftRules||[]).filter(rule=>rule.side===id&&platform.giftMap?.[rule.gift]?.length!==0).map(rule=>`${platform.giftMenu?.[rule.gift]?.[0]||platform.giftMap?.[rule.gift]?.[0]||rule.label}+${rule.weight}`);
    return gifts.length?`${gifts.join(' / ')} → ${index?nameB:nameA}`:'';
  }).filter(Boolean);
  $('camp-gift-rule').textContent=groups.length?groups.join(' · '):'弹幕加入 1 票，指定礼物追加支持票';
  $('camp-gift-rule').title=$('camp-gift-rule').textContent;
}
