// 剧本播放器：游标 + 槽位 + 反应位旁挂。
//
// 和现编模式（lib/debate-runner.mjs）的根本差别是「谁决定下一句」：
//   现编   模型在 9 秒死线里写完再播，写慢了就欠一句模板
//   剧本   文本早在开播前就写完了，播放器只负责按时间轴推游标
// 所以这里没有 generate，只有 render（把已经写好的文字变成音频）。
//
// 三件容易翻车的事，都在这里挡住：
//   1. 音频断供。TTS 是串行的（cloud-voice.mjs:164 的 this.tail），一句 30 秒的台词
//      要 1.2 秒合成，预读 2 句就够用；但一旦等到「上一句播完才开始合成」，
//      观众看到的是画面停住两秒——直播里这比说错话更明显。
//   2. 预渲染的音频又被排进合成队列。合成 URL 直接挂在 utterance 上，
//      /api/speech 见到就直返，不再过 this.tail，否则接话的合成会把下一句剧本堵住。
//   3. 位置漂移。时间轴按字数估算排，真实音频差 10%~20%，半小时能漂一分钟。
//      每播完一句把实测时长回写给时间轴（stage.retime），位置才贴得住画面。
import {estimateDuration, turnEmotion} from '../speech.mjs';
import {ReactionStage} from './stage.mjs';

export const SCRIPT_RUNNER_DEFAULTS = Object.freeze({
 // 预读句数。按 30 秒一句、1.2 秒一合成，2 句就是 60 秒的余量，够扛一次合成抖动。
 // 再多只是在 TTS 队列里堆着——接话的那一句会排在它们后面，反而被拖慢。
 lookahead: 2,
 // 等「真的出声」的上限。前端取音频是本地请求，2.5 秒已经非常宽裕；
 // 无声直播时 voiceExpected 为 false，这里一次都不会等。
 waitVoiceMs: 2500,
 // 开播前先合成几句：不预热就开播，第一句必然等 1.2 秒才出声。
 prewarm: 2
});

export class ScriptRunner {
 constructor({engine, cloudVoice, safety = null, stage = null, now = Date.now, sleep, rng = Math.random,
  onChange = () => {}, onEnd = () => {}, voiceExpected = () => false, log = () => {},
  lookahead = SCRIPT_RUNNER_DEFAULTS.lookahead, waitVoiceMs = SCRIPT_RUNNER_DEFAULTS.waitVoiceMs,
  prewarm = SCRIPT_RUNNER_DEFAULTS.prewarm, opponentName = '鲸鱼娘', mention = null, draft = null,
  mentionDraft = null, mentionWaitMs = 1200, mentionSlotMax = 2,
  gifts = null, giftDraft = null, giftWaitMs = 1200} = {}) {
  if (!engine) throw new Error('剧本播放需要 engine');
  if (!cloudVoice) throw new Error('剧本播放需要语音合成');
  this.engine = engine;
  this.cloudVoice = cloudVoice;
  this.safety = safety;
  this.now = now;
  this.sleep = sleep || (ms => new Promise(resolve => {
   let timer;const done=()=>{clearTimeout(timer);this.stopWaiters.delete(done);resolve();};
   this.stopWaiters.add(done);timer=setTimeout(done,ms);
  }));
  this.rng = rng;
  this.onChange = onChange;
  this.onEnd = onEnd;
  this.voiceExpected = voiceExpected;
  this.log = log;
  this.lookahead = Math.max(0, Math.trunc(lookahead));
  this.waitVoiceMs = Math.max(200, Math.trunc(waitVoiceMs));
  this.prewarmCount = Math.max(0, Math.trunc(prewarm));
  this.opponentName = opponentName;
  // 点名路由（lib/mention.mjs）。没接的时候所有弹幕都进反应池——
  // 这是安全的一侧：反应池只挑一条短句回应，不会把观众的话写进辩论上下文。
  // 兼容旧写法：传函数时按「命中就返回对象」处理，传 MentionRouter 时用它的 hear()。
  this.mention = mention;
  // 反应句的写手：(item, turn, slot) -> 文本或 Promise。没接就是「只会走 L0/气泡」——
  // 那是安全的一侧：宁可少接一句，也不要让一句没写完的话在台上说出口。
  this.draft = draft;
  // 点名句的写手：(item, {side, opponent, turn}) -> 文本或 Promise。
  // 与反应句分开，因为提示词完全不同：一个是「借他的话打自己的仗」，一个是「回他」。
  this.mentionDraft = mentionDraft;
  // 到点还没写好时最多再等多久。点名句在正轨上，台上不能空着等模型——
  // 1.2 秒是这套设计里「空档」的判定线，超过它观众就开始觉得卡了。
  // 等不到不丢：排回队里等下一幕（见 mentionSlot）。
  this.mentionWaitMs = Math.max(0, Math.trunc(mentionWaitMs));
  this.mentionSlotMax = Math.max(1, Math.trunc(mentionSlotMax));
  // 礼物槽（lib/script/gifts.mjs）。与点名槽共用幕边界那一个位置，但优先级更高：
  // 花了钱的人先上，等了一幕的人再等一幕——两条队列互不抢配额。
  this.gifts = gifts;
  // 礼物句的写手：(item, {side, opponent, turn}) -> 文本或 Promise。
  // 没接就是「礼物只记账不出声」——安全的一侧：宁可少一句，不要念一句道谢。
  this.giftDraft = giftDraft;
  this.giftWaitMs = Math.max(0, Math.trunc(giftWaitMs));
  // 场控点了跳幕、还没落到目标格之前，游标要停在这里等一句说完。
  this.skipTarget = null;
  this.stage = stage || new ReactionStage({
   now: this.now, log,
   // 舞台只知道「第几格」，不知道那一格说了什么。接话要借上一句的原话，
   // 所以在这里把 turn 补进去，写手拿到的就是完整语境。
   draft: (item, slot) => (this.draft ? this.draft(item, this.turns[slot?.index] || null, slot) : '')
  });
  this.sides = [];
  // 幕表：装剧本时算出来，场控面板按它显示进度与「重写这一幕」。
  this.acts = [];
  this.script = null;
  this.turns = [];
  this.cursor = 0;
  this.active = false;
  this.paused = false;
  this.stopped = false;
  this.error = '';
  this.voiceError = '';
  this.topic = '';
  this.scriptId = '';
  this.startedAt = 0;
  this.finishedAt = 0;
  this.prevEndAt = 0;
  this.current = null;
  this.audioJobs = new Map();
  this.voiceWaiters = new Map();
  this.voiceReported = new Set();
  // 回执：每一格「被听见的弹幕」去了哪里。§6.5.7 第 1、2 条靠它落地——
  // 弹幕墙要把那一条钉住 6 秒并标「已回应」，界面还得知道是谁接的。
  // 只留最近 12 条：一整场几百条回执对前端没用，只会把快照撑肥。
  this.receipts = [];
  // 弹幕墙（§6.5.7）：每一条进来的弹幕都要上墙，不管有没有人回它。
  // 只留「被回过的」会让墙看起来像精选留言——观众发十句全是空白，反而更冷。
  // 上限 40 条：再多前端滚动就追不上了，也把快照撑肥。
  this.wall = [];
  this.wallSeq = 0;
  this.stopWaiters = new Set();
  this.gateWaiters = [];
  this.stats = this.freshStats();
 }

 freshStats() {
  return {
   turns: 0, chars: 0, playedMs: 0, rendered: 0, voiceFailed: 0,
   gaps: [], maxGap: 0, starved: 0,
   reactions: 0, ambient: 0, bubbles: 0, overrun: 0, mentions: 0, gifts: 0,
   pausedMs: 0, pausedAt: 0
  };
 }

 // ── 装剧本 ───────────────────────────────────────────────────────
 // script: {id?, topic?, sides?:[{id,name,voice}], turns:[{id,act,side,text,estSec,
 //          durationMs?,emotion?,keywords?,reaction?}]}
 // durationMs 有值说明这段音频已经渲染过（或缓存命中），时间轴直接用真实长度。
 attach(script) {
  const turns = Array.isArray(script?.turns) ? script.turns : [];
  if (!turns.length) throw new Error('剧本里没有台词');
  this.script = script;
  this.scriptId = String(script.id || '');
  this.topic = String(script.topic || '');
  const declared = Array.isArray(script.sides) ? script.sides : [];
  const nameA = this.engine.config.characterName || '小澜';
  const voiceA = this.engine.config.voiceName;
  this.sides = ['A', 'B'].map(id => {
   const side = declared.find(item => item?.id === id);
   // 立场和论据要带下去：点名句的提示词需要「你是谁、代表什么」，
   // 只有名字的话，回出来就是一句谁都能说的客气话。
   return id === 'A'
    ? {id, name: side?.name || nameA, voice: side?.voice || voiceA, stance: side?.stance || '', points: side?.points || []}
    : {id, name: side?.name || this.engine.config.opponentName || this.opponentName, voice: side?.voice || this.engine.config.opponentVoice || '', stance: side?.stance || '', points: side?.points || []};
  });
  this.turns = turns.map((turn, index) => ({
   id: String(turn.id ?? index + 1),
   index,
   act: Number.isFinite(turn.act) ? turn.act : 1,
   side: turn.side === 'B' ? 'B' : 'A',
   text: String(turn.text || '').trim(),
   emotion: turn.emotion || '',
   estSec: Number(turn.estSec) > 0 ? Number(turn.estSec) : 27,
   durationMs: Number(turn.durationMs) > 0 ? Math.round(Number(turn.durationMs)) : 0,
   audio: typeof turn.audio === 'string' ? turn.audio : '',
   keywords: Array.isArray(turn.keywords) ? turn.keywords : [],
   reaction: turn.reaction !== false
  }));
  // 幕表：场控面板要按幕显示进度与「重写这一幕」。
  // 标签优先用写手给的（"交锋二 · 成本与代价"），没有就用幕号——
  // 手写 JSON 的剧本不带标签，但场控仍然需要看到「这是第几幕」。
  const declaredActs = Array.isArray(script.acts) ? script.acts : [];
  const byAct = new Map();
  for (const turn of this.turns) byAct.set(turn.act, (byAct.get(turn.act) || 0) + 1);
  this.acts = [...byAct.entries()]
   .sort((a, b) => a[0] - b[0])
   .map(([act, count]) => ({
    act,
    label: declaredActs[act - 1]?.label || `第 ${act} 幕`,
    count,
    // 冷开场与结辩不设反应位，面板上要标出来，否则场控会奇怪为什么这几幕没人接话。
    reaction: this.turns.some(turn => turn.act === act && turn.reaction !== false)
   }));

  // 反应位的时间轴跟着剧本走：同一份 turns，同一套 reaction 标记。
  this.stage.attach({turns: this.turns});
  this.cursor = 0;
  this.current = null;
  this.audioJobs.clear();
  this.voiceWaiters.clear();
  this.voiceReported.clear();
  this.receipts = [];
  // 弹幕墙（§6.5.7）：每一条进来的弹幕都要上墙，不管有没有人回它。
  // 只留「被回过的」会让墙看起来像精选留言——观众发十句全是空白，反而更冷。
  // 上限 40 条：再多前端滚动就追不上了，也把快照撑肥。
  this.wall = [];
  this.wallSeq = 0;
  this.skipTarget = null;
  this.prevEndAt = 0;
  // 新一场 = 新的配额账。上一场排着没回的点名句，答的是上一场的语境。
  this.router()?.reset();
  this.giftQueue()?.reset();
  this.stats = this.freshStats();
  return this.turns.length;
 }

 side(id) { return this.sides.find(side => side.id === id) || this.sides[0]; }
 sideVoice(id) { return this.side(id)?.voice || this.engine.config.voiceName; }

 // ── 开播 ─────────────────────────────────────────────────────────
 async start({script = null} = {}) {
  if (this.active) throw new Error('剧本正在播，先停掉当前这场');
  if (script) this.attach(script);
  if (!this.turns.length) throw new Error('请先装入剧本');
  this.active = true;
  this.paused = false;
  this.stopped = false;
  this.error = '';
  this.voiceError = '';
  this.startedAt = this.now();
  this.finishedAt = 0;
  // 预热必须发生在 begin 之前：合成前几句要花一两秒，这段时间不能算进剧本时间轴。
  await this.warm();
  if (this.stopped) { this.active=false;this.finishedAt=this.now();this.onChange();return this.view(); }
  // 零点钉在「真的开始播」这一刻，不是 attach 那一刻。
  this.stage.begin(this.now());
  this.running = this.run()
   .catch(error => { this.error = error.message; })
   .finally(() => {
     this.active = false;
     this.finishedAt = this.now();
     try { this.onEnd(this.view()); } catch {}
     this.onChange();
   });
  this.onChange();
  return this.view();
 }

 // 预热 + 预读共用一个入口：合成失败不抛，交给 prepare 在播放时按字数估时长兜底。
 async warm() {
  const jobs = [];
  const limit = Math.max(this.prewarmCount, 1);
  for (let i = 0; i < Math.min(limit, this.turns.length); i++) jobs.push(this.ensureAudio(i));
  await Promise.all(jobs);
  return jobs.length;
 }

 ensureAudio(index) {
  const turn = this.turns[index];
  if (!turn || !turn.text) return Promise.resolve(null);
  if (turn.audio) return Promise.resolve(turn);
  const existing = this.audioJobs.get(index);
  if (existing) return existing;
  const job = this.render(turn)
   .catch(error => { turn.audioError = error.message; this.voiceError = error.message; return null; })
   .finally(() => this.audioJobs.delete(index));
  this.audioJobs.set(index, job);
  return job;
 }

 // 一段文字变一条音频。反应句也走这里：L0 库焐热过就命中文件缓存（~50ms），
 // L1 现场写的要真合成一次（1.2~2 秒），正好在 3.5 秒的接话预算里。
 async render(turn) {
  const settings = {...this.engine.config, voiceName: this.sideVoice(turn.side)};
  const audio = await this.cloudVoice.render({text: turn.text, emotion: turn.emotion || 'happy'}, settings);
  const ms = Math.round(Number(audio?.durationMs) || 0);
  turn.audio = audio?.url || '';
  // 时长必须用实测：按字数估的偏差会让每一句都差一点，半小时后位置全歪。
  turn.durationMs = ms > 0 ? ms : estimateDuration(turn.text);
  turn.renderedAt = this.now();
  this.stats.rendered++;
  return turn;
 }

 // ── 主循环 ───────────────────────────────────────────────────────
 async run() {
  while (!this.stopped && this.cursor < this.turns.length) {
   // 暂停时停在这里：前面那句已经播完了，画面停在两句话之间，
   // 恢复后从下一条接着播，游标一步没动。
   await this.gate();
   if (this.stopped) break;
   const index = this.cursor;
   const turn = this.turns[index];
   await this.prepare(index);
   if (this.stopped) break;
   await this.speak(turn, {kind: 'script'});
   if (this.stopped) break;
   // 场控点了「跳幕」：这一句不再往下拖，直接落到目标幕的开头。
   // 跳过的不是「没说的话」，是「本来说了也不打算听」——所以不 retime、不记账。
   if (this.skipTarget !== null) {
    this.cursor = this.skipTarget;
    this.skipTarget = null;
    this.prevEndAt = 0;          // 跳过的部分不算空档，否则 starved 会误记
    this.stage.seek(this.cursor);
    continue;
   }
   this.cursor++;
   this.stats.turns++;
   this.stats.playedMs += turn.durationMs;
   // 实测时长回写时间轴：位置时刻跟着真实音频走，不跟着字数估算走。
   this.stage.retime(index, turn.durationMs);
   // 预读下一批。放在这里而不是发布前：发布前抢 TTS 队列，会把接话的合成堵在后面。
   this.kickLookahead(index);
   await this.gate();
   if (this.stopped) break;
   await this.beat(index);
   // 点名句不进反应位：它要「回一个人」，而反应位是「借一句话」。
   // 位置放在换幕那一刻——那里本来就是全场换气的地方，插一句不会撕节奏。
   await this.interludeSlot(index);
  }
  this.stage.pause();
  return this.view();
 }

 // 这一句的音频就绪没有。没就绪就先合成；合成失败也让它播——
 // 少一句声音是事故，停住不播是直播事故。
 async prepare(index) {
  const turn = this.turns[index];
  if (turn.audio) return turn;
  await this.ensureAudio(index);
  if (!turn.audio) {
   this.stats.voiceFailed++;
   this.error = this.error || `第 ${index + 1} 句没合成出来，已按字数估时长继续播`;
  }
  if (!turn.durationMs) turn.durationMs = estimateDuration(turn.text);
  return turn;
 }

 kickLookahead(index) {
  for (let i = index + 1; i <= index + this.lookahead && i < this.turns.length; i++) this.ensureAudio(i);
 }

 // 说一句：发布 → 等真的出声 → 写字幕 → 按实测时长占住节奏。
 // 反应句和剧本句走同一条路，区别只在于文本是提前写好的还是刚刚写出来的。
 async speak(turn, {kind = 'script'} = {}) {
  if(this.stopped||this.skipTarget!==null)return turn;
  const startedAt = this.now();
  const gap = this.prevEndAt ? Math.max(0, startedAt - this.prevEndAt) : 0;
  this.publish(turn, kind);
  const voiced = await this.raceStop(this.waitForVoice(turn.utteranceId));
  if (this.stopped) return turn;
  this.reveal(turn, kind);
  turn.startAt = this.now();
  if (this.prevEndAt) {
   turn.gapMs = Math.max(0, turn.startAt - this.prevEndAt);
   this.stats.gaps.push(turn.gapMs);
   this.stats.maxGap = Math.max(this.stats.maxGap, turn.gapMs);
   // 空档超过 1.2 秒观众就能感觉到停顿，P1 的验收线就是这条。
   if (turn.gapMs > 1200) this.stats.starved++;
  }
  turn.voiced = voiced;
  await this.raceStop(this.sleep(turn.durationMs));
  this.prevEndAt = this.now();
  turn.endAt = this.prevEndAt;
  turn.elapsedMs = turn.endAt - turn.startAt;
  this.stats.chars += turn.text.length;
  return turn;
 }

 // 反应位：每播完一句问一次「这一格接不接」。
 // 一次只接一句（max:1）——落后两格时把两句接话连着塞进去，听众听到的是自言自语。
 async beat(index) {
  const slot = this.stage.timeline[index];
  if (!slot || !slot.reaction) return null;
  const startedAt = this.now();
  const decisions = this.stage.advance(this.now(), {max: 1});
  const hit = decisions.find(item => item.kind === 'reply' || item.kind === 'ambient');
  // 气泡：这一条被听见了、但没能出声。不占时间轴，但要留回执，否则观众不知道自己被看了。
  for (const missed of decisions.filter(item => item.kind === 'bubble')) {
   this.receipt(missed.item, {kind: 'bubble', at: missed.at, side: slot.side});
  }
  if (!hit) {
   const overrun = decisions.filter(item => item.reason === 'overrun').length;
   if (overrun) this.stats.overrun += overrun;
   return null;
  }
  const turn = {
   id: `${hit.turnId}-reaction`,
   text: String(hit.text || '').trim(),
   side: hit.side || slot.side,
   emotion: 'happy',
   durationMs: 0,
   audio: '',
   reaction: true,
   layer: hit.layer || 'L1',
   audience: hit.item ? {name: hit.item.name, text: hit.item.text} : null
  };
  if (!turn.text) return null;
  this.stats.reactions++;
  if (hit.kind === 'ambient') this.stats.ambient++;
  this.receipt(hit.item, {kind: 'reply', layer: turn.layer, at: hit.at, side: turn.side, said: turn.text});
  try {
   await this.render(turn);
  } catch (error) {
   // 接话合成失败：按字数估时长把字幕走完，不占声音。整场不因此停。
   this.voiceError = error.message;
   turn.durationMs = estimateDuration(turn.text);
  }
  await this.speak(turn, {kind: 'reaction'});
  // 接话占掉的是真实的墙钟时间（含合成等待），时间轴按它校正，
  // 否则「3.5 秒的固定账」和现实差多少，下一格就错多少。
  this.stage.settle(this.now() - startedAt);
  return turn;
 }

 // ── 幕间槽：礼物 + 点名 ──────────────────────────────────────────
 // 两者共用幕边界这一个位置（§6.3 / §6.4），但**不是同一条队列**：
 // 礼物花了钱，先上；点名等了一幕，再等一幕不会有人觉得被无视——
 // 而花了钱的人在下一幕还听不到回嘴，就会觉得白花了。
 // 只在换幕那一刻开槽。最后一句之后不开——结辩说完就收尾，不再往回插话。
 async interludeSlot(index) {
  const turn = this.turns[index];
  const next = this.turns[index + 1];
  if (!turn || !next || next.act === turn.act) return null;
  const said = [];
  const gifted = await this.giftSlot(turn);
  if (gifted.length) said.push(...gifted);
  if (this.stopped) return said.length ? said : null;
  const named = await this.mentionSlot(turn);
  if (named.length) said.push(...named);
  return said.length ? said : null;
 }

 // 礼物：一个槽最多一条（两条连着说就成了一段礼物口播）。
 async giftSlot(turn) {
  const queue = this.giftQueue();
  if (!queue) return [];
  const items = queue.plan({max: 1});
  const said = [];
  for (const item of items) {
   if (this.stopped) break;
   const text = await this.slotText(item, this.giftWaitMs);
   if (!text) {
    // 礼物比点名多一层：写废了也重来。点名写废就退配额（他已经被回过一轮），
    // 礼物是花了钱的，模型写废不能算在观众账上——只要没超时就排回下一幕重写。
    queue.retry(item);
    continue;
   }
   const reply = {
    id: `${turn.id}-gift`,
    text,
    side: item.side,
    emotion: 'happy',
    durationMs: 0,
    audio: '',
    gift: true,
    audience: {name: item.name, text: item.label}
   };
   try { await this.render(reply); }
   catch (error) { this.voiceError = error.message; reply.durationMs = estimateDuration(text); }
   this.receipt({name: item.name, text: `${item.label}${item.count > 1 ? ' ×' + item.count : ''}`, userId: item.userId}, {
    kind: 'gift', side: reply.side, at: this.now(), said: text
   });
   const startedAt = this.now();
   await this.speak(reply, {kind: 'gift'});
   this.stage.shift(this.now() - startedAt);
   this.stats.gifts++;
   queue.commit(item);
   said.push(reply);
  }
  return said;
 }

 // 点名：一个槽最多 2 条（§6.3）。写不出来就 release——退了配额，这个人下一幕还能被点到；
 // 不退的话他整场就只有那一次机会，而这次机会还被模型吞了。
 async mentionSlot(turn) {
  const router = this.router();
  if (!router) return [];
  const items = router.plan({max: this.mentionSlotMax});
  const said = [];
  for (const item of items) {
   if (this.stopped) break;
   const text = await this.slotText(item, this.mentionWaitMs);
   if (!text) {
    // 两种写不出来：已经写过但没用（重排一次还是没用）和还没写好（下一幕就行）。
    // 前者释放配额，后者排回去——否则观众今晚唯一一次点名机会被模型的速度吞掉。
    if (item.settled) router.release(item); else router.requeue(item);
    continue;
   }
   const reply = {
    id: `${turn.id}-mention`,
    text,
    side: item.personaId === 'B' ? 'B' : 'A',
    emotion: 'happy',
    durationMs: 0,
    audio: '',
    mention: true,
    audience: {name: item.name, text: item.text}
   };
   try { await this.render(reply); }
   catch (error) { this.voiceError = error.message; reply.durationMs = estimateDuration(text); }
   // 回执写在开口之前：弹幕墙要在他说这句话的同时把那条钉住，
   // 等二十秒说完再钉，观众早就把「我是不是被无视了」想完了。
   this.receipt(item, {kind: 'mention', side: reply.side, at: this.now(), said: text});
   const startedAt = this.now();
   await this.speak(reply, {kind: 'mention'});
   // 点名句是插在换幕处的额外时间，整条时间轴后移。这里不能用 settle：
   // 那条是给反应位退「预记 3.5 秒」的差价，点名槽从来没有预记过。
   this.stage.shift(this.now() - startedAt);
   this.stats.mentions++;
   router.commit(item);
   said.push(reply);
  }
  return said;
 }

 // 到点取文本：入队时就已经在写了，这里通常直接拿现成的。
 // 没写好就最多等 waitMs——台上不能空着等模型，等不到就交回去排下一幕。
 // 礼物和点名共用这一段：两者都是「早就该写好的短句」，差别只在谁来写、等多久。
 async slotText(item, waitMs) {
  if (!item) return '';
  // 已经写好就直接给：这时还去建一个兜底计时器，只是白挂一次等待
  // （虚拟时钟下更明显——它会在队列里多出一个永远不会被用到的 job）。
  if (item.ready) return item.ready;
  // 按 item 的种类选写手，不能两个都试：礼物 item 没有 personaId，
  // 交给点名写手会写出一句「回观众的话」，然后被当成礼物句播出去。
  const pending = item.pending || (item.gift ? this.prefetchGift(item) : this.prefetchMention(item));
  if (!pending) return '';
  const text = await this.raceStop(Promise.race([pending, this.sleep(waitMs).then(() => '')]));
  return String(text || '').trim();
 }

 // 入队即开写。点名槽的时刻是可预测的（换幕处），所以没必要现场写；
 // 现场写要等模型四秒，那四秒台上是空的，而空档正是 P1 唯一的硬指标。
 prefetchMention(item) {
  if (!item || !this.mentionDraft) return null;
  if (item.pending) return item.pending;
  const side = this.side(item.personaId);
  const opponent = this.side(item.personaId === 'B' ? 'A' : 'B');
  // 语境用「这位辩手最近说过的一句」，不是全场最后一句：点名回的是他自己的立场，
  // 拿对手的话当语境，回出来就变成替对手说话。
  const upto = Math.max(1, Math.min(this.cursor + 1, this.turns.length));
  const last = [...this.turns.slice(0, upto)].reverse().find(turn => turn.side === item.personaId) || this.turns[this.cursor] || null;
  item.pending = Promise.resolve()
   .then(() => this.mentionDraft(item, {side, opponent, turn: last, topic: this.topic}))
   .then(text => { item.ready = String(text || '').trim(); item.settled = true; return item.ready; })
   .catch(error => { item.failed = error.message; item.ready = ''; item.settled = true; return ''; });
  return item.pending;
 }

 // 礼物句入队即开写。语境用「刚才那一轮停在对手的那句」——
 // 墨镜买的是“回嘴”，靶子必须是对手，不是自己上一句。
 prefetchGift(item) {
  if (!item || !this.giftDraft) return null;
  if (item.pending) return item.pending;
  const opponentId = item.side === 'B' ? 'A' : 'B';
  const upto = Math.max(1, Math.min(this.cursor + 1, this.turns.length));
  const opponentTurn = [...this.turns.slice(0, upto)].reverse().find(turn => turn.side === opponentId) || null;
  item.pending = Promise.resolve()
   .then(() => this.giftDraft(item, {
    side: this.side(item.side), opponent: this.side(opponentId),
    turn: opponentTurn, topic: this.topic
   }))
   .then(text => { item.ready = String(text || '').trim(); item.settled = true; return item.ready; })
   .catch(error => { item.failed = error.message; item.ready = ''; item.settled = true; return ''; });
  return item.pending;
 }

 // 一条回执：哪条弹幕、被谁、以什么方式（出声 / 气泡 / 点名 / 礼物）回了。
 // 出声的带上真正说出去的那句话，界面才能把「他说的」和「谁接的」并在一起显示。
 receipt(item, {kind, layer = '', at = 0, side = 'A', said = ''} = {}) {
  if (!item) return;
  // 弹幕墙跟着改状态：出声的（reply/mention/gift）算「已回应」并钉住，
  // 气泡算「已听见」。钉子由前端按 pinnedAt 计时，这里只留时刻。
  this.wallMark(this.wallFind(item), kind === 'bubble' ? 'heard' : 'replied', {
   side: kind === 'bubble' ? '' : side,
   said: String(said || '').slice(0, 60),
   pinnedAt: kind === 'bubble' ? 0 : at
  });
  this.receipts.push({
   id: item.userId ?? item.name ?? String(at),
   name: item.name || '观众',
   text: String(item.text || '').slice(0, 40),
   kind, layer, side,
   name2: this.side(side)?.name || '',
   said: String(said || '').slice(0, 60),
   at
  });
  if (this.receipts.length > 12) this.receipts.shift();
  try { this.onChange(); } catch {}
 }

 // ── 发布与字幕 ───────────────────────────────────────────────────
 publish(turn, kind = 'script') {
  const emotion = turn.emotion || turnEmotion({text: turn.text});
  const item = {
   id: ++this.engine.sequence,
   at: new Date(this.now()).toISOString(),
   text: turn.text,
   emotion,
   // 剧本句和接话句同优先级：接话本来就该排在它接的那一句后面，
   // 用高优先级插队会把台上正在说的话顶掉。
   priority: 2,
   // 四类条目，前端按 kind 决定画法：台词（debate）在中间主字幕，
   // 接话（reaction）/ 点名（mention）/ 礼物（gift）走旁边的浮卡——
   // 观众要知道「这句是台上说的，还是有人在跟我说话」。
   kind: kind === 'reaction' ? 'reaction' : (kind === 'mention' ? 'mention' : (kind === 'gift' ? 'gift' : 'debate')),
   voice: this.sideVoice(turn.side),
   speaker: turn.side,
   name: this.side(turn.side)?.name || ''
  };
  // 预渲染的音频直接挂在条目上：/api/speech 见到它就不进合成队列。
  // 这条是整个播放链路「零等待」的关键——没有它，每句都要过 1.2 秒的串行合成。
  if (turn.audio) {
   item.audio = turn.audio;
   item.durationMs = Math.round(turn.durationMs || 0);
  }
  this.engine.utterances.push(item);
  if (this.engine.utterances.length > 96) this.engine.utterances.shift();
  turn.utteranceId = item.id;
  turn.emotion = emotion;
  this.publishAt = this.now();
  this.current = turn;
  return item;
 }

 // 字幕、嘴型、表情都贴着「真的出声」那一刻写，不等也不早。
 reveal(turn, kind = 'script') {
  const state = this.engine.state;
  state.subtitle = turn.text;
  state.subtitleRemaining = Math.max(4, Math.round((turn.durationMs || 3000) / 1000) + 1);
  state.speakingSide = turn.side;
  state.emotion = turn.emotion || 'focus';
  state.emotionRemaining = 4;
  if (kind === 'script') state.scriptLine = {side: turn.side, text: turn.text, at: this.now()};
  turn.voiceStartedAt = this.now();
 }

 waitForVoice(id) {
  if (!this.voiceExpected()) return Promise.resolve(false);
  if (id && this.voiceReported.has(id)) return Promise.resolve(true);
  return new Promise(resolve => {
   const done = started => {
    clearTimeout(timer);
    this.voiceWaiters.delete(id);
    resolve(started);
   };
   const timer = setTimeout(() => done(false), this.waitVoiceMs);
   this.voiceWaiters.set(id, done);
  });
 }

 voiceStarted(id) {
  if (id) this.voiceReported.add(id);
  const waiter = this.voiceWaiters.get(id);
  if (waiter) {
   this.voiceWaiters.delete(id);
   waiter(true);
  }
 }

 // ── 弹幕 ─────────────────────────────────────────────────────────
 // 点名走 mention（未接线时返回 null），未点名进反应池。
 // 反应池只出短句、一次性引用，不写进剧本上下文——观众不是第三辩手。
 comment(event = {}) {
  if (!this.active) return null;
  // 先上墙：只要他发了，墙上就得有。后面判它进不进池、能不能被回，是另一回事。
  const row = this.wallPush(event);
  const router = this.router();
  if (router) {
   const routed = router.hear({...event, userId: event.userId || event.name});
   if (routed?.score === 2 && routed.queued) {
    // 入队即开写：到换幕时通常已经写好，观众听到的是「刚问就被回」。
    this.prefetchMention(routed.item);
    return {routed: 'mention', ...routed};
   }
   // 半点名（名字在句中）和「点名但配额外」都回反应池：
   // 前者是在评不是在问，后者已经被答过一次——都不能当没听见。
   if (routed?.score === 1) event = {...event, halfMention: true};
  } else if (typeof this.mention === 'function') {
   // 旧写法：外部自带路由。留着是为了不让已经接好的场控脚本一夜之间全哑。
   const named = this.mention(event);
   if (named) return {routed: 'mention', ...named};
  }
  const result = this.stage.hear({
   userId: event.userId || event.name,
   name: event.name,
   text: event.text,
   halfMention: Boolean(event.halfMention)
  });
  // 进了池就是「已听见」：细边。真正接上之后 receipt 会把它改成「已回应」。
  if (result?.ok) this.wallMark(row, 'heard');
  return {routed: 'reaction', ...result};
 }

 // ── 弹幕墙 ───────────────────────────────────────────────────────
 wallPush(event) {
  const text = String(event?.text || '').trim();
  if (!text) return null;
  const row = {
   seq: ++this.wallSeq,
   // 同一个人连发多条时，按 userId 找回来标记的总是最新那条——这正是我们要的。
   id: String(event.userId || event.name || ''),
   name: String(event.name || '观众').slice(0, 24),
   text: text.slice(0, 60),
   state: 'normal',
   side: '',
   said: '',
   at: this.now()
  };
  this.wall.push(row);
  if (this.wall.length > 40) this.wall.shift();
  return row;
 }

 wallFind(item) {
  if (!item) return null;
  const id = String(item.userId ?? item.name ?? '');
  for (let i = this.wall.length - 1; i >= 0; i--) {
   if (this.wall[i].id === id) return this.wall[i];
  }
  return null;
 }

 wallMark(row, state, extra = {}) {
  const target = row && this.wall.includes(row) ? row : null;
  if (!target) return null;
  // 「已回应」压过「已听见」：一条弹幕只能有一个最终状态，
  // 不然气泡之后再被接上，前端会按细边画一条其实出过声的弹幕。
  if (target.state === 'replied' && state === 'heard') return target;
  target.state = state;
  Object.assign(target, extra);
  return target;
 }

 router() {
  return this.mention && typeof this.mention.hear === 'function' ? this.mention : null;
 }

 giftQueue() {
  return this.gifts && typeof this.gifts.add === 'function' ? this.gifts : null;
 }

 // 礼物入口。server 把 debateGift 翻译成 {gift,count,name,side} 后交进来。
 // side 在这里算：墨镜记给「此刻说话人的对手」——出去之后台上换人了，
 // 到幕边界再算就变成「送给他自己反驳自己」。
 gift(event = {}) {
  if (!this.active) return null;
  const queue = this.giftQueue();
  if (!queue) return null;
  const current = this.turns[this.cursor] || null;
  const side = event.side || (current?.side === 'B' ? 'A' : 'B');
  const out = queue.add({
   gift: event.gift, count: event.count, name: event.name,
   userId: event.userId, giftName: event.giftName, side, at: this.now()
  });
  if (!out.queued) return {queued: false, reason: out.reason || 'neutral', count: out.count};
  // 入队即开写，与点名同一条理由：幕末现场写要等四五秒，那几秒台上是空的。
  for (const item of out.items) this.prefetchGift(item);
  this.onChange();
  return {queued: true, count: out.count, lines: out.lines, side};
 }

 // ── 场控动作：跳幕、重写未播的幕 ─────────────────────────────────
 // 跳到下一幕的开头。最后一句没有「下一幕」——那就直接收尾，
 // 场控按下去的意思就是「这场别说了」。
 skip() {
  if (!this.active) return {skipped: false, reason: 'idle'};
  const act = this.turns[this.cursor]?.act ?? 0;
  let index = this.turns.findIndex((turn, position) => position > this.cursor && turn.act !== act);
  if (index < 0) index = this.turns.length;
  this.skipTarget = index;
  // 唤醒正在等的那一句，让它立刻收尾。不等它自然说完，跳幕就没有意义。
  for (const done of [...this.stopWaiters]) done();
  return {skipped: true, from: this.cursor, to: index, act: index < this.turns.length ? this.turns[index].act : null};
 }

 // 重写某一幕。只允许还没开始的幕——正在播的那一幕，换了台词会和画面打架，
 // 已经播过的那一幕，换了也来不及。
 // rows 是 [{side,text,emotion?}]，句数可以变；id 与 estSec 在这里补。
 replaceAct(actId, rows) {
  const id = Number(actId);
  if (!Number.isFinite(id)) return {ok: false, reason: 'bad-act'};
  const current = this.turns[this.cursor] || null;
  if (!current) return {ok: false, reason: 'not-playing'};
  if (id <= (current.act ?? 0)) return {ok: false, reason: 'already-started'};
  const list = (Array.isArray(rows) ? rows : [])
   .map((row, position) => ({
    id: `${id}-r${position + 1}`,
    act: id,
    side: row?.side === 'B' ? 'B' : 'A',
    text: String(row?.text || '').trim(),
    emotion: row?.emotion || '',
    estSec: Number(row?.estSec) > 0 ? Number(row.estSec) : Math.max(6, Math.round(String(row?.text || '').length / 4.9)),
    durationMs: 0,
    audio: '',
    keywords: [],
    // 新写的句子按「该幕原来是否设槽」来：冷开场与结辩本来就不开槽，重写不该改变这条。
    reaction: this.turns.some(turn => turn.act === id && turn.reaction === false) ? false : true
   }))
   .filter(row => row.text);
  if (!list.length) return {ok: false, reason: 'empty'};
  const exists = this.turns.some(turn => turn.act === id);
  const next = [];
  let placed = false;
  for (const turn of this.turns) {
   if (turn.act === id) {
    if (!placed) { next.push(...list); placed = true; }
    continue;
   }
   next.push(turn);
  }
  if (!placed) next.push(...list);
  if (!exists) next.sort((a, b) => a.act - b.act);
  const keepId = current.id;
  this.turns = next.map((turn, position) => ({...turn, index: position}));
  this.stage.rebuild(this.turns, {turnId: keepId});
  // 句子变了，之前排队合成的音频全部作废：留着会播到「上一版」的台词。
  this.audioJobs.clear();
  this.voiceWaiters.clear();
  this.stats.rewrites = (this.stats.rewrites || 0) + 1;
  return {ok: true, act: id, count: list.length, replaced: exists};
 }

 // ── 暂停 / 停止 ──────────────────────────────────────────────────
 pause() {
  if (!this.active || this.paused) return false;
  this.paused = true;
  this.stats.pausedAt = this.now();
  this.stage.pause();
  this.onChange();
  return true;
 }

 resume() {
  if (!this.active || !this.paused) return {flushed: 0, pausedMs: 0};
  const pausedMs = Math.max(0, this.now() - (this.stats.pausedAt || this.now()));
  this.stats.pausedMs += pausedMs;
  this.paused = false;
  // 池里的弹幕说的是三分钟前的画面，全部倒掉；时间轴整条后移，位置不会「补播」。
  const result = this.stage.resume();
  // 排着没回的点名句同样作废：观众问的是三分钟前那个画面，现在答就是答非所问。
  this.router()?.flush();
  for (const done of this.gateWaiters.splice(0)) done();
  this.onChange();
  return {...result, pausedMs};
 }

 stop() {
  const wasActive = this.active;
  this.stopped = true;
  for (const done of [...this.stopWaiters]) done();
  this.stopWaiters.clear();
  for (const done of this.gateWaiters.splice(0)) done();
  if (wasActive) this.onChange();
  return wasActive;
 }

 // 可中断的等待：正常播完，或者场控喊停，谁先到都算这一句结束。
 // 值要透传：点名槽靠它拿回写好的那句话——第一版这里 resolve() 不带参数，
 // 于是「等到了文本」和「被停掉」在调用方看来一模一样，点名句永远写不出来。
 raceStop(pending) {
  return new Promise(resolve => {
   let settled = false;
   const done = value => {
    if (settled) return;
    settled = true;
    this.stopWaiters.delete(done);
    resolve(value);
   };
   this.stopWaiters.add(done);
   Promise.resolve(pending).then(value => done(value), () => done());
  });
 }

 gate() {
  if (!this.paused) return Promise.resolve();
  return new Promise(resolve => this.gateWaiters.push(resolve));
 }

 // ── 快照 ─────────────────────────────────────────────────────────
 summary() {
  const average = list => list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : 0;
  const ready = this.turns.filter(turn => turn.audio).length;
  return {
   turns: this.stats.turns, chars: this.stats.chars,
   playedMs: this.stats.playedMs,
   audioReady: ready, audioTotal: this.turns.length,
   rendered: this.stats.rendered, voiceFailed: this.stats.voiceFailed,
   gapMs: average(this.stats.gaps), maxGap: this.stats.maxGap, starved: this.stats.starved,
   reactions: this.stats.reactions, ambient: this.stats.ambient,
   overrun: this.stats.overrun, pausedMs: this.stats.pausedMs,
   // 节奏判定：P1 的验收线是「单句空档 < 1.2 秒、冷场 0 次」。
   rhythm: this.stats.maxGap > 1200 || this.stats.starved > 0 ? 'gap' : 'ok'
  };
 }

 view() {
  const reaction = this.stage.snapshot();
  const turn = this.current;
  return {
   active: this.active,
   mode: 'script',
   scriptId: this.scriptId,
   topic: this.topic,
   phase: this.active ? 'playing' : (this.finishedAt ? 'ended' : 'idle'),
   index: this.cursor,
   total: this.turns.length,
   paused: this.paused || !this.active,
   elapsedMs: this.startedAt ? Math.max(0, (this.finishedAt || this.now()) - this.startedAt) : 0,
   scriptMs: reaction.scriptMs,
   playedMs: reaction.playedMs,
   slipMs: reaction.slipMs,
   current: turn ? {id: turn.id, side: turn.side, name: this.side(turn.side)?.name || '', text: turn.text, at: turn.startAt || 0} : null,
   reaction: {
    pool: reaction.pool, cursor: reaction.cursor, slots: reaction.slots,
    stats: reaction.stats
   },
   receipts: this.receipts,
  wall: this.wall,
  acts: this.acts.map(row => ({
   ...row,
   state: row.act < (this.turns[this.cursor]?.act ?? 0) ? 'done'
    : row.act === (this.turns[this.cursor]?.act ?? 0) ? 'now' : 'next'
  })),
   mention: this.router()?.snapshot() || null,
  gifts: this.giftQueue()?.snapshot() || null,
   error: this.error,
   voiceError: this.voiceError,
   stats: this.summary()
  };
 }
}

export default ScriptRunner;
