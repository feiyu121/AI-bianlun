import test from 'node:test';
import assert from 'node:assert/strict';
import {captionPages,captionAt} from '../public/captions.js';
test('长句字幕分段完整保留原话，短问不拆分',()=>{
 const text='我想先把这个条件说清楚。'.repeat(20);
 const pages=captionPages(text);
 assert.equal(pages.join(''),text);assert.ok(pages.length>1);
 assert.ok(pages.every(page=>Array.from(page).length<=100));
 assert.deepEqual(captionPages('为什么？'),['为什么？']);
 assert.equal(captionAt('为什么？',10000,1000),'为什么？');
});
test('字幕随发言进度换页，首尾和无音频估时仍有效',()=>{
 const text='甲'.repeat(100)+'乙'.repeat(100)+'丙'.repeat(60);
 assert.equal(captionAt(text,-100,26000),'甲'.repeat(100));
 assert.equal(captionAt(text,12000,26000),'乙'.repeat(100));
 assert.equal(captionAt(text,25999,26000),'丙'.repeat(60));
 assert.equal(captionAt(text,999999,26000),'丙'.repeat(60));
 assert.equal(captionAt(text,25000),'乙'.repeat(100));
 assert.equal(captionAt('',0), '');
});
