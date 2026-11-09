import {captionPages,CAPTION_PAGE_CHARS} from './captions.js';

// Measure with the actual subtitle font and width. A character count alone cannot
// predict line breaks for mixed Chinese, Latin text, punctuation and emoji.
export function fitCaptionPages(text,line,{maxChars=CAPTION_PAGE_CHARS,maxLines=3}={}){
 const body=line.parentElement,style=getComputedStyle(line),lineHeight=parseFloat(style.lineHeight);
 const available=Math.min(body.clientHeight-4,Math.ceil(lineHeight*maxLines)+1);
 const measure=line.cloneNode(false);measure.removeAttribute('id');measure.setAttribute('aria-hidden','true');
 Object.assign(measure.style,{position:'absolute',visibility:'hidden',pointerEvents:'none',width:body.clientWidth+'px',height:'auto',maxHeight:'none',margin:'0'});
 body.append(measure);
 try{return captionPages(text,maxChars,candidate=>{measure.textContent=candidate;return measure.scrollHeight<=available;});}
 finally{measure.remove();}
}
