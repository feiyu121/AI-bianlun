// Keep longer turns readable in the fixed OBS subtitle area. Page timing is approximate.
export function captionPages(value,maxChars=100){
 const chars=Array.from(String(value||'')),pages=[];
 while(chars.length){
  let count=Math.min(maxChars,chars.length);
  if(count<chars.length){
   const head=chars.slice(0,count).join('');
   const boundary=Math.max(head.lastIndexOf('。'),head.lastIndexOf('！'),head.lastIndexOf('？'),head.lastIndexOf('；'),head.lastIndexOf('，'));
   if(boundary>=maxChars/2)count=boundary+1;
  }
  pages.push(chars.splice(0,count).join(''));
 }
 return pages;
}
export function captionAt(text,elapsedMs=0,durationMs=0){
 const pages=captionPages(text);if(pages.length<=1)return pages[0]||'';
 const total=pages.reduce((sum,page)=>sum+Array.from(page).length,0);
 const progress=Math.max(0,Math.min(1,elapsedMs/(durationMs>0?durationMs:total/4.9*1000)));
 let end=0;
 for(const page of pages){end+=Array.from(page).length;if(progress<end/total)return page;}
 return pages.at(-1);
}
