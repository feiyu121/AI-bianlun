import test from 'node:test';
import assert from 'node:assert/strict';
import {captionPages,captionAt,CAPTION_PAGE_CHARS} from '../public/captions.js';
test('长句字幕分段完整保留原话，短问不拆分',()=>{
 const text='我想先把这个条件说清楚。'.repeat(20);
 const pages=captionPages(text);
 assert.equal(pages.join(''),text);assert.ok(pages.length>1);
 assert.ok(pages.every(page=>Array.from(page).length<=CAPTION_PAGE_CHARS));
 assert.deepEqual(captionPages('为什么？'),['为什么？']);
 assert.equal(captionAt('为什么？',10000,1000),'为什么？');
});
test('字幕随发言进度换页，首尾和无音频估时仍有效',()=>{
 const text='甲'.repeat(60)+'乙'.repeat(60)+'丙'.repeat(30);
 assert.equal(captionAt(text,-100,15000),'甲'.repeat(60));
 assert.equal(captionAt(text,7500,15000),'乙'.repeat(60));
 assert.equal(captionAt(text,14999,15000),'丙'.repeat(30));
 assert.equal(captionAt(text,999999,15000),'丙'.repeat(30));
 assert.equal(captionAt(text,15000),'乙'.repeat(60));
 assert.equal(captionAt('',0), '');
});

test('按实际可容纳长度分页，混合文字与表情不漏字，优先完整句或分句',()=>{
 const text='这句话先说清楚，然后再把下一件事说完。'+('中文ABC🙂，继续说明这个条件。'.repeat(10));
 const fits=value=>Array.from(value).length<=35;
 const pages=captionPages(text,60,fits);
 assert.equal(pages.join(''),text);assert.ok(pages.every(fits));
 assert.ok(/[。！？；，]$/u.test(pages[0]),'有自然断点时不切在半句话');
 const compact=captionPages('甲'.repeat(100),60,value=>value.length<=20);
 assert.deepEqual(compact,Array(5).fill('甲'.repeat(20)));
 assert.equal(captionAt(text,999999,10000,pages),pages.at(-1));
});
