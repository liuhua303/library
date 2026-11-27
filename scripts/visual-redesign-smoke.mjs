import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import JSZip from 'jszip';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSampleBook } from './create-sample.mjs';
import { closeNotebook, closeTools, importAndOpenBook, openBookFromShelf, openNotebook, openTools, turnPage } from './reader-test-ui.mjs';

const artifacts = resolve('artifacts');
await mkdir(artifacts, { recursive:true });
const temporary = await mkdtemp(join(tmpdir(),'yuejian-redesign-'));
const title = '封面与浮层验收';
const fallbackTitle = '无封面验收';
const sample = await createSampleBook(join(temporary,'cover.epub'), {title,identifier:'yuejian-visual-cover'});
const noCover = await createSampleBook(join(temporary,'no-cover.epub'), {title:fallbackTitle,identifier:'yuejian-visual-fallback'});

// Build an actual two-color PNG without a remote resource or an image dependency.
function crc32(bytes) {
  let crc=0xffffffff;
  for (const byte of bytes) {
    crc^=byte;
    for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  return (crc^0xffffffff)>>>0;
}
function pngChunk(type,data) {
  const name=Buffer.from(type), length=Buffer.alloc(4), crc=Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([length,name,data,crc]);
}
const width=120,height=180, pixels=Buffer.alloc((width*3+1)*height);
for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
  const offset=y*(width*3+1)+1+x*3;
  pixels.set(y<height/2?[177,46,38]:[36,98,184],offset);
}
const header=Buffer.alloc(13); header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
const cover=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
const archive=await JSZip.loadAsync(await readFile(sample));
archive.file('OEBPS/images/actual-cover.png',cover);
const opf=await archive.file('OEBPS/package.opf').async('string');
archive.file('OEBPS/package.opf',opf.replace('<manifest>','<manifest><item id="real-cover" href="images/actual-cover.png" media-type="image/png" properties="cover-image"/>'));
await writeFile(sample,await archive.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));

const env={...process.env,APP_TEST_MODE:'1',READER_USER_DATA:join(temporary,'data')};
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const checks=[],measurements=[],errors=[];
let app,page,bookId;
const step=name=>console.log('visual-redesign: '+name);

async function launch() {
  app=await electron.launch({executablePath:electronPath,args:['app/main.cjs'],env,timeout:30000});
  page=await app.firstWindow({timeout:15000});
  page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('heading',{name:'书架',exact:true}).waitFor();
}

async function readingFrame() {
  for(let attempt=0;attempt<120;attempt++) {
    for(const frame of page.frames().filter(frame=>frame!==page.mainFrame())) {
      if((await frame.locator('body').textContent().catch(()=>''))?.includes('Clara')) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('EPUB 正文未渲染');
}

async function layoutSnapshot() {
  const frame=await readingFrame();
  const viewport=await page.getByTestId('epub-viewport').boundingBox();
  const data=await frame.evaluate(()=>{
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT), rects=[];
    let node;
    while((node=walker.nextNode())&&rects.length<25) {
      for(const match of node.textContent.matchAll(/[A-Za-z]+/g)) {
        const range=document.createRange();range.setStart(node,match.index);range.setEnd(node,match.index+match[0].length);
        const r=range.getBoundingClientRect();
        if(r.width>0&&r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight) rects.push({word:match[0],x:r.x,y:r.y,width:r.width,height:r.height});
        if(rects.length>=25) break;
      }
    }
    return {rects,bodyWidth:document.body.clientWidth,selection:document.getSelection()?.toString()||''};
  });
  return {viewport,data,page:await page.locator('.reader-page-position').innerText(),cfi:(await page.evaluate(id=>window.readerApi.listBooks().then(books=>books.find(book=>book.id===id).lastLocation),bookId))};
}

async function wordPosition(name,end=false) {
  const frame=await readingFrame();
  const local=await frame.evaluate(({name,end})=>{
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode())) {
      const offset=node.textContent.indexOf(name);if(offset<0)continue;
      const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+name.length);
      const r=range.getBoundingClientRect();
      if(r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight)return{x:end?r.right-.2:r.x+.2,y:r.y+r.height/2};
    }
    throw new Error('当前页没有 '+name);
  },{name,end});
  const box=await(await frame.frameElement()).boundingBox();return{x:box.x+local.x,y:box.y+local.y};
}

async function hostJ() {
  await page.getByRole('button',{name:'阅读工具',exact:true}).focus();
  await page.keyboard.press('j');
}

async function assertOverlayPreserves(before,stage) {
  await page.waitForTimeout(250);
  const after=await layoutSnapshot();
  if(await page.getByTestId('vocabulary-sidebar').isVisible()) {
    assert.deepEqual(await page.getByTestId('vocabulary-sidebar').evaluate(el=>({background:getComputedStyle(el).backgroundColor,opacity:getComputedStyle(el).opacity})),{background:'rgb(255, 255, 255)',opacity:'1'},stage+' 单词本应是不透明白色');
  }
  assert.deepEqual(after.viewport,before.viewport,stage+' 不应改变阅读容器边界');
  assert.deepEqual(after.data.rects,before.data.rects,stage+' 不应改变正文换行或文字位置');
  assert.equal(after.data.bodyWidth,before.data.bodyWidth,stage+' 不应改变正文宽度');
  assert.equal(after.cfi,before.cfi,stage+' 不应改变保存的阅读内容位置');
  assert.equal(after.page,before.page,stage+' 不应重新分页');
  measurements.push({stage,viewport:after.viewport,cfi:after.cfi,page:after.page,measuredWords:after.data.rects.length});
}

async function assertNoWindowOverflow(stage) {
  const sizes=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,panels:[...document.querySelectorAll('.vocabulary-sidebar,.reader-tools-menu,.reader-toc,[role="dialog"]')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return{class:el.className,left:r.left,top:r.top,right:r.right,bottom:r.bottom};})}));
  assert.ok(sizes.scrollWidth<=sizes.width+1,stage+' 不应出现横向溢出');
  assert.ok(sizes.scrollHeight<=sizes.height+1,stage+' 不应出现窗口级纵向溢出');
  for(const panel of sizes.panels) assert.ok(panel.left>=-1&&panel.top>=-1&&panel.right<=sizes.width+1&&panel.bottom<=sizes.height+1,stage+' 浮层不能越界 '+JSON.stringify(panel));
  measurements.push({stage,...sizes});
}

try {
  step('空书架');
  await launch();
  assert.equal(await page.getByTestId('epub-viewport').count(),0);
  await page.getByRole('button',{name:'设置',exact:true}).waitFor();
  assert.equal(await page.locator('.app-shell').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  const shellText=await page.locator('body').innerText();
  for(const copy of ['A SPACE TO READ','把时间，留给阅读','READ SLOWLY','点击生词，留待回看']) assert.ok(!shellText.includes(copy));
  await page.screenshot({path:join(artifacts,'redesign-empty-shelf.png'),animations:'disabled'});
  checks.push('启动先显示极简白色书架，导入和设置可发现，无旧版说明文案');

  step('书架 API 设置');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const apiDialog=page.getByRole('dialog');await apiDialog.waitFor();
  const apiKey=apiDialog.locator('#api-key');await apiKey.fill('j');await apiKey.press('j');
  assert.equal(await apiKey.inputValue(),'jj','书架 API 设置内 J 应作为普通文字输入');
  assert.equal(await apiDialog.locator('#model-name').count(),1);
  await apiDialog.getByRole('button',{name:'关闭设置',exact:true}).click();
  await apiDialog.waitFor({state:'hidden'});
  checks.push('书架保留 API 密钥与模型设置，输入 J 正常且关闭后返回书架');

  step('导入并阅读真实封面书籍');
  await importAndOpenBook(app,page,sample,title);
  bookId=(await page.evaluate(()=>window.readerApi.listBooks()))[0].id;
  await readingFrame();
  await page.waitForTimeout(500);
  const before=await layoutSnapshot();
  assert.equal(await page.locator('.library-sidebar').count(),0,'阅读时不应常驻书架');
  await page.screenshot({path:join(artifacts,'redesign-reading.png'),animations:'disabled'});

  step('宿主与正文 J、浮层不重排');
  await hostJ();
  await page.getByTestId('vocabulary-sidebar').waitFor();
  await assertOverlayPreserves(before,'宿主 J 打开');
  await page.screenshot({path:join(artifacts,'redesign-notebook.png'),animations:'disabled'});
  const frame=await readingFrame();
  await frame.locator('body').press('j');
  await page.getByTestId('vocabulary-sidebar').waitFor({state:'hidden'});
  await assertOverlayPreserves(before,'正文 J 关闭');
  await frame.locator('body').press('j');
  await page.getByTestId('vocabulary-sidebar').waitFor();
  await closeNotebook(page);
  checks.push('J 在宿主与 EPUB 正文均切换一次，浮层开关保持容器、文字换行、页码和内容位置');

  step('选区在工具与浮层之间保持');
  const first=await wordPosition('Clara'),last=await wordPosition('bookshop',true);
  await page.mouse.move(first.x,first.y);await page.mouse.down();
  const moving=page.mouse.move(last.x,last.y);await new Promise(resolve=>setTimeout(resolve,120));await page.mouse.up();await moving;
  await page.locator('.reader-selection-summary').waitFor();
  const selection=await page.locator('.reader-selection-summary > span').getAttribute('title');
  const selectedLayout=await layoutSnapshot();
  const selectionRects=await page.locator('.reader-selection-rect').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}));
  await openNotebook(page);
  assert.equal(await page.locator('.reader-selection-summary > span').getAttribute('title'),selection);
  assert.deepEqual(await page.locator('.reader-selection-rect').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})),selectionRects);
  await assertOverlayPreserves(selectedLayout,'选区中打开浮层');
  await closeNotebook(page);
  assert.equal(await page.locator('.reader-selection-summary > span').getAttribute('title'),selection);
  await page.getByRole('button',{name:'取消选区',exact:true}).click();
  checks.push('工具和浮层操作不清除选区，不改变高亮几何，也不穿透误收录');
  assert.equal((await page.evaluate(id=>window.readerApi.listEntries(id),bookId)).length,0);

  step('阅读设置隔离 API 与阅读快捷键');
  await openTools(page);await page.getByRole('button',{name:'主题与设置',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.waitFor();
  assert.equal(await dialog.locator('#api-key,#model-name').count(),0,'阅读设置不应暴露 API 配置');
  const closeReadingSettings=dialog.getByRole('button',{name:'关闭阅读设置',exact:true});
  await closeReadingSettings.focus();await page.keyboard.press('j');
  assert.equal(await page.getByTestId('vocabulary-sidebar').isVisible(),false);
  const position=await page.locator('.reader-page-position').innerText();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('.reader-page-position').innerText(),position);
  await assertNoWindowOverflow('阅读设置');
  await closeReadingSettings.click();
  checks.push('阅读设置仅包含阅读选项，J 不打开单词本，方向键不翻动背后书页');

  step('真实收录、查看和原文回跳');
  await app.evaluate(()=>{globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'word',targetText:'peculiar',meaningZh:'奇特的；这里指不同寻常的寂静。',definitionEn:'Unusual in this context.',usage:'Describes the silence.',example:'A peculiar silence filled the room.'})},finish_reason:'stop'}]}),{status:200,headers:{'Content-Type':'application/json'}});});
  await page.evaluate(()=>window.readerApi.saveSettings({apiKey:'sk-isolated-visual-test-only'}));
  const point=await wordPosition('peculiar');await page.mouse.click(point.x+2,point.y);
  await page.waitForFunction(async id=>(await window.readerApi.listEntries(id)).some(entry=>entry.occurrences.some(occurrence=>occurrence.status==='completed')),bookId);
  const entry=(await page.evaluate(id=>window.readerApi.listEntries(id),bookId))[0];
  await page.mouse.click(point.x+2,point.y);
  await page.locator('.selection-menu').getByRole('button',{name:'查看',exact:true}).click();
  const occurrence=page.getByTestId('occurrence-'+entry.occurrences[0].id);await occurrence.waitFor();
  await occurrence.getByText('奇特的；这里指不同寻常的寂静。',{exact:true}).waitFor();
  await page.screenshot({path:join(artifacts,'redesign-analysis.png'),animations:'disabled'});
  await occurrence.getByRole('button',{name:'返回原文',exact:true}).click();
  await page.getByTestId('vocabulary-sidebar').waitFor({state:'hidden'});
  await page.locator('.reader-focus-rect').first().waitFor({state:'attached'});
  assert.equal(await page.locator('.reader-focus-rect').first().evaluate(el=>getComputedStyle(el).animationIterationCount),'2');
  checks.push('原文查看定位并展开正确解析，返回原文收起浮层并闪烁两次（隔离模拟 API）');

  step('书架原图与无封面降级');
  await page.getByRole('button',{name:'返回书架',exact:true}).click();
  const coverButton=page.getByRole('button',{name:'阅读 '+title,exact:true});
  const coverImage=coverButton.locator('img');await coverImage.waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.book-cover-button img')].every(img=>img.complete&&img.naturalWidth>0));
  assert.equal(await coverImage.getAttribute('src'),'data:image/png;base64,'+cover.toString('base64'),'应使用 EPUB 中原始封面数据');
  assert.deepEqual(await coverImage.evaluate(img=>({width:img.naturalWidth,height:img.naturalHeight,filter:getComputedStyle(img).filter})),{width,height,filter:'none'});
  const coverProgress=(await page.evaluate(()=>window.readerApi.listBooks())).find(book=>book.id===bookId).progress;
  assert.equal((await coverButton.innerText()).trim(),Math.round(Math.min(1,Math.max(0,coverProgress))*100)+'%','有封面时只显示真实已读百分比');
  await importAndOpenBook(app,page,noCover,fallbackTitle);
  await page.getByRole('button',{name:'返回书架',exact:true}).click();
  const fallback=page.getByRole('button',{name:'阅读 '+fallbackTitle,exact:true});await fallback.waitFor();
  assert.equal(await fallback.locator('img').count(),0);
  assert.ok((await fallback.innerText()).includes(fallbackTitle),'无封面仅使用书名占位');
  await page.screenshot({path:join(artifacts,'redesign-shelf.png'),animations:'disabled'});
  checks.push('封面原图像素与比例保留，无封面书籍显示书名占位，两本书均可阅读');

  step('窄窗口与续读');
  await openBookFromShelf(page,title);await readingFrame();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1050,680));
  await page.waitForTimeout(450);await openNotebook(page);await assertNoWindowOverflow('最小窗口单词本');
  await page.screenshot({path:join(artifacts,'redesign-small-window.png'),animations:'disabled'});await closeNotebook(page);
  const oldPage=await page.locator('.reader-page-position').innerText();await turnPage(page,1);
  await page.waitForFunction(old=>document.querySelector('.reader-page-position')?.textContent!==old,oldPage);
  await page.waitForTimeout(450);
  const saved=(await page.evaluate(()=>window.readerApi.listBooks())).find(book=>book.id===bookId).lastLocation;
  const savedPage=await page.locator('.reader-page-position').innerText();
  await page.getByRole('button',{name:'返回书架',exact:true}).click();
  await openBookFromShelf(page,title);await readingFrame();await page.waitForTimeout(500);
  assert.equal(await page.locator('.reader-page-position').innerText(),savedPage,'同会话立即重开书籍应恢复刚才页码');
  assert.equal((await page.evaluate(()=>window.readerApi.listBooks())).find(book=>book.id===bookId).lastLocation,saved,'迟到的初始位置不得覆盖同会话续读位置');
  checks.push('翻页后返回书架并立即重开同一本书，页码与内容位置不回退');
  await app.close();app=null;await launch();
  assert.equal(await page.getByTestId('epub-viewport').count(),0,'重启必须先到书架');
  const restored=(await page.evaluate(()=>window.readerApi.listBooks())).find(book=>book.id===bookId);
  assert.equal(restored.lastLocation,saved);
  await openBookFromShelf(page,title);await readingFrame();
  assert.ok((await page.evaluate(id=>window.readerApi.listEntries(id),bookId)).some(entry=>entry.term==='peculiar'));
  checks.push('最小窗口浮层不越界，重启先显示书架，点击封面后续读，书籍与收录数据保留');
  await closeTools(page);
  assert.deepEqual(errors,[]);
  await writeFile(join(artifacts,'visual-redesign-result.json'),JSON.stringify({passed:true,checks,measurements,errors,userData:temporary},null,2));
  console.log(JSON.stringify({passed:true,checks,measurements,errors},null,2));
} catch(error) {
  console.error(error);
  if(page){await page.screenshot({path:join(artifacts,'visual-redesign-failure.png'),animations:'disabled'}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'')).slice(0,4000));}
  await writeFile(join(artifacts,'visual-redesign-result.json'),JSON.stringify({passed:false,checks,measurements,errors,message:String(error),userData:temporary},null,2));
  process.exitCode=1;
} finally {if(app)await app.close();}
