// 场次循环：正赛 → 结果卡 → 投票 → 锁票 → 就绪 → 下一场。
//
// 这个模块不写台词、不合成音频、不碰 HTTP。它只做一件事：**在什么时刻该做什么**，
// 以及「该做的事没做成的时候退到哪一步」。所有重活都从构造函数注入，
// 这样整条链路能用虚拟时钟在 1 秒里跑完，不必真等 40 分钟。
//
// 三个结构决定值得先说清：
// 1. 生产前移到正赛期（§5.1）。预热在正赛 +2:00 启动，投票期是纯玩，
//    所以锁票即开播，不需要「领先者预测 / 易主重跑 / 延长投票」那一套。
// 2. 投票只决定「播哪一份」，不触发生成。四份稿都在手上，任何一份出问题都能换一份上。
// 3. 只有通过完整性与时长检查的 ready 剧本才允许开播。

import {TopicVote} from './topic-vote.mjs';

export const CYCLE_PHASES = Object.freeze(['idle', 'match', 'result', 'vote', 'write', 'ready']);

export const CYCLE_DEFAULTS = Object.freeze({
  resultMs: 90 * 1000,          // 结果卡 1:30
  voteMinMs: 6 * 60 * 1000,     // 投票窗口（TopicVote 自己管最短/最长，这里留给状态机查进度）
  voteMaxMs: 12 * 60 * 1000,
  readyMs: 60 * 1000,           // 口播预告后的开场倒计时
  prewarmDelayMs: 2 * 60 * 1000,// 正赛 +2:00 才预热：开场那两分钟前端还在取音频，合成会拖慢起播
  concurrency: 2,               // 网关同时压三个 3000 token 请求会断连（见 writer 的注释）
  candidates: 4,
  tickMs: 3 * 1000,             // 投票期轮询间隔
  tieExtraMs: 60 * 1000,
  historyMax: 12                // 「最近播过」只留 12 题，避免一整晚只有一个题轮回
});

export class DebateCycle {
  constructor({
    vote = null, bank = [], pickCandidates = null,
    prepare, play, announce = async () => {},
    onPhase = () => {}, onChange = () => {}, now = Date.now, sleep,
    log = () => {}, rng = Math.random, limits = {}
  } = {}) {
    if (typeof prepare !== 'function') throw new Error('场次循环需要 prepare（写稿 + 合成）');
    if (typeof play !== 'function') throw new Error('场次循环需要 play（播放一场）');
    this.vote = vote || new TopicVote({now, log});
    this.bank = bank;
    this.pickCandidatesFn = pickCandidates;
    this.prepare = prepare;
    this.play = play;
    this.announce = announce;
    this.onPhase = onPhase;
    this.onChange = onChange;
    this.now = now;
    this.waiters = new Set();
    this.sleep = sleep || (ms => new Promise(resolve => {
      let timer; const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      this.waiters.add(done);
      timer = setTimeout(done, ms);
    }));
    this.log = log;
    this.rng = rng;
    this.limits = {...CYCLE_DEFAULTS, ...limits};

    this.phase = 'idle';
    this.running = false;
    this.round = 0;
    this.current = null;      // 正在播的那份 {topic, script, ready}
    this.scripts = new Map();  // topicId → {topic, script, ready, error}
    this.candidates = [];      // 本场在投的 4 个候选
    this.history = [];         // 已播题 id
    this.events = [];          // 阶段流水，给场控面板和测试看
    this.prewarming = null;
    this.stats = {matches: 0, votes: 0, writes: 0, swaps: 0, aborted: 0, prepareFailed: 0, emptyVotes: 0, ties: 0};
  }

  // ── 阶段 ──────────────────────────────────────────────────────────────
  setPhase(phase, info = {}) {
    if (!CYCLE_PHASES.includes(phase)) throw new Error(`未知阶段 ${phase}`);
    this.phase = phase;
    const event = {phase, at: this.now(), round: this.round, ...info};
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
    try { this.onPhase(event); } catch {}
    try { this.onChange(); } catch {}
    return event;
  }

  stop() {
    if (!this.running) return false;
    this.running = false;
    for (const done of [...this.waiters]) done();
    this.setPhase('idle', {reason: 'stopped'});
    return true;
  }

  // ── 主循环 ────────────────────────────────────────────────────────────
  // first: 第一场的题（§2.2：第一场没有上一场，不投票，场控选题或题库轮转）
  async run({first = null, rounds = Infinity} = {}) {
    if (this.running) throw new Error('已经在跑了');
    this.running = true;
    this.round = 0;
    try {
    let topic = first || this.pickOne();
    if (!topic) throw new Error('题库是空的');

    while (this.running && this.round < rounds) {
      this.round++;
      // 1. 正赛：可能要现场写（第一场），也可能直接拿预写的稿
      const entry = await this.openMatch(topic);
      if (!entry) break;
      // 下一场的 4 个候选现在就该定下来：预热要用，投票时也只认这一份
      this.candidates = this.round < rounds ? this.pickCandidates({avoid: [...this.history, topic.id]}) : [];
      this.prewarming = this.prewarm(this.candidates).catch(error => {
        this.log(`预热中断：${error.message}`);
        return null;
      });

      await this.playMatch(entry);
      if (!this.running) break;

      // 2. 结果卡：让观众看一眼票型再切画面
      this.setPhase('result', {topicId: entry.topic.id});
      await this.sleep(this.limits.resultMs);
      if (!this.running) break;
      // 限轮次（试跑、单场彩排）就到此为止：这一场已经播完了，
      // 再开一次投票等于让观众投一个不会播的题。
      if (this.round >= rounds) break;

      // 3. 投票期：纯玩，后台什么都不用做（稿子早写完了）
      const winner = await this.voteStage();
      if (!this.running) break;

      // 4. 就绪：口播预告 → 倒计时 → 开打
      if (!winner) break;
      const next = await this.readyStage(winner);
      if (!next) break;
      topic = next.topic;
    }

    // 收尾时把还在写的预热等干净：调用方拿到 idle 时应该是一份完整的账，
    // 而不是「后台还有四个写手在跑」。停播时这里也几乎立刻返回——
    // 预热循环每轮都会检查 running。
    if (this.prewarming) { try { await this.prewarming; } catch {} this.prewarming = null; }
    } finally {
      this.running = false;
      for (const done of [...this.waiters]) done();
      this.setPhase('idle', {reason: 'ended'});
    }
    return this.view();
  }

  // ── 正赛 ──────────────────────────────────────────────────────────────
  async openMatch(topic) {
    const entry = await this.ensureScript(topic);
    if (!this.running) return null;
    if (!entry) {
      // 四份全崩：这一层不兜底。往上还有「预置剧本库」和「回退现编」两级，
      // 那些属于播放器的选择，不是循环的判断——循环只用把话说清楚。
      this.stats.aborted++;
      this.log(`没有可播的稿（${topic?.id}），停止循环`);
      this.stop();
      return null;
    }
    this.current = entry;
    this.history.push(entry.topic.id);
    if (this.history.length > this.limits.historyMax) this.history.shift();
    this.stats.matches++;
    this.setPhase('match', {topicId: entry.topic.id, topic: entry.topic.topic, ready: entry.ready});
    return entry;
  }

  async playMatch(entry) {
    const startedAt = this.now();
    try {
      await this.play(entry.script, {topic: entry.topic, cycle: this});
    } catch (error) {
      // 播放器抛错不该让整晚结束：这一场当成「提前结束」，进结果卡接着走。
      // 上一版在这里直接 return，结果是一场音频出问题就整晚停了。
      this.log(`播放异常（${entry.topic.id}）：${error.message}`);
    }
    return this.now() - startedAt;
  }

  // 拿一份能播的稿。顺序就是 §5.5 的降级链：
  // 预写好的 → 现场补写 → 换一份已就绪的 → 交回上层兜底。
  async ensureScript(topic) {
    const cached = this.scripts.get(topic?.id);
    if (cached?.ready && cached.script) return cached;

    this.setPhase('write', {topicId: topic?.id, reason: cached ? 'not-ready' : 'missing'});
    this.stats.writes++;
    const written = await this.prepareNow(topic);
    if (written?.ready && written.script) return written;

    const spare = [...this.scripts.values()].find(item => item.ready && item.script && item.topic.id !== topic?.id);
    if (spare) {
      // 「播另一份」是剧本模式独有的后手：四份稿都在手上，断不了播。
      // 代价只是观众选的题晚一场上，这句话本身还能当节目效果。
      this.stats.swaps++;
      this.log(`冠军稿不可用，改播已就绪的 ${spare.topic.id}`);
      this.events.push({phase: 'swap', at: this.now(), round: this.round, from: topic?.id, to: spare.topic.id});
      return spare;
    }
    return null;
  }

  async prepareNow(topic) {
    if (!topic?.id) return null;
    try {
      const out = await this.prepare(topic, {deadline: this.now() + this.limits.voteMaxMs});
      const entry = {
        topic,
        script: out?.script || null,
        ready: Boolean(out?.ready && out?.script),
        error: out?.error || null
      };
      this.scripts.set(topic.id, entry);
      if (!entry.ready) this.stats.prepareFailed++;
      return entry;
    } catch (error) {
      this.stats.prepareFailed++;
      this.log(`写稿失败（${topic.id}）：${error.message}`);
      return null;
    }
  }

  // 预热：正赛 +2:00 起，按并发压 4 题。
  // 这里不排「先两题再两题」的精细时刻表——那是 writer 内部按幕分块的事；
  // 循环只需要保证「投票结束前四份都落位」。
  async prewarm(candidates) {
    if (!candidates.length) return null;
    await this.sleep(this.limits.prewarmDelayMs);
    const queue = [...candidates];
    const worker = async () => {
      while (queue.length && this.running) {
        const topic = queue.shift();
        if (this.scripts.get(topic.id)?.ready) continue;
        await this.prepareNow(topic);
      }
    };
    const workers = Array.from({length: Math.max(1, this.limits.concurrency)}, worker);
    await Promise.all(workers);
    this.events.push({phase: 'prewarm-done', at: this.now(), round: this.round, ready: [...this.scripts.values()].filter(item => item.ready).length});
    return [...this.scripts.values()];
  }

  // ── 投票期 ────────────────────────────────────────────────────────────
  async voteStage() {
    this.stats.votes++;
    // 先开票再切阶段：阶段事件是给场控和前端「可以投票了」的信号，
    // 信号发出时票箱还没开，抢在第一个 tick 之前投的票会被判 not-open。
    this.vote.open({
      candidates: this.candidates, at: this.now(),
      minMs: this.limits.voteMinMs, maxMs: this.limits.voteMaxMs
    });
    this.setPhase('vote', {candidates: this.candidates.map(item => item.id)});

    // 轮询到「该锁了」。用轮询而不是定时器，是因为稳定判定依赖票型而不是墙钟。
    while (this.running && !this.vote.closed && !this.vote.canLock(this.now())) {
      await this.sleep(this.limits.tickMs);
    }
    if (!this.running) return null;

    // 锁票前把预热收干净。投票期不生产，所以这里等的不是「写不写得完」，
    // 而是「别让冠军稿写到一半就开播」——它早在正赛期就该写完了。
    if (this.prewarming) {
      await this.prewarming;
      this.prewarming = null;
    }

    let result = this.vote.lock({at: this.now()});
    if (result.by === 'tie') {
      this.stats.ties++;
      // 加时一次；再平就交给「鱼裁决」（随机），包装成节目效果。
      // 场控也可以随时用 resolveTie({by:'host'}) 顶掉，这里不用为它留分支。
      const extended = this.vote.extend({at: this.now(), ms: this.limits.tieExtraMs});
      if (extended.ok) {
        while (this.running && !this.vote.closed && !this.vote.canLock(this.now())) await this.sleep(this.limits.tickMs);
        result = this.vote.lock({at: this.now()});
      }
      if (result.by === 'tie') result = this.vote.resolveTie({by: 'random', rng: this.rng});
    }

    if (!result.topicId) {
      // 零票：不能卡住整晚。题库轮转一个没播过的题，日志里记下是轮转出来的。
      this.stats.emptyVotes++;
      const fallback = this.candidates.find(item => !this.history.includes(item.id)) || this.candidates[0] || this.pickOne();
      if (!fallback) return null;
      result = {...result, topicId: fallback.id, by: 'rotation'};
      this.log(`零票，按题库轮转播 ${fallback.id}`);
    }
    return result;
  }

  async readyStage(result) {
    if (!result || !this.running) return null;
    const topic = this.candidates.find(item => item.id === result.topicId) || this.topicsById(result.topicId);
    if (!topic) return null;
    const entry = await this.ensureScript(topic);
    if (!this.running) return null;
    if (!entry) {
      this.stats.aborted++;
      this.stop();
      return null;
    }
    this.setPhase('ready', {topicId: entry.topic.id, by: result.by});
    // 预告必须在下一场重置播放队列之前播完。
    try {
      await this.announce(entry.script, {topic: entry.topic, by: result.by});
    } catch (error) {
      this.log(`预告口播失败：${error.message}`);
    }
    await this.sleep(this.limits.readyMs);
    return entry;
  }

  // ── 选材 ──────────────────────────────────────────────────────────────
  pickCandidates({avoid = [], n = this.limits.candidates} = {}) {
    if (typeof this.pickCandidatesFn === 'function') return this.pickCandidatesFn({avoid, n, bank: this.bank});
    const bank = Array.isArray(this.bank) ? this.bank : [];
    const pool = bank.filter(item => !avoid.includes(item.id));
    // A small bank must recycle older topics instead of exhausting the show.
    if (pool.length < n) {
      const recent = [...this.history];
      const recycled = bank.filter(item => !pool.includes(item) && (bank.length === 1 || item.id !== this.current?.topic.id))
        .sort((a,b) => recent.indexOf(a.id) - recent.indexOf(b.id));
      pool.push(...recycled.slice(0, n - pool.length));
    }
    const picked = [];
    const rest = [...pool];
    while (picked.length < n && rest.length) {
      const index = Math.floor(this.rng() * rest.length);
      picked.push(rest.splice(index, 1)[0]);
    }
    // 题不够时允许重复填满候选格：投票界面 4 个格子比 2 个更像投票。
    // 但都不重复优先——重复选项会让观众以为界面出错了。
    return picked;
  }

  pickOne({avoid = this.history} = {}) {
    if (typeof this.pickCandidatesFn === 'function') {
      return this.pickCandidatesFn({avoid, n: 1, bank: this.bank})[0] || null;
    }
    return this.pickCandidates({avoid, n: 1})[0] || null;
  }

  topicsById(id) {
    return (Array.isArray(this.bank) ? this.bank : []).find(item => item.id === id) || null;
  }

  // ── 快照 ──────────────────────────────────────────────────────────────
  view() {
    return {
      phase: this.phase,
      running: this.running,
      round: this.round,
      topic: this.current ? {id: this.current.topic.id, topic: this.current.topic.topic} : null,
      candidates: this.candidates.map(item => item.id),
      scripts: [...this.scripts.entries()].map(([id, item]) => ({id, ready: item.ready, error: item.error})),
      history: [...this.history],
      stats: {...this.stats},
      vote: this.vote.view(),
      events: this.events.slice(-20)
    };
  }
}

export default DebateCycle;
