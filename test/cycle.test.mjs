import test from 'node:test';
import assert from 'node:assert/strict';
import {DebateCycle, CYCLE_DEFAULTS} from '../lib/debate-cycle.mjs';
import {TopicVote} from '../lib/topic-vote.mjs';

const BASE = 1_700_000_000_000;
const BANK = [
  {id: 'slack', topic: '上班摸鱼，到底算不算一种本事'},
  {id: 'overtime', topic: '加班到深夜的人，多半是在演'},
  {id: 'pie', topic: '老板画的饼，该不该当真'},
  {id: 'meeting', topic: '开会两小时，有效内容十分钟'},
  {id: 'friday', topic: '周五下午的活，该留到周一吗'},
  {id: 'dress', topic: '上班穿什么，公司该不该管'},
  {id: 'sidehustle', topic: '下班搞副业，算不算不忠'},
  {id: 'polish', topic: '把活干漂亮，比把话说漂亮更重要吗'}
];

// 虚拟时钟：sleep 直接把表往前拨。
// 循环里的睡都是「等一段时间」，没有一个是「等外部事件」，所以自动拨表不会掩盖竞态。
function make({prepare, play, announce, limits = {}, rng = () => 0.5, pickCandidates = null} = {}) {
  const box = {clock: BASE};
  const calls = {prepare: [], play: [], announce: []};
  const phases = [];
  const holder = {};
  const cycle = new DebateCycle({
    bank: BANK,
    pickCandidates,
    prepare: async (topic, ctx) => {
      calls.prepare.push({id: topic.id, at: box.clock, phase: cycle.phase});
      if (prepare) return prepare(topic, ctx, {cycle, box, calls});
      return {script: {id: topic.id, turns: [{id: 't1', text: '一句话'}]}, ready: true};
    },
    play: async (script, ctx) => {
      calls.play.push({id: ctx.topic.id, at: box.clock});
      if (play) return play(script, ctx, {cycle, box, calls});
    },
    announce: async (script, ctx) => {
      calls.announce.push({id: ctx?.topic?.id, at: box.clock});
      if (announce) return announce(script, ctx, {cycle, box, calls});
    },
    onPhase: event => phases.push(event.phase),
    now: () => box.clock,
    // 睡在「让出之后」才拨表：若在调用时就拨，预热的那两分钟会算到播放开始之前，
    // 看上去像「一开播就预热」，测试就测不到时序了。
    sleep: ms => new Promise(resolve => queueMicrotask(() => { box.clock += ms; resolve(); })),
    log: () => {},
    rng,
    limits: {
      resultMs: 1000, readyMs: 1000, tickMs: 1000, prewarmDelayMs: 1000,
      voteMinMs: 3000, voteMaxMs: 8000, tieExtraMs: 2000,
      concurrency: 2, ...limits
    }
  });
  holder.cycle = cycle;
  holder.box = box;
  holder.calls = calls;
  holder.phases = phases;
  return holder;
}

test('第一场不投票：直接写完就开播', async () => {
  const {cycle, calls, phases} = make();
  await cycle.run({first: BANK[0], rounds: 1});
  assert.equal(calls.play.length, 1);
  assert.equal(calls.play[0].id, 'slack');
  assert.equal(phases.includes('vote'), false, '第一场没有上一场，不投票');
  assert.deepEqual(phases.slice(0, 3), ['write', 'match', 'result']);
  assert.equal(cycle.stats.matches, 1);
});

test('一场接一场：正赛 → 结果卡 → 投票 → 预告 → 下一场', async () => {
  const {cycle, calls, phases} = make();
  await cycle.run({first: BANK[0], rounds: 2});
  assert.deepEqual(phases.slice(0, 7), ['write', 'match', 'result', 'vote', 'ready', 'match', 'result']);
  assert.equal(calls.play.length, 2);
  assert.equal(cycle.stats.matches, 2);
  assert.equal(cycle.stats.votes, 1);
  assert.equal(calls.announce.length, 1, '只有第二场开打前有预告');
});

test('预热在正赛 +2:00 才开始，且 4 个候选都写了', async () => {
  const {cycle, calls} = make({limits: {prewarmDelayMs: 120000}});
  await cycle.run({first: BANK[0], rounds: 2});
  const matchAt = calls.play[0].at;
  // 按题筛而不是按阶段筛：预热跨了 match / result 两个阶段，
  // 拿阶段当判据会把「结果卡那 90 秒里写完的后两题」漏掉。
  const warm = calls.prepare.filter(call => call.id !== 'slack');
  assert.equal(warm.length, 4, '4 个候选都要写');
  assert.ok(warm.every(call => call.at >= matchAt + 120000), `预热不能提前：${warm.map(c => c.at - matchAt)}`);
});

test('冠军稿没预写：锁票后现场补写，补完照播', async () => {
  const {cycle, calls} = make({
    limits: {prewarmDelayMs: 1000},
    prepare: (topic, ctx, {cycle: c}) => {
      // 预热阶段全部写失败（模拟网关抽风），现场补写时才成功
      if (c.phase === 'match') return {ready: false, error: '网关抽风'};
      return {script: {id: topic.id, turns: []}, ready: true};
    }
  });
  await cycle.run({first: BANK[0], rounds: 2});
  assert.equal(calls.play.length, 2);
  assert.ok(cycle.stats.writes >= 2, `补写次数 ${cycle.stats.writes}`);
  assert.equal(cycle.stats.swaps, 0, '补写成功就不该换稿');
  assert.notEqual(calls.play[1].id, 'slack', '第二场不能还是第一场那题');
});

test('补写也失败：换一份已就绪的稿上，不断播', async () => {
  // 候选固定成四题，把「写不出来的那题」钉死——
  // 让随机选材参与进来，这条用例就会变成「有时候过、有时候不过」。
  const FIXED = BANK.slice(0, 4);
  // 不能拿 FIXED[0]：那是第一场要播的题，一开场就写不出来会直接把循环停掉
  const broken = FIXED[3].id;
  const {cycle, calls} = make({
    pickCandidates: ({avoid, n}) => FIXED.filter(item => !avoid.includes(item.id)).slice(0, n),
    prepare: topic => (topic.id === broken ? {ready: false, error: '写不出来'} : {script: {id: topic.id, turns: []}, ready: true})
  });
  // 全票投给那个写不出来的题。票要在开票之后投，播的时候就投会被判 not-open。
  const original = cycle.onPhase;
  cycle.onPhase = event => {
    original(event);
    if (event.phase !== 'vote' || cycle.round !== 1) return;
    const index = cycle.candidates.findIndex(item => item.id === broken);
    cycle.vote.cast({userId: 'u1', name: '甲', text: String(index + 1)});
    cycle.vote.cast({userId: 'u2', name: '乙', text: String(index + 1)});
  };
  await cycle.run({first: BANK[0], rounds: 2});
  assert.equal(calls.play.length, 2);
  assert.notEqual(calls.play[1].id, broken, '写不出来的那题不能硬播');
  assert.equal(cycle.stats.swaps, 1);
  assert.ok(cycle.events.some(event => event.phase === 'swap'));
});

test('零票：按题库轮转，不卡住整晚', async () => {
  const {cycle, calls} = make();
  await cycle.run({first: BANK[0], rounds: 2});
  assert.equal(cycle.stats.emptyVotes, 1);
  assert.equal(calls.play.length, 2);
  assert.notEqual(calls.play[1].id, 'slack', '轮转的题不能是刚播过的');
});

test('平票：加时一次，再平交给随机裁决', async () => {
  const FIXED = BANK.slice(0, 4);
  const {cycle, calls} = make({
    rng: () => 0.99,
    pickCandidates: ({avoid, n}) => FIXED.filter(item => !avoid.includes(item.id)).slice(0, n)
  });
  // 票要在开票之后投：开票前投会被判 not-open，这条以前踩过。
  const original = cycle.onPhase;
  cycle.onPhase = event => {
    original(event);
    if (event.phase === 'vote' && cycle.round === 1) {
      cycle.vote.cast({userId: 'u1', name: '甲', text: '1'});
      cycle.vote.cast({userId: 'u2', name: '乙', text: '2'});
    }
  };
  await cycle.run({first: BANK[0], rounds: 2});
  assert.equal(cycle.stats.ties, 1);
  assert.equal(calls.play.length, 2);
  assert.ok(['overtime', 'pie', 'meeting'].includes(calls.play[1].id), `裁决落在并列题里：${calls.play[1].id}`);
  const event = cycle.events.find(item => item.phase === 'ready');
  assert.equal(event.by, 'tie-random');
});

test('最后一场结束不再生成下一场候选', async () => {
  const {cycle, box} = make();
  await cycle.run({first: BANK[0], rounds: 1});
  const view = cycle.view();
  assert.equal(view.phase, 'idle');
  assert.equal(view.round, 1);
  assert.ok(view.history.includes('slack'));
  assert.equal(view.scripts.length, 1);
  assert.deepEqual(view.candidates, []);
  assert.equal(typeof view.vote.total, 'number');
  assert.equal(box.clock > BASE, true, '虚拟时钟确实往前走了');
});

test('停在中途：投票期喊停，不再开下一场', async () => {
  const {cycle, calls} = make();
  const original = cycle.vote;
  // 投票一开始就停
  cycle.onPhase = event => {
    if (event.phase === 'vote') cycle.stop();
  };
  await cycle.run({first: BANK[0], rounds: 5});
  assert.equal(calls.play.length, 1);
  assert.equal(cycle.running, false);
  assert.equal(cycle.phase, 'idle');
  assert.equal(original.closed, false);
});

test('播放抛错不算整晚结束：这一场当提前收尾，继续走', async () => {
  const {cycle, calls, phases} = make({
    play: () => { throw new Error('音频断了'); }
  });
  await cycle.run({first: BANK[0], rounds: 2});
  assert.equal(calls.play.length, 2);
  assert.ok(phases.includes('vote'), '出过错也照样进投票');
  assert.equal(cycle.stats.aborted, 0);
});

test('默认短场排期：结果卡3秒、投票20～30秒、开场2秒', () => {
  assert.equal(CYCLE_DEFAULTS.resultMs, 3000);
  assert.equal(CYCLE_DEFAULTS.voteMinMs,20000);assert.equal(CYCLE_DEFAULTS.voteMaxMs,30000);
  assert.equal(CYCLE_DEFAULTS.readyMs,2000);assert.equal(CYCLE_DEFAULTS.tieExtraMs,0);
  assert.equal(CYCLE_DEFAULTS.prewarmDelayMs, 120000);
  assert.equal(CYCLE_DEFAULTS.concurrency, 2);
  assert.equal(CYCLE_DEFAULTS.candidates, 4);
});
