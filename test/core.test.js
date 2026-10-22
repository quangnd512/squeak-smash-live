const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/game-core.js');

test('schedule is deterministic per seed and differs across seeds', () => {
  const a = JSON.stringify(C.buildSchedule(12345));
  assert.equal(a, JSON.stringify(C.buildSchedule(12345)));
  assert.notEqual(a, JSON.stringify(C.buildSchedule(12346)));
});

test('schedule respects holes, max-at-once, one gold at a time, 60 s limit', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = C.buildSchedule(seed * 7919);
    assert.ok(s.length > 80 && s.length < 200, 'mouse count ' + s.length);
    for (const e of s) {
      assert.ok(e.hole >= 0 && e.hole < C.HOLES);
      assert.ok(e.end <= C.DURATION_MS && e.end > e.t);
      const L = C.LEVELS[C.levelAt(e.t)];
      const up = s.filter(o => o.t <= e.t && o.end > e.t);
      assert.ok(up.length <= L.max, 'too many up at once');
      assert.equal(new Set(up.map(o => o.hole)).size, up.length, 'two mice in one hole');
      assert.ok(up.filter(o => o.type === 'gold').length <= 1, 'two golds');
      if (C.levelAt(e.t) === 0) assert.notEqual(e.type, 'tough');
    }
  }
});

function tapFirst(seed, type) {
  const s = C.buildSchedule(seed);
  return s.find(e => e.type === type);
}

test('scoring: normal 1, gold 5, tough needs 2 hits for 3, bunny -1 and stun', () => {
  const seed = 99;
  const s = C.buildSchedule(seed);
  const normal = s.find(e => e.type === 'normal');
  let r = C.createRound(seed);
  assert.equal(r.tap(normal.t + 200, normal.hole).k, 'hit');
  assert.equal(r.state.score, 1);

  const gold = s.find(e => e.type === 'gold');
  r = C.createRound(seed);
  assert.equal(r.tap(gold.t + 200, gold.hole).pts, 5);

  const tough = s.find(e => e.type === 'tough');
  r = C.createRound(seed);
  assert.equal(r.tap(tough.t + 200, tough.hole).k, 'dent');
  assert.equal(r.state.score, 0);
  assert.equal(r.tap(tough.t + 300, tough.hole).pts, 3);
  assert.equal(r.state.hits, 1);

  const bunny = s.find(e => e.type === 'bunny');
  r = C.createRound(seed);
  const b = r.tap(bunny.t + 100, bunny.hole);
  assert.equal(b.k, 'bunny');
  assert.equal(r.state.score, 0, 'score never below zero');
  // anything inside the stun window is ignored and not counted as a tap
  assert.equal(r.tap(bunny.t + 600, normal.hole).k, 'stunned');
  assert.equal(r.state.taps, 1);
});

test('every 3rd hit in a row gives +2, a miss resets the streak', () => {
  // build a synthetic perfect player: hit every normal/gold mouse as soon as it appears
  const seed = 4242;
  const s = C.buildSchedule(seed);
  const r = C.createRound(seed);
  const bonuses = [];
  let streak = 0;
  for (const e of s) {
    if (e.type === 'bunny' || e.type === 'tough') continue;
    const res = r.tap(e.t + 150, e.hole);
    if (res.k !== 'hit') continue;
    streak = r.state.combo;
    if (res.bonus) bonuses.push(streak);
  }
  assert.ok(bonuses.length > 3);
  bonuses.forEach(c => assert.equal(c % 3, 0));
  // miss resets
  const r2 = C.createRound(seed);
  const a = s.find(e => e.type === 'normal');
  r2.tap(a.t + 100, a.hole);
  assert.equal(r2.state.combo, 1);
  const emptyHole = [...Array(12).keys()].find(h => !s.some(e => e.hole === h && e.t <= a.t + 200 && e.end > a.t + 200));
  r2.tap(a.t + 200, emptyHole);
  assert.equal(r2.state.combo, 0);
});

test('a mouse leaving un-whacked breaks the streak, a bunny leaving does not', () => {
  const seed = 77;
  const s = C.buildSchedule(seed);
  const first = s.find(e => e.type === 'normal');
  const r = C.createRound(seed);
  r.tap(first.t + 100, first.hole);
  assert.equal(r.state.combo, 1);
  const later = s.find(e => e.type === 'normal' && e.end > first.end && e.t > first.t + 150);
  r.advance(later.end);
  assert.equal(r.state.combo, 0);
});

test('hitting the same mouse twice, or after it left, is a miss', () => {
  const seed = 5;
  const s = C.buildSchedule(seed);
  const e = s.find(x => x.type === 'normal');
  const r = C.createRound(seed);
  assert.equal(r.tap(e.t + 100, e.hole).k, 'hit');
  assert.equal(r.tap(e.t + 120, e.hole).k, 'miss');
  const r2 = C.createRound(seed);
  assert.equal(r2.tap(e.end, e.hole).k, 'miss');
  assert.equal(C.createRound(seed).tap(C.DURATION_MS, 0).k, 'late');
});

test('replay equals live play (client and server agree)', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const s = C.buildSchedule(seed * 31);
    const live = C.createRound(seed * 31);
    const log = [];
    let rng = C.mulberry32(seed);
    for (const e of s) {
      if (rng() < 0.2) continue;
      const t = e.t + 120 + Math.floor(rng() * 300);
      if (t >= e.end) continue;
      if (log.length && t < log[log.length - 1][0]) continue;
      log.push([t, e.hole]); live.tap(t, e.hole);
      if (rng() < 0.1) { const t2 = t + 5; log.push([t2, Math.floor(rng() * 12)]); live.tap(t2, log[log.length - 1][1]); }
    }
    live.advance(C.DURATION_MS);
    const rep = C.replay(seed * 31, log);
    assert.equal(rep.score, live.state.score);
    assert.equal(rep.hits, live.state.hits);
    assert.equal(rep.taps, live.state.taps);
  }
});

test('validateTaps rejects malformed logs', () => {
  assert.ok(C.validateTaps('x'));
  assert.ok(C.validateTaps([[1]]));
  assert.ok(C.validateTaps([[1.5, 2]]));
  assert.ok(C.validateTaps([[-1, 2]]));
  assert.ok(C.validateTaps([[60000, 2]]));
  assert.ok(C.validateTaps([[10, 12]]));
  assert.ok(C.validateTaps([[20, 1], [10, 1]]));
  assert.ok(C.validateTaps(Array.from({ length: 701 }, (_, i) => [i, 0])));
  assert.equal(C.validateTaps([[10, 1], [10, 2], [11, 3]]), null);
});

// ---- simulated players to sanity-check score range and anti-cheat thresholds ----
function simulate(seed, { skill, rng }) {
  const s = C.buildSchedule(seed);
  const log = [];
  const r = C.createRound(seed);
  // skill: chance to notice a mouse, reaction mean/sd (ms), bunny confusion
  for (const e of s) {
    if (rng() > skill.notice) continue;
    const react = Math.max(skill.min, skill.mean + (rng() + rng() + rng() - 1.5) * 2 * skill.sd);
    const t = Math.round(e.t + react);
    if (t >= e.end || t >= 60000) continue;
    if (e.type === 'bunny' && rng() > skill.bunnyMistake) continue;
    log.push([t, e.hole]);
    if (e.type === 'tough') log.push([t + 140, e.hole]);
    if (rng() < skill.stray) log.push([t + 60 + Math.floor(rng() * 400), Math.floor(rng() * 12)]);   // stray tap on a random hole
  }
  log.sort((a, b) => a[0] - b[0]);
  return log.filter(x => x[0] < 60000);
}

test('simulated humans score in a sane range and pass the checks', () => {
  const rng = C.mulberry32(1);
  const scores = [];
  let suspects = 0, rejected = 0, N = 300;
  for (let i = 0; i < N; i++) {
    const seed = Math.floor(rng() * 4e9);
    const skill = { stray: 0.05 + rng() * 0.2, notice: 0.4 + rng() * 0.5, mean: 320 + rng() * 150, sd: 90 + rng() * 60, min: 150, bunnyMistake: 0.12 };
    const rep = C.replay(seed, simulate(seed, { skill, rng }));
    scores.push(rep.score);
    const a = C.analyze(rep);
    if (a.verdict === 'suspect') suspects++;
    if (a.verdict === 'rejected') rejected++;
  }
  scores.sort((a, b) => a - b);
  const med = scores[N >> 1], max = scores[N - 1];
  console.log('human sim: median', med, 'max', max, 'suspect', suspects, 'rejected', rejected);
  assert.ok(med > 25 && med < 130, 'median ' + med);
  assert.ok(max < 260);
  assert.equal(rejected, 0);
  assert.ok(suspects / N < 0.03, 'too many false suspects: ' + suspects);
});

test('a bot that taps every mouse after a fixed delay is caught', () => {
  const rng = C.mulberry32(2);
  let caught = 0, N = 40;
  for (let i = 0; i < N; i++) {
    const seed = Math.floor(rng() * 4e9);
    const s = C.buildSchedule(seed);
    const log = [];
    for (const e of s) { if (e.type === 'bunny') continue; log.push([e.t + 40, e.hole]); if (e.type === 'tough') log.push([e.t + 80, e.hole]); }
    log.sort((a, b) => a[0] - b[0]);
    const a = C.analyze(C.replay(seed, log.filter(x => x[0] < 60000)));
    if (a.verdict !== 'ok') caught++;
  }
  assert.equal(caught, N);
});

test('a bot with random 120-260 ms delay and perfect accuracy is flagged suspect', () => {
  const rng = C.mulberry32(3);
  let flagged = 0, N = 40;
  for (let i = 0; i < N; i++) {
    const seed = Math.floor(rng() * 4e9);
    const s = C.buildSchedule(seed);
    const log = [];
    for (const e of s) {
      if (e.type === 'bunny') continue;
      const t = e.t + 120 + Math.floor(rng() * 140);
      if (t >= e.end) continue;
      log.push([t, e.hole]); if (e.type === 'tough') log.push([t + 90, e.hole]);
    }
    log.sort((a, b) => a[0] - b[0]);
    if (C.analyze(C.replay(seed, log.filter(x => x[0] < 60000))).verdict !== 'ok') flagged++;
  }
  assert.ok(flagged >= N * 0.9, 'only ' + flagged + '/' + N);
});

test('a kid mashing every hole is not rejected', () => {
  const rng = C.mulberry32(9);
  for (let i = 0; i < 100; i++) {
    const seed = Math.floor(rng() * 4e9);
    const log = [];
    for (let t = 200; t < 59900; t += 90 + Math.floor(rng() * 80)) log.push([t, Math.floor(rng() * 12)]);
    const rep = C.replay(seed, log);
    const a = C.analyze(rep);
    assert.notEqual(a.verdict, 'rejected', 'masher rejected: ' + JSON.stringify(a));
  }
});
