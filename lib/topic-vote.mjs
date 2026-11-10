// 候选题投票：一人一票、可改票、平票加时、整条才算。
//
// 这个模块只管「数票」，不管「什么时候开票」——那是 debate-cycle 的事。
// 分开放的理由很实际：投票是整场里唯一一处「观众输入直接改变节目走向」的地方，
// 每个错判样本都得能单独测到，不能埋在状态机里靠回放才发现。
//
// 判据一律「宁可漏判，不可错判」：观众投错一票只是不算，误判一票却会改掉节目。
// 所以只认整条消息，不做「这句话里好像有个 2」这种猜测。

export const VOTE_LIMITS = Object.freeze({
  // 投票窗口。min 之前不锁（否则先投的人定胜负），max 到点强制锁。
  minMs: 20000,
  maxMs: 30000,
  // 最短窗口后，领先者连续 5 秒未变即可锁票。
  stableMs: 5000,
  // 空票等满最短窗口即轮转，不再额外等待。
  emptyGraceMs: 0,
  // 默认平票直接裁决；调用方仍可显式配置加时。
  tieMs: 0
});

// 序号词。中文数字一起收，因为弹幕里「投三号」比「投3号」更常见。
const INDEX_MAP = Object.freeze({
  '1': 1, '2': 2, '3': 3, '4': 4,
  a: 1, b: 2, c: 3, d: 4,
  '一': 1, '二': 2, '两': 2, '三': 3, '四': 4
});

// 可以出现在序号周围的修饰词：我/要/想/就/投/选/第/个/号/题/项。
// 只在这些词被剥掉后剩下一个字符时才当序号用，避免「我觉得3」这种被误判。
const FILLER = /[我你要就想投选第个号题项]/gu;

export function normalizeVoteText(text) {
  return String(text ?? '')
    // 全角转半角：弹幕输入法出来的「１」「Ａ」很常见
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s，。！？、,.!?~～…:：;；"'“”‘’（）()【】[\]]/gu, '')
    .toLowerCase();
}

// 序号：整条消息（去掉修饰词）就是一个 1~4 / A~D / 一二三四。
// 越界一律判废：候选只有 3 题时投 4，不能悄悄算成第 3 题。
export function parseTopicIndex(value, count) {
  if (!value) return 0;
  const stripped = value.replace(FILLER, '');
  const token = stripped.length <= 1 ? stripped : value;
  const hit = INDEX_MAP[token] || 0;
  return hit && hit <= count ? hit : 0;
}

// 关键词：整条消息恰好是某一题的片段（≥4 字且唯一命中）。
// 门槛定 4 字不是洁癖：「摸鱼」两个字太容易出现在「今天摸鱼被逮了」这种闲聊里。
export function parseTopicKeyword(value, candidates = []) {
  if (value.length < 4 || value.length > 12) return null;
  const hits = candidates.filter(item => normalizeVoteText(item.topic || '').includes(value));
  return hits.length === 1 ? hits[0].id : null;
}

// 投票人身份。平台给了 userId 就用它；没有就退化成昵称，并标记 weak——
// 昵称会重名，靠它去重是在赌，日志里必须留痕，不然「怎么有人投了两票」查不出来。
export function ballotKey(ballot = {}) {
  const userId = String(ballot.userId ?? '').trim();
  if (userId) return {key: `u:${userId}`, weak: false};
  const name = String(ballot.name ?? '').trim();
  if (!name) return {key: '', weak: true};
  return {key: `n:${name}`, weak: true};
}

export class TopicVote {
  constructor({now = Date.now, log = () => {}, limits = {}} = {}) {
    this.now = now;
    this.log = log;
    this.limits = {...VOTE_LIMITS, ...limits};
    this.reset();
  }

  reset() {
    this.candidates = [];
    this.ballots = new Map();
    this.openedAt = 0;
    this.closesAt = 0;
    this.closed = false;
    this.closedAt = 0;
    this.result = null;
    this.leaderSince = 0;
    this.leaderId = null;
    this.tieOnly = null;   // 加时阶段：只允许并列题
    this.extended = 0;
    this.deferredMs = 0;
    this.lockNotBefore = 0;
    this.stats = {cast: 0, changed: 0, rejected: 0, unparsed: 0, weak: 0, extended: 0};
  }

  // candidates: [{id, topic, ...}]，一般 4 个。开票时把整份候选钉住：
  // 加时和锁票都按这一份算，中途题库换题不会影响正在数的票。
  open({candidates = [], at = this.now(), minMs, maxMs} = {}) {
    this.reset();
    this.candidates = candidates.map(item => ({...item}));
    this.openedAt = at;
    this.limits = {...this.limits, ...(minMs ? {minMs} : {}), ...(maxMs ? {maxMs} : {})};
    this.closesAt = at + this.limits.maxMs;
    this.log(`开票：${this.candidates.length} 个候选，${Math.round(this.limits.maxMs / 1000)} 秒窗口；可同时聊天`);
    return this.view();
  }

  // 投一票。返回 {ok, topicId, changed, reason}——reason 是给日志用的，
  // 不返回给观众（观众不该看到「你的票被判废了」这种话）。
  cast({userId, name, text} = {}) {
    if (this.closed) return this.reject('closed');
    if (!this.candidates.length) return this.reject('not-open');
    const {key, weak} = ballotKey({userId, name});
    if (!key) return this.reject('anonymous');

    const value = normalizeVoteText(text);
    let topicId = null;
    const index = parseTopicIndex(value, this.candidates.length);
    if (index) topicId = this.candidates[index - 1].id;
    else topicId = parseTopicKeyword(value, this.candidates);
    if (!topicId) {
      this.stats.unparsed++;
      return {ok: false, reason: 'unparsed'};
    }
    // 加时阶段只允许投并列题；投别的先不算，但不判废——观众可能只是没看懂提示。
    if (this.tieOnly && !this.tieOnly.has(topicId)) return this.reject('tie-only');

    const before = this.ballots.get(key);
    const at = this.now();
    this.ballots.set(key, {topicId, name: String(name || '').trim() || '观众', weak, at});
    this.stats.cast++;
    if (weak) this.stats.weak++;
    if (before && before.topicId !== topicId) this.stats.changed++;
    this.settleLeader(at, before?.topicId || null);
    return {ok: true, topicId, changed: Boolean(before && before.topicId !== topicId)};
  }

  reject(reason) {
    this.stats.rejected++;
    return {ok: false, reason};
  }

  // 领先者变了就重置计时。这里有个容易忽略的点：从「并列」变成「独领先」也算变，
  // 否则平票僵持 90 秒后一票打破，会立刻被判「稳定」而提前锁票。
  settleLeader(at, beforeTopicId) {
    const top = this.topIds();
    const leader = top.length === 1 ? top[0] : null;
    if (leader !== this.leaderId || (leader && beforeTopicId !== leader)) {
      this.leaderId = leader;
      this.leaderSince = leader ? at : 0;
    }
  }

  counts() {
    const map = new Map(this.candidates.map(item => [item.id, 0]));
    for (const ballot of this.ballots.values()) {
      if (this.tieOnly && !this.tieOnly.has(ballot.topicId)) continue;
      map.set(ballot.topicId, (map.get(ballot.topicId) || 0) + 1);
    }
    return map;
  }

  tally() {
    const map = this.counts();
    const total = [...map.values()].reduce((sum, value) => sum + value, 0);
    return this.candidates
      .map((item, position) => ({
        // index 是**投「1」时对应哪一题**的那个序号，必须跟着原始顺序走。
        // 看板如果按票数重排还照抄位置当序号，标着 1 的题会被投给 2 号——
        // 这种错只在票数变化的那一刻出现，最难查。
        index: position + 1,
        id: item.id, topic: item.topic, count: map.get(item.id) || 0,
        share: total ? Number(((map.get(item.id) || 0) / total).toFixed(3)) : 0
      }))
      .sort((a, b) => b.count - a.count);
  }

  topIds() {
    const rows = this.tally();
    const top = rows[0]?.count || 0;
    if (!top) return [];
    return rows.filter(row => row.count === top).map(row => row.id);
  }

  total() {
    return [...this.counts().values()].reduce((sum, value) => sum + value, 0);
  }

  remainingMs(at = this.now()) {
    return Math.max(0, this.closesAt - at);
  }

  // 何时可以锁票：过了最短窗口，并且（领先者稳住 90 秒 或 到截止时间）。
  // 这条规则替代了「等满 12 分钟」——观众散场后剩下的时间只是空转。
  // 加时阶段不看最短窗口（早就过了），只看加时截止或新一轮的稳定。
  canLock(at = this.now()) {
    if (this.closed || !this.openedAt) return false;
    if(at<this.lockNotBefore)return false;
    const elapsed = at - this.openedAt;
    if (!this.extended && elapsed < this.limits.minMs) return false;
    if (at >= this.closesAt) return true;
    if (!this.total()) return elapsed >= this.limits.minMs + this.limits.emptyGraceMs;
    return Boolean(this.leaderSince) && at - this.leaderSince >= this.limits.stableMs;
  }

  // 锁票。返回 {topicId, by, ties}：
  //   by: 'vote' 投出来了 | 'tie' 平票待裁决 | 'empty' 一票都没有 | 'host' 场控指定
  lock({topicId = '', at = this.now()} = {}) {
    if (this.closed) return this.result;
    this.closed = true;
    this.closedAt = at;
    if (topicId && this.candidates.some(item => item.id === topicId)) {
      this.result = {topicId, by: 'host', ties: []};
    } else {
      const top = this.topIds();
      if (top.length > 1) this.result = {topicId: null, by: 'tie', ties: top};
      else if (top.length === 1) this.result = {topicId: top[0], by: 'vote', ties: []};
      else this.result = {topicId: null, by: 'empty', ties: []};
    }
    this.result.ballots = this.total();
    this.result.at = at;
    this.log(`锁票：${this.result.by}${this.result.topicId ? ` → ${this.result.topicId}` : ''}（${this.result.ballots} 票）`);
    return this.result;
  }

  // 平票加时：重开 60 秒，只认并列的那几题。
  // 加时不是「再投一轮所有题」——那等于把已经出局的题又拉回来，先投的人白投了。
  //
  // 平票是「锁票的时候才发现的」，所以这里允许从已锁状态重开：
  // 先 lock → 发现 tie → extend 重开 → 再 lock。让调用方自己去翻 closed 标志，
  // 迟早会有人在别处忘掉一句，于是「加时投的票没算进去」。
  extend({at = this.now(), ms} = {}) {
    if (this.closed && this.result?.by !== 'tie') return {ok: false, reason: 'closed'};
    if (this.closed) { this.closed = false; this.closedAt = 0; this.result = null; }
    const top = this.topIds();
    if (top.length < 2) return {ok: false, reason: 'no-tie'};
    if (this.extended >= 1) return {ok: false, reason: 'extended'};
    this.tieOnly = new Set(top);
    this.extended++;
    this.stats.extended++;
    this.closesAt = Math.max(this.closesAt, at + (ms ?? this.limits.tieMs));
    this.leaderSince = 0;
    this.leaderId = null;
    this.log(`平票加时：只允许投 ${top.join(' / ')}`);
    return {ok: true, ties: top, closesAt: this.closesAt};
  }

  defer({ms=15000,at=this.now()}={}){
    if(this.closed||!this.openedAt)return {ok:false,reason:'closed'};
    if(!Number.isFinite(ms)||ms<=0||this.deferredMs+ms>60000)return {ok:false,reason:'limit'};
    this.deferredMs+=ms;
    this.closesAt=Math.max(this.closesAt,at)+ms;
    this.lockNotBefore=this.closesAt;
    this.log(`场控延长聊天 ${Math.round(ms/1000)} 秒，已有选题票保留`);
    return {ok:true,closesAt:this.closesAt};
  }

  // 平票裁决。doc §5.6：场控点选，或者「鱼裁决」（角色口播宣布随机结果，
  // 包装成节目效果）。两种都记 by，事后能分清是人为还是随机。
  resolveTie({by = 'host', topicId = '', rng = Math.random} = {}) {
    if (!this.closed || this.result?.by !== 'tie') return this.result;
    const ties = this.result.ties;
    let picked = '';
    if (by === 'host') picked = ties.includes(topicId) ? topicId : '';
    else picked = ties[Math.floor(rng() * ties.length)] || '';
    if (!picked) return this.result;
    this.result = {...this.result, topicId: picked, by: `tie-${by}`};
    this.log(`平票裁决（${by}）：${picked}`);
    return this.result;
  }

  view(at = this.now()) {
    return {
      open: Boolean(this.openedAt) && !this.closed,
      closed: this.closed,
      openedAt: this.openedAt,
      closesAt: this.closesAt,
      remainingMs: this.remainingMs(at),
      total: this.total(),
      weak: this.stats.weak,
      tieOnly: this.tieOnly ? [...this.tieOnly] : [],
      extended: this.extended,
      leader: this.leaderId,
      ties: this.closed ? [] : this.topIds(),
      candidates: this.tally(),
      result: this.result,
      stats: {...this.stats}
    };
  }
}

export default TopicVote;
