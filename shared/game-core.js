/*
 * Squeak Smash! shared game core.
 *
 * This file runs UNCHANGED in the browser (window.SqCore) and on the server (require).
 * Everything that decides a score lives here, so the browser and the server always agree:
 *
 *   1. buildSchedule(seed)  -> the full list of mice for one 60 s round (hole, type, appear/leave time).
 *                              It depends only on the seed, never on what the player does.
 *   2. createRound(seed)    -> a small state machine. tap(t, hole) applies one tap at time t (ms).
 *   3. replay(seed, taps)   -> server side: re-plays a whole tap log and returns the verified score.
 *   4. analyze(summary)     -> plausibility checks for human-like play.
 *
 * Rules (from the project spec):
 *   60 s, 5 silent speed levels (15/15/10/10/10 s). normal 1 pt, golden 5 pts, hard-hat mouse 2 hits = 3 pts,
 *   bunny -1 pt and a 1 s stun, every 3 hits in a row +2 bonus. Missing (empty hole, a mouse that already
 *   got hit, or a mouse that leaves un-whacked) breaks the streak.
 *
 * IMPORTANT: only use +, -, *, / and Math.floor/round/min/max in here (no Math.sin, exp, ...), so every
 * JS engine produces bit-identical schedules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SqCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DURATION_MS = 60000;
  var HOLES = 12;
  // until = end of the level in ms, up = how long a normal mouse stays up, gap = pause between spawns, max = mice up at once
  var LEVELS = [
    { until: 15000, up: 1300, gap: 820, max: 2 },
    { until: 30000, up: 1050, gap: 660, max: 2 },
    { until: 40000, up: 850,  gap: 520, max: 3 },
    { until: 50000, up: 680,  gap: 420, max: 3 },
    { until: 60000, up: 530,  gap: 330, max: 4 }
  ];
  var PTS = { normal: 1, gold: 5, tough: 3 };
  var BUNNY_PENALTY = 1, STUN_MS = 1000, COMBO_EVERY = 3, COMBO_BONUS = 2;
  var P_BUNNY = 0.12, P_GOLD = 0.07, P_TOUGH = 0.09;   // tough mice appear from level 2 on

  function levelAt(t) {
    for (var i = 0; i < LEVELS.length; i++) if (t < LEVELS[i].until) return i;
    return LEVELS.length - 1;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ---------- 1. schedule ---------- */
  function buildSchedule(seed) {
    var R = mulberry32(seed >>> 0);
    var ev = [];
    var freeAt = [];                 // per hole: time when it becomes free again
    for (var h = 0; h < HOLES; h++) freeAt.push(0);
    var goldUntil = 0;
    var t = 0;
    while (t < DURATION_MS) {
      var lv = levelAt(t), L = LEVELS[lv];
      var upNow = 0, free = [];
      for (var i = 0; i < HOLES; i++) { if (freeAt[i] > t) upNow++; else free.push(i); }
      // always draw the same numbers in the same order so the stream stays aligned
      var rHole = R(), rType = R(), rGap = R();
      if (upNow < L.max && free.length) {
        var hole = free[Math.floor(rHole * free.length)];
        var type = 'normal';
        var tough = lv >= 1 ? P_TOUGH : 0;
        if (rType < P_BUNNY) type = 'bunny';
        else if (rType < P_BUNNY + P_GOLD && goldUntil <= t) type = 'gold';
        else if (rType >= P_BUNNY + P_GOLD && rType < P_BUNNY + P_GOLD + tough) type = 'tough';
        var dur = type === 'gold' ? Math.max(600, Math.round(L.up * 0.85))
                : type === 'tough' ? Math.round(L.up * 1.4)
                : L.up;
        var end = Math.min(t + dur, DURATION_MS);
        ev.push({ id: ev.length, t: t, end: end, hole: hole, type: type, hp: type === 'tough' ? 2 : 1 });
        freeAt[hole] = end;
        if (type === 'gold') goldUntil = end;
      }
      t += Math.round(L.gap * (0.8 + rGap * 0.5));
    }
    return ev;
  }

  /* ---------- 2. round state machine ---------- */
  function createRound(seed) {
    var sched = buildSchedule(seed);
    var byHole = [];
    for (var h = 0; h < HOLES; h++) byHole.push([]);
    sched.forEach(function (e) { e.hit = false; e.left = e.hp; byHole[e.hole].push(e); });
    var order = sched.slice().sort(function (a, b) { return a.end - b.end || a.id - b.id; });
    var oi = 0;
    var S = {
      score: 0, hits: 0, taps: 0, okTaps: 0, combo: 0, maxCombo: 0,
      stunUntil: 0, missedMice: 0, reactions: [], lastT: 0
    };

    // mice whose time ran out: returns them so the UI can pull them back
    function advance(t) {
      var out = [];
      while (oi < order.length && order[oi].end <= t) {
        var e = order[oi++];
        if (!e.hit) {
          if (e.type !== 'bunny') { S.combo = 0; S.missedMice++; }
          out.push(e);
        }
      }
      return out;
    }
    function upAt(hole, t) {
      var a = byHole[hole];
      for (var i = 0; i < a.length; i++) if (a[i].t <= t && t < a[i].end) return a[i];
      return null;
    }

    // one tap at time t (ms since the round started). Calls must come in non-decreasing t.
    function tap(t, hole) {
      if (t >= DURATION_MS) return { k: 'late' };
      if (t < S.lastT) t = S.lastT;
      S.lastT = t;
      var expired = advance(t);
      if (t < S.stunUntil) return { k: 'stunned', expired: expired };
      S.taps++;
      var e = upAt(hole, t);
      if (!e || e.hit) { S.combo = 0; return { k: 'miss', expired: expired }; }
      if (e.type === 'bunny') {
        e.hit = true; S.combo = 0;
        S.score = Math.max(0, S.score - BUNNY_PENALTY);
        S.stunUntil = t + STUN_MS;
        return { k: 'bunny', ev: e, pts: -BUNNY_PENALTY, expired: expired };
      }
      S.okTaps++;
      if (e.left === e.hp) S.reactions.push(t - e.t);        // first touch of this mouse
      if (e.type === 'tough' && e.left > 1) {
        e.left--;
        return { k: 'dent', ev: e, expired: expired };
      }
      e.hit = true; S.hits++; S.combo++;
      if (S.combo > S.maxCombo) S.maxCombo = S.combo;
      var pts = PTS[e.type];
      var bonus = S.combo % COMBO_EVERY === 0;
      if (bonus) pts += COMBO_BONUS;
      S.score += pts;
      return { k: 'hit', ev: e, pts: pts, bonus: bonus, expired: expired };
    }

    return { schedule: sched, state: S, advance: advance, tap: tap };
  }

  /* ---------- 3. server replay ---------- */
  var MAX_TAPS = 700;
  function validateTaps(taps) {
    if (!Array.isArray(taps)) return 'taps must be an array';
    if (taps.length > MAX_TAPS) return 'too many taps';
    var last = 0;
    for (var i = 0; i < taps.length; i++) {
      var x = taps[i];
      if (!Array.isArray(x) || x.length !== 2) return 'bad tap format';
      var t = x[0], h = x[1];
      if (!Number.isInteger(t) || !Number.isInteger(h)) return 'taps must be integers';
      if (t < 0 || t >= DURATION_MS) return 'tap time out of range';
      if (h < 0 || h >= HOLES) return 'hole out of range';
      if (t < last) return 'taps out of order';
      last = t;
    }
    return null;
  }

  function replay(seed, taps) {
    var err = validateTaps(taps);
    if (err) return { error: err };
    var r = createRound(seed);
    for (var i = 0; i < taps.length; i++) r.tap(taps[i][0], taps[i][1]);
    r.advance(DURATION_MS);
    var S = r.state;
    return {
      score: S.score, hits: S.hits, taps: S.taps, okTaps: S.okTaps, maxCombo: S.maxCombo,
      missedMice: S.missedMice, reactions: S.reactions, tapCount: taps.length,
      tapTimes: taps.map(function (x) { return x[0]; })
    };
  }

  /* ---------- 4. plausibility ---------- */
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function stddev(a) {
    if (a.length < 2) return 0;
    var m = a.reduce(function (p, c) { return p + c; }, 0) / a.length, v = 0;
    a.forEach(function (x) { v += (x - m) * (x - m); });
    return Math.sqrt(v / a.length);
  }
  // returns { verdict: 'ok' | 'suspect' | 'rejected', flags: [...], metrics }
  // Thresholds are a first guess: tune them with real data after launch.
  function analyze(sum) {
    var flags = [], re = sum.reactions, n = re.length;
    var fast = re.filter(function (x) { return x < 100; }).length;
    var sd = stddev(re), med = median(re);
    var gaps = [];
    for (var i = 1; i < sum.tapTimes.length; i++) gaps.push(sum.tapTimes[i] - sum.tapTimes[i - 1]);
    var gapMed = median(gaps);
    var acc = sum.taps ? sum.okTaps / sum.taps : 0;
    var verdict = 'ok';
    // Superhuman reactions with high accuracy = a bot. The same reactions with LOW accuracy are just a kid mashing every hole
    // (some mice get hit a split second after they appear by luck), so that is never a reason to reject.
    if (n >= 5 && fast / n > 0.15) {
      if (acc >= 0.7) { flags.push('superhuman_reaction'); verdict = 'rejected'; }
      else { flags.push('fast_reactions_low_accuracy'); }
    }
    if (n >= 30 && sd < 30) { flags.push('uniform_reaction'); if (verdict === 'ok') verdict = 'suspect'; }
    if (sum.taps >= 70 && acc >= 0.99) { flags.push('near_perfect_accuracy'); if (verdict === 'ok') verdict = 'suspect'; }
    if (sum.taps >= 100 && gapMed < 80) { flags.push('tap_rate'); if (verdict === 'ok') verdict = 'suspect'; }
    return {
      verdict: verdict, flags: flags,
      metrics: { hits: n, fast: fast, reactionMedian: Math.round(med), reactionSd: Math.round(sd), accuracy: Math.round(acc * 1000) / 1000, gapMedian: Math.round(gapMed) }
    };
  }

  return {
    DURATION_MS: DURATION_MS, HOLES: HOLES, LEVELS: LEVELS, PTS: PTS,
    BUNNY_PENALTY: BUNNY_PENALTY, STUN_MS: STUN_MS, COMBO_EVERY: COMBO_EVERY, COMBO_BONUS: COMBO_BONUS,
    levelAt: levelAt, mulberry32: mulberry32,
    buildSchedule: buildSchedule, createRound: createRound,
    validateTaps: validateTaps, replay: replay, analyze: analyze, MAX_TAPS: MAX_TAPS
  };
});
