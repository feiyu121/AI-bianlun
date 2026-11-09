// Long-form lines must never inherit the short-form player's 20 second ceiling.
export function estimateDuration(text) {
  const chars=String(text||'').replace(/[\s，。！？、；：,.!?;:"“”‘’]/gu,'').length;
  return Math.max(1500,Math.round(chars/4.9*1000));
}
export function pickOpponentVoice(taken='') {
  return ['zh-CN-XiaoyiNeural','zh-TW-HsiaoYuNeural','zh-CN-liaoning-XiaobeiNeural'].find(x=>x!==taken);
}
export function turnEmotion({text=''}={}) {
  if(/[？?]/u.test(text))return 'question';
  if(/[！!]/u.test(text))return 'angry';
  return /偷|演|装|借口|亏|返工/u.test(text)?'smug':'focus';
}
