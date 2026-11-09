// Isolated development smoke test; never attaches to the user's browser/profile.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {chromium} from '../integrations/multilive/playwright-core/index.mjs';
import {createApplication} from '../lib/http-app.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=await mkdtemp(path.join(os.tmpdir(),'ai-bianlun-scene-'));
const output=path.join(root,'.qa');await mkdir(output,{recursive:true});
let app,browser;
try{
  app=await createApplication({root,dataDir,platformEnabled:false,edgeSpeech:async()=>({ok:true}),renderVoice:async()=>({url:'/audio/qa.mp3',durationMs:30000})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  const executablePath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if(!executablePath)throw new Error('开发场景验收需要本机 Chrome 或 Edge');
  browser=await chromium.launch({executablePath,headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1600,height:1100}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{if(response.status()>=400&&!response.url().endsWith('/favicon.ico'))errors.push(response.status()+' '+response.url());});
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const preview=page.frameLocator('iframe');
  await preview.locator('#avatar-a[data-ready=true]').waitFor({timeout:60000});
  await preview.locator('#avatar-b[data-ready=true]').waitFor({timeout:60000});
  const result=[];
  for(const id of ['avatar-a','avatar-b']){
    const canvas=preview.locator('#'+id+' canvas');
    await canvas.evaluate(element=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const measure=await canvas.evaluate(element=>{
      const canvasBox=element.getBoundingClientRect(),wrapBox=element.parentElement.getBoundingClientRect();
      const gl=element.getContext('webgl2')||element.getContext('webgl');
      const pixels=new Uint8Array(element.width*element.height*4);gl.readPixels(0,0,element.width,element.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      let opaque=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)opaque++;
      return {width:canvasBox.width,height:canvasBox.height,wrapWidth:wrapBox.width,wrapHeight:wrapBox.height,opaque,backingWidth:element.width};
    });
    assert.ok(Math.abs(measure.width-measure.wrapWidth)<1,'画布 CSS 宽度与逻辑宽度一致');
    assert.ok(Math.abs(measure.height-measure.wrapHeight)<1,'画布 CSS 高度与逻辑高度一致');
    assert.ok(measure.opaque>1000,id+' 必须绘制可见模型像素');result.push({id,...measure});
  }
  await page.screenshot({path:path.join(output,'workbench.png'),fullPage:true});
  assert.equal(await page.locator('#start-cycle').isDisabled(),true);
  assert.equal(await page.locator('#repeat-library').isChecked(),false);
  await page.locator('#open-library').click();
  assert.equal(await page.locator('#tab-library').isVisible(),true);
  assert.equal(await page.locator('#generate').isDisabled(),true);
  assert.equal(await page.locator('#topic').evaluate(el=>el.selectedOptions.length),0);
  await page.locator('#custom-topics').fill('情侣之间该不该查看手机\n游戏输了到底该怪谁');await page.locator('#batch-count').fill('2');
  assert.match(await page.locator('#batch-summary').innerText(),/共 2 道辩题.*4 份/);
  await page.locator('#preset-topics summary').click();await page.locator('#topic').selectOption(['meeting']);
  assert.match(await page.locator('#batch-summary').innerText(),/共 3 道辩题.*6 份/);
  await page.locator('#topic').selectOption([]);await page.locator('#preset-topics summary').click();await page.locator('#batch-count').fill('1');
  // Exercise the waiting view with a snapshot fixture; no real model request.
  const previousGeneration=app.runtime.generation;
  app.runtime.generation={state:'running',phase:'act',topic:'情侣之间该不该查看手机',message:'正在写第 3/11 幕「接着聊 · 2」',startedAt:Date.now()-90000,requestAt:Date.now()-25000,requestPending:true,completedActs:2,totalActs:11,turns:8,chars:1360,estTotalSec:270};
  app.runtime.log('正在写第 3/11 幕「接着聊 · 2」','generation');
  await page.waitForFunction(()=>document.getElementById('generation-progress').value===2);
  assert.match(await page.locator('#generation-counts').innerText(),/已处理 2 \/ 11 幕.*8 句.*1360 字/);
  assert.match(await page.locator('#generation-time').innerText(),/正在等待模型返回/);
  assert.match(await page.locator('#generation-logs').innerText(),/第 3\/11 幕/);
  await page.screenshot({path:path.join(output,'generation-progress.png'),fullPage:true});
  app.runtime.generation=previousGeneration;app.runtime.emit();
  const dialogue='我们先把这件事实际发生时的条件讲清楚，再看对方提出的办法是否真的有用。'.repeat(6);
  const prepare=app.runtime.prepare;
  app.runtime.prepare=async topic=>{const script={id:'qa-'+topic.id,topic:topic.topic,topicId:topic.id,sides:app.runtime.sides(topic),meta:{ready:true},turns:Array.from({length:44},(_,i)=>({act:Math.floor(i/4)+1,side:i%2?'B':'A',text:dialogue}))};await app.runtime.saveScript(script);return {script,ready:true};};
  try{
    await page.locator('#generate').click();
    await page.waitForFunction(()=>document.getElementById('production-status').textContent.includes('2 份就绪'));
    assert.equal(app.runtime.production.succeeded,2);assert.ok(app.runtime.scripts.every(row=>row.topicId.startsWith('custom-')));
  }finally{app.runtime.prepare=prepare;}
  await app.runtime.saveScript({id:'qa-library',topic:'会议应该怎样安排',topicId:'meeting',meta:{ready:true},turns:Array.from({length:44},(_,i)=>({act:Math.floor(i/4)+1,side:i%2?'B':'A',text:dialogue}))});
  const prepared=page.locator('.script-row').filter({hasText:'会议应该怎样安排'});
  await prepared.getByRole('button',{name:'移出轮播',exact:true}).click();
  await prepared.getByRole('button',{name:'加入轮播',exact:true}).waitFor();assert.equal(app.runtime.snapshot().library.available,2);
  await prepared.getByRole('button',{name:'加入轮播',exact:true}).click();
  await prepared.getByRole('button',{name:'移出轮播',exact:true}).waitFor();assert.equal(app.runtime.snapshot().library.available,3);
  await prepared.getByRole('button',{name:'预合成配音',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('library-operation').textContent.includes('整场配音已缓存'));
  const sample={topic:'接住现场的一句话',turns:[{act:1,side:'A',text:'那我们先把条件讲清楚。'},{act:2,side:'B',text:'行，你先说说看。'}]};
  await page.locator('#import-script').setInputFiles({name:'qa-short.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(sample))});
  const imported=page.locator('.script-row').filter({hasText:'接住现场的一句话'});await imported.waitFor();
  assert.match(await imported.innerText(),/短样稿/);
  await page.screenshot({path:path.join(output,'library.png'),fullPage:true});
  await imported.getByRole('button',{name:'播放',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('camp-rule').textContent.includes('一人一票'));
  await page.locator('#pause').click();
  for(const [text,a,b] of [['1','1 票','0 票'],['支持肉包','1 票','0 票'],['2','0 票','1 票']]){
    await page.locator('#test-comment').fill(text);await page.locator('#test-event button').click();
    await page.waitForFunction(([a,b])=>document.getElementById('camp-count-a').textContent===a&&document.getElementById('camp-count-b').textContent===b,[a,b]);
  }
  assert.equal(app.runtime.snapshot().camps.total,1);
  await app.runtime.receive({type:'comment',source:'douyin',userId:'qa-camp-2',name:'另一位观众',text:'支持肉包'});
  await page.waitForFunction(()=>document.getElementById('camp-count-a').textContent==='1 票');
  await page.locator('#test-gift-a').click();
  await page.waitForFunction(()=>document.getElementById('camp-count-a').textContent==='4 票');
  assert.equal(app.runtime.camps.view().sides[0].share,0.8);
  await page.locator('#test-gift-b').click();
  await page.waitForFunction(()=>document.getElementById('camp-count-b').textContent==='4 票');
  assert.equal(app.runtime.camps.view().totalVotes,8);assert.equal(app.runtime.camps.view().total,2);
  await app.runtime.receive({type:'comment',userId:'wall1',name:'观众一',text:'哈哈哈哈'});await app.runtime.receive({type:'comment',userId:'wall2',name:'观众二',text:'这个说法有意思'});
  await page.screenshot({path:path.join(output,'workbench-camps.png'),fullPage:true});
  const campScene=await context.newPage();campScene.on('pageerror',error=>errors.push(error.message));
  await campScene.setViewportSize({width:540,height:960});await campScene.goto(base+'/scene.html?preview=1');
  await campScene.locator('#avatar-a[data-ready=true]').waitFor({timeout:60000});await campScene.locator('#avatar-b[data-ready=true]').waitFor({timeout:60000});
  assert.equal(await campScene.locator('#scene-camp-count-a').innerText(),'4 票');assert.equal(await campScene.locator('#scene-camp-count-b').innerText(),'4 票');
  assert.match(await campScene.locator('#scene-camp-rule').innerText(),/一人一票/);
  assert.match(await campScene.locator('#scene-camp-gift-rule').getAttribute('title'),/棒棒糖\+3/);
  assert.equal(await campScene.locator('#scene-wall,.audience,.wall-row').count(),0,'直播画面不重复显示平台弹幕');
  assert.equal(app.runtime.runner.view().wall.length,2,'移除显示后仍接收并记录弹幕');
  const safeArea=await campScene.locator('.camp-gift-hint').evaluate(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,panelTop:el.closest('.camp-panel').getBoundingClientRect().top,panelBottom:el.closest('.camp-panel').getBoundingClientRect().bottom,ruleBottom:document.getElementById('scene-camp-rule').getBoundingClientRect().bottom,dialogueTop:document.querySelector('.dialogue').getBoundingClientRect().top,dialogueBottom:document.querySelector('.dialogue').getBoundingClientRect().bottom,stageBottom:document.getElementById('stage').getBoundingClientRect().bottom}));
  assert.ok(safeArea.top>=safeArea.ruleBottom&&safeArea.bottom<=safeArea.panelBottom,'礼物说明在支持票卡片内，位于站队提示下面');assert.ok(safeArea.panelBottom<=safeArea.dialogueTop,'礼物提示不能覆盖字幕');assert.ok(safeArea.stageBottom-safeArea.dialogueBottom>=120,'底部预留平台界面空间');
  const scorePosition=await campScene.locator('.camp-panel').evaluate(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,characters:document.querySelector('.debaters').getBoundingClientRect().bottom,captions:document.querySelector('.dialogue').getBoundingClientRect().top}));
  assert.ok(scorePosition.top>=scorePosition.characters&&scorePosition.bottom<=scorePosition.captions,'支持票在人物与字幕之间');
  await campScene.screenshot({path:path.join(output,'scene-camps.png')});
  await page.locator('#stop').click();
  await page.waitForFunction(()=>document.getElementById('operation').textContent.includes('已停止'));
  assert.equal(app.runtime.runner.active,false);
  await page.waitForFunction(()=>document.getElementById('camp-rule').textContent.includes('本场 8 票'));
  app.runtime.cycle.phase='vote';app.runtime.cycle.vote.open({candidates:app.runtime.snapshot().topics.slice(0,4)});app.runtime.emit();
  await page.waitForFunction(()=>document.getElementById('camp-rule').textContent.includes('场间发数字选下一题'));
  await page.locator('#test-comment').fill('1');await page.locator('#test-event button').click();
  assert.equal(app.runtime.cycle.vote.total(),1);assert.equal(app.runtime.camps.view().total,2);
  await campScene.waitForFunction(()=>document.getElementById('scene-vote-footer').textContent.includes('肉包 4 票 / 鲸鱼娘 4 票'));
  const voteSpace=await campScene.locator('.intermission').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,stageBottom:document.getElementById('stage').getBoundingClientRect().bottom,contentBottom:document.getElementById('scene-vote-footer').getBoundingClientRect().bottom}));
  assert.ok(voteSpace.bottom<=voteSpace.stageBottom-120&&voteSpace.contentBottom<=voteSpace.bottom,'场间投票也应保留底部空间且完整显示');
  await campScene.screenshot({path:path.join(output,'scene-camps-intermission.png')});await campScene.close();
  app.runtime.cycle.phase='idle';app.runtime.emit();
  await page.getByRole('button',{name:'模型与语音'}).click();
  assert.equal(await page.locator('#tab-settings').isVisible(),true);
  await page.getByRole('button',{name:'直播间与防护'}).click();
  assert.equal(await page.locator('#tab-connection').isVisible(),true);
  assert.equal(await page.locator('#safety-enabled').isChecked(),true);
  await page.locator('#safety-enabled').uncheck();
  await page.waitForFunction(()=>document.getElementById('safety-status').textContent==='已关闭');
  assert.equal(app.runtime.safety.view().enabled,false);
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'直播间与防护'}).click();
  await page.waitForFunction(()=>document.getElementById('safety-status').textContent==='已关闭');
  assert.equal(await page.locator('#safety-enabled').isChecked(),false);
  await page.screenshot({path:path.join(output,'safety-switch.png'),fullPage:true});
  await page.locator('#safety-enabled').check();
  await page.waitForFunction(()=>document.getElementById('safety-status').textContent==='已开启');
  assert.equal(app.runtime.safety.view().enabled,true);
  await page.goto(base+'/scene.html?preview=1');
  await page.locator('#avatar-a[data-ready=true]').waitFor({timeout:60000});await page.locator('#avatar-b[data-ready=true]').waitFor({timeout:60000});
  await page.setViewportSize({width:540,height:960});
  assert.match(await page.locator('.side-a .debater-label span').innerText(),/嘴硬心软/);
  assert.match(await page.locator('.side-b .debater-label span').innerText(),/温柔补刀/);
  assert.equal(await page.locator('#scene-name-a').innerText(),'肉包');
  await page.screenshot({path:path.join(output,'scene.png')});
  const longText='这是用来检查长句字幕是否完整显示的内容，我们可以慢慢把一个条件说清楚。'.repeat(8).slice(0,260);
  const pages=await page.evaluate(async text=>{const {fitCaptionPages}=await import('/caption-layout.js');return fitCaptionPages(text,document.getElementById('scene-line'));},longText);
  let consumed=0;
  for(const text of pages){
    app.runtime.engine.state.scriptLine={side:'A',text:longText,at:Date.now()-(consumed+1)*1000,durationMs:longText.length*1000};app.runtime.emit();
    await page.waitForFunction(text=>document.getElementById('scene-line').textContent===text,text);
    const box=await page.locator('#scene-line').evaluate(el=>({visible:el.clientHeight,full:el.scrollHeight,bottom:el.getBoundingClientRect().bottom,container:el.closest('.dialogue-body').getBoundingClientRect().bottom}));
    assert.ok(box.full<=box.visible+1,'每页字幕应完整显示');assert.ok(box.bottom<=box.container,'字幕不能溢出对话框');
    consumed+=text.length;
  }
  await page.screenshot({path:path.join(output,'scene-long-caption.png')});
  // Readable on a phone; each response owns the same fixed subtitle area.
  await page.setViewportSize({width:390,height:844});
  const previousLine=app.runtime.engine.state.scriptLine;
  for(const kind of ['mention','gift','reaction','script']){
    app.runtime.runner.reveal({side:'B',text:longText,durationMs:260000,emotion:'happy',audience:kind==='script'?undefined:{name:'观众甲'}},kind);app.runtime.emit();
    await page.waitForFunction(kind=>{const tag=document.getElementById('scene-context');return kind==='script'?tag.hidden:!tag.hidden&&tag.dataset.kind===kind;},kind);
    assert.equal(await page.locator('#scene-speaker').innerText(),'鲸鱼娘');
    assert.equal(await page.locator('#scene-line').innerText(),pages[0]);
    const measure=await page.locator('.dialogue').evaluate(el=>{const line=document.getElementById('scene-line'),body=line.parentElement,scale=document.getElementById('stage').getBoundingClientRect().width/540;return {font:parseFloat(getComputedStyle(line).fontSize)*scale,full:line.scrollHeight,available:body.clientHeight,lines:line.scrollHeight/parseFloat(getComputedStyle(line).lineHeight),top:el.getBoundingClientRect().top,panelBottom:document.querySelector('.camp-panel').getBoundingClientRect().bottom};});
    assert.ok(measure.font>=15&&measure.font<=16,'手机字幕保持约15像素，避免字号过大');assert.ok(measure.lines<=3.1&&measure.full<=measure.available+1,'字幕完整呈现且最多三行');assert.ok(measure.top>=measure.panelBottom,'主字幕不能与礼物提示重叠');
    assert.equal(await page.locator('#scene-receipt').count(),0,'回复不使用遮挡式浮卡');
    await page.screenshot({path:path.join(output,'scene-phone-'+kind+'.png')});
  }
  const samples=[
    '你说态度要到位，可工作明明都做完了，非得坐到晚上十点才算态度好？我承认交接要认真，可不能因为一个人还没走，就让所有人陪着。',
    '这是没有标点的长句字幕'.repeat(15),
    '中文混合 WWWWWWWWWWWW 英文以及🙂👍表情，不应在最后一行把字切掉。'.repeat(5),
    '🙂👍'.repeat(70)
  ];
  for(const [sampleIndex,text]of samples.entries()){
    const renderedPages=await page.evaluate(async text=>{const {fitCaptionPages}=await import('/caption-layout.js');return fitCaptionPages(text,document.getElementById('scene-line'));},text);
    assert.equal(renderedPages.join(''),text,'所有页拼回后完整保留台词');let position=0;
    for(const caption of renderedPages){
      app.runtime.engine.state.scriptLine={side:'A',text,kind:'script',at:Date.now()-(position+0.5)*1000,durationMs:Array.from(text).length*1000};app.runtime.emit();
      await page.waitForFunction(caption=>document.getElementById('scene-line').textContent===caption,caption);
      const fit=await page.locator('#scene-line').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const glyphs=range.getBoundingClientRect(),body=el.parentElement.getBoundingClientRect();return {glyphBottom:glyphs.bottom,bodyBottom:body.bottom,paragraph:el.scrollHeight,available:el.parentElement.clientHeight};});
      assert.ok(fit.paragraph<=fit.available&&fit.glyphBottom<=fit.bodyBottom,'最后一行和字形完整处于字幕区内 '+JSON.stringify(fit));
      if(sampleIndex===0&&position===0)await page.screenshot({path:path.join(output,'scene-caption-corrected.png')});
      position+=Array.from(caption).length;
    }
  }
  app.runtime.engine.state.scriptLine=previousLine;app.runtime.emit();
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'scene-check.json'),JSON.stringify({ok:true,result,errors},null,2));
  console.log(JSON.stringify({ok:true,result,errors},null,2));
}finally{
  await browser?.close();await app?.close();
  assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-bianlun-scene-'));
  await rm(dataDir,{recursive:true,force:true});
}
