// Keep longer turns readable in the fixed OBS subtitle area. Page timing is approximate.
export const CAPTION_PAGE_CHARS=60;
export function captionPages(value,maxChars=CAPTION_PAGE_CHARS,fits=()=>true){
 if(!Number.isInteger(maxChars)||maxChars<1)throw new Error('字幕分页字数必须为正整数');
 const chars=Array.from(String(value||'')),pages=[];
 while(chars.length){
  let count=Math.min(maxChars,chars.length);
  if(!fits(chars.slice(0,count).join(''))){
   let low=1,high=count;
   while(low<high){const middle=Math.ceil((low+high)/2);if(fits(chars.slice(0,middle).join('')))low=middle;else high=middle-1;}
   count=low;
  }
  if(count<chars.length){
   let sentence=-1,clause=-1;
   for(let i=0;i<count;i++){
    if(/[。！？!?；;]/u.test(chars[i]))sentence=i;
    if(/[，、,：:。！？!?；;]/u.test(chars[i]))clause=i;
   }
   const minimum=Math.floor(count*.4),boundary=sentence>=minimum?sentence:clause;
   if(boundary>=minimum)count=boundary+1;
  }
  pages.push(chars.splice(0,count).join(''));
 }
 return pages;
}
export function captionAt(text,elapsedMs=0,durationMs=0,pages=captionPages(text)){
 if(pages.length<=1)return pages[0]||'';
 const total=pages.reduce((sum,page)=>sum+Array.from(page).length,0);
 const progress=Math.max(0,Math.min(1,elapsedMs/(durationMs>0?durationMs:total/4.9*1000)));
 let end=0;
 for(const page of pages){end+=Array.from(page).length;if(progress<end/total)return page;}
 return pages.at(-1);
}
