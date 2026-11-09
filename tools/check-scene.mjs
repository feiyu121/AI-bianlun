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
  await page.locator('#topic').selectOption(['slack','meeting']);await page.locator('#batch-count').fill('2');
  const dialogue='我们先把这件事实际发生时的条件讲清楚，再看对方提出的办法是否真的有用。'.repeat(6);
  await app.runtime.saveScript({id:'qa-library',topic:'会议应该怎样安排',topicId:'meeting',meta:{ready:true},turns:Array.from({length:44},(_,i)=>({act:Math.floor(i/4)+1,side:i%2?'B':'A',text:dialogue}))});
  await page.getByRole('button',{name:'移出轮播',exact:true}).click();
  await page.getByRole('button',{name:'加入轮播',exact:true}).waitFor();assert.equal(app.runtime.snapshot().library.available,0);
  await page.getByRole('button',{name:'加入轮播',exact:true}).click();
  await page.getByRole('button',{name:'移出轮播',exact:true}).waitFor();assert.equal(app.runtime.snapshot().library.available,1);
  await page.getByRole('button',{name:'预合成配音',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('library-operation').textContent.includes('整场配音已缓存'));
  const sample={topic:'接住现场的一句话',turns:[{act:1,side:'A',text:'那我们先把条件讲清楚。'},{act:2,side:'B',text:'行，你先说说看。'}]};
  await page.locator('#import-script').setInputFiles({name:'qa-short.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(sample))});
  const imported=page.locator('.script-row').filter({hasText:'接住现场的一句话'});await imported.waitFor();
  assert.match(await imported.innerText(),/短样稿/);
  await page.screenshot({path:path.join(output,'library.png'),fullPage:true});
  await imported.getByRole('button',{name:'播放',exact:true}).click();
  await page.locator('#stop:not([disabled])').waitFor();await page.locator('#stop').click();
  await page.waitForFunction(()=>document.getElementById('operation').textContent.includes('已停止'));
  assert.equal(app.runtime.runner.active,false);
  await page.getByRole('button',{name:'模型与语音'}).click();
  assert.equal(await page.locator('#tab-settings').isVisible(),true);
  await page.getByRole('button',{name:'直播间与防护'}).click();
  assert.equal(await page.locator('#tab-connection').isVisible(),true);
  await page.goto(base+'/scene.html?preview=1');
  await page.locator('#avatar-a[data-ready=true]').waitFor({timeout:60000});await page.locator('#avatar-b[data-ready=true]').waitFor({timeout:60000});
  await page.setViewportSize({width:540,height:960});
  assert.match(await page.locator('.side-a .debater-label span').innerText(),/嘴硬心软/);
  assert.match(await page.locator('.side-b .debater-label span').innerText(),/温柔补刀/);
  assert.equal(await page.locator('#scene-name-a').innerText(),'肉包');
  await page.screenshot({path:path.join(output,'scene.png')});
  const longText='这是用来检查长句字幕是否完整显示的内容，我们可以慢慢把一个条件说清楚。'.repeat(8).slice(0,260);
  const captions=await import('../public/captions.js'),pages=captions.captionPages(longText);
  let consumed=0;
  for(const text of pages){
    app.runtime.engine.state.scriptLine={side:'A',text:longText,at:Date.now()-(consumed+1)*1000,durationMs:longText.length*1000};app.runtime.emit();
    await page.waitForFunction(text=>document.getElementById('scene-line').textContent===text,text);
    const box=await page.locator('#scene-line').evaluate(el=>({visible:el.clientHeight,full:el.scrollHeight,bottom:el.getBoundingClientRect().bottom,container:el.closest('.dialogue').getBoundingClientRect().bottom}));
    assert.ok(box.full<=box.visible+1,'每页字幕应完整显示');assert.ok(box.bottom<=box.container,'字幕不能溢出对话框');
    consumed+=text.length;
  }
  await page.screenshot({path:path.join(output,'scene-long-caption.png')});
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'scene-check.json'),JSON.stringify({ok:true,result,errors},null,2));
  console.log(JSON.stringify({ok:true,result,errors},null,2));
}finally{
  await browser?.close();await app?.close();
  assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep+'ai-bianlun-scene-'));
  await rm(dataDir,{recursive:true,force:true});
}
