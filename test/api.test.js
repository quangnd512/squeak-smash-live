// Integration test: real Postgres + real Redis. Needs TEST_DATABASE_URL and TEST_REDIS_URL, otherwise it is skipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/game-core.js');

const DB = process.env.TEST_DATABASE_URL, RD = process.env.TEST_REDIS_URL;
const skip = !(DB && RD) && 'set TEST_DATABASE_URL and TEST_REDIS_URL to run';

let app, pool, redis, clockMs = 1_000_000_000_000, nowDate = new Date('2026-10-20T10:00:00Z');
const cfgBase = () => ({ ...require('../server/config.js'), databaseUrl: DB, redisUrl: RD, hashSecret: 'test', staticDir: __dirname, turnstile: { siteKey: '', secret: '' }, trustProxy: true, behindCloudflare: false, maxStrikes: 3 });

async function boot(over = {}) {
  const { makePool, migrate } = require('../server/db.js');
  const Redis = require('ioredis');
  const { buildApp } = require('../server/app.js');
  pool = makePool(DB); redis = new Redis(RD);
  await migrate(pool);
  await pool.query('truncate players, rounds, country_month, month_players, hall_of_fame restart identity cascade');
  await redis.flushdb();
  app = await buildApp({ cfg: { ...cfgBase(), ...over }, pool, redis, now: () => nowDate, clock: () => clockMs });
}
const J = (res) => JSON.parse(res.body);
const post = (url, body, token, ip = '1.1.1.1') => app.inject({ method: 'POST', url, payload: body, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'x-forwarded-for': ip } });
const get = (url, token, ip = '1.1.1.1') => app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'x-forwarded-for': ip } });

async function join(name, country, ip) { const r = await post('/api/join', { name, country }, null, ip); return { res: r, body: J(r) }; }
function humanLog(seed, rng, quality = 0.7) {
  const s = core.buildSchedule(seed), log = [];
  for (const e of s) {
    if (rng() > quality) continue;
    const t = Math.round(e.t + 180 + rng() * 280);
    if (t >= e.end || t >= 60000) continue;
    if (e.type === 'bunny') continue;
    log.push([t, e.hole]); if (e.type === 'tough') log.push([t + 130, e.hole]);
    if (rng() < 0.12) log.push([t + 50 + Math.floor(rng() * 300), Math.floor(rng() * 12)]);
  }
  return log.sort((a, b) => a[0] - b[0]).filter(x => x[0] < 60000);
}
async function playRound(token, log, { wait = 62500, ip } = {}) {
  const st = J(await post('/api/round/start', {}, token, ip));
  const taps = log ? log(st.seed) : [];
  clockMs += wait;
  const res = await post('/api/round/finish', { roundId: st.roundId, taps }, token, ip);
  return { st, res, body: J(res), taps };
}

test.before(async () => { if (!skip) await boot(); });
test.after(async () => { if (app) await app.close(); if (pool) await pool.end(); if (redis) redis.disconnect(); });

test('join: stores a clean traffic source and drops junk', { skip }, async () => {
  const cases = [['SrcReddit', 'Reddit_PH', 'reddit_ph'], ['SrcShare', 'share', 'share'], ['SrcBad', '<script>alert(1)</script>', null],
    ['SrcLong', 'a'.repeat(33), null], ['SrcNone', undefined, null], ['SrcNum', 123, null]];
  for (const [name, src, want] of cases) {
    const r = await post('/api/join', { name, country: 'PH', src }, null, '9.9.9.' + (name.length));
    assert.equal(r.statusCode, 200, name);
    const { rows } = await pool.query('select src from players where name_key = $1', [name.toLowerCase()]);
    assert.equal(rows[0].src, want, name);
  }
});

test('join: validates names, countries, blocks duplicates and bad words', { skip }, async () => {
  assert.equal((await join('ab', 'VN')).res.statusCode, 400);
  assert.equal((await join('bad name', 'VN')).res.statusCode, 400);
  assert.equal((await join('f_u_c_k99', 'VN')).res.statusCode, 400);
  assert.equal((await join('Admin', 'VN')).res.statusCode, 400);
  assert.equal((await join('12345', 'VN')).res.statusCode, 400);
  assert.equal((await join('goodname', 'XX')).res.statusCode, 400);
  const ok = await join('MouseMaster', 'vn');
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.body.player.country, 'VN');
  assert.ok(ok.body.token.length >= 40);
  const dup = await join('mousemaster', 'US');
  assert.equal(dup.res.statusCode, 409);
  const { rows } = await pool.query('select token_hash from players');
  assert.ok(Buffer.isBuffer(rows[0].token_hash) && rows[0].token_hash.length === 32, 'token is stored hashed');
});

test('auth: missing or wrong token is refused', { skip }, async () => {
  assert.equal((await post('/api/round/start', {})).statusCode, 401);
  assert.equal((await post('/api/round/start', {}, 'x'.repeat(43))).statusCode, 401);
  assert.equal((await get('/api/me')).statusCode, 401);
});

test('full flow: play, verify, country total + ranks + leaderboards', { skip }, async () => {
  const rng = core.mulberry32(11);
  const a = (await join('alice_vn', 'VN', '2.2.2.2')).body.token;
  const b = (await join('bob_us', 'US', '3.3.3.3')).body.token;
  const c = (await join('carol_us', 'US', '3.3.3.4')).body.token;

  // too early is refused
  const early = await playRound(a, () => [], { wait: 5000, ip: '2.2.2.2' });
  assert.equal(early.res.statusCode, 400);

  const r1 = await playRound(a, (seed) => humanLog(seed, rng, 0.8), { ip: '2.2.2.2' });
  assert.equal(r1.res.statusCode, 200, r1.res.body);
  const expected = core.replay(r1.st.seed, r1.taps).score;
  assert.equal(r1.body.score, expected, 'server score equals replayed score');
  assert.ok(expected > 20);
  assert.equal(r1.body.country.c, 'VN');
  assert.equal(r1.body.country.total, expected);
  assert.equal(r1.body.country.rank, 1);
  assert.equal(r1.body.player.record, true);
  assert.equal(r1.body.player.rank, 1);

  const r2 = await playRound(b, (seed) => humanLog(seed, rng, 0.5), { ip: '3.3.3.3' });
  assert.equal(r2.res.statusCode, 200, r2.res.body);
  const r3 = await playRound(c, (seed) => humanLog(seed, rng, 0.5), { ip: '3.3.3.4' });
  const r4 = await playRound(b, (seed) => humanLog(seed, rng, 0.9), { ip: '3.3.3.3' });
  const usTotal = r2.body.score + r3.body.score + r4.body.score;

  const st = J(await get('/api/state'));
  assert.equal(st.month, '2026-10');
  const us = st.countries.find(x => x.c === 'US'), vn = st.countries.find(x => x.c === 'VN');
  assert.equal(us.total, usTotal, 'country score is the SUM of every round');
  assert.equal(us.players, 2, 'players = different people who played');
  assert.equal(us.rounds, 3);
  assert.equal(vn.total, expected);
  assert.deepEqual(st.countries.map(x => x.total), [...st.countries.map(x => x.total)].sort((x, y) => y - x));
  if (usTotal > expected) assert.equal(r4.body.country.rank, 1);

  // best round is kept per player, not summed
  const me = J(await get('/api/me', b));
  assert.equal(me.best, Math.max(r2.body.score, r4.body.score));
  assert.equal(me.rounds, 2);

  const pl = J(await get('/api/players?limit=15', c));
  assert.equal(pl.players[0].best >= pl.players[1].best, true);
  assert.equal(pl.me.name, 'carol_us');
  assert.ok(pl.players.length === 3);

  // the same round cannot be handed in twice
  const again = await post('/api/round/finish', { roundId: r1.st.roundId, taps: r1.taps }, a, '2.2.2.2');
  assert.equal(again.statusCode, 409);
});

test('starting a new round cancels the previous one', { skip }, async () => {
  const t = (await join('replace_me', 'JP', '4.4.4.4')).body.token;
  const s1 = J(await post('/api/round/start', {}, t, '4.4.4.4'));
  const s2 = J(await post('/api/round/start', {}, t, '4.4.4.4'));
  assert.notEqual(s1.roundId, s2.roundId);
  clockMs += 62500;
  const old = await post('/api/round/finish', { roundId: s1.roundId, taps: [] }, t, '4.4.4.4');
  assert.equal(old.statusCode, 409);
});

test('expired rounds are refused', { skip }, async () => {
  const t = (await join('slowpoke', 'JP', '4.4.4.5')).body.token;
  const s = J(await post('/api/round/start', {}, t, '4.4.4.5'));
  clockMs += 200000;
  const r = await post('/api/round/finish', { roundId: s.roundId, taps: [] }, t, '4.4.4.5');
  assert.equal(r.statusCode, 409);
});

test('cheating: forged score, impossible timing, malformed logs', { skip }, async () => {
  const t = (await join('cheater1', 'BR', '5.5.5.5')).body.token;
  // client claims a score: ignored, the server only reads taps
  let s = J(await post('/api/round/start', {}, t, '5.5.5.5')); clockMs += 62500;
  let r = await post('/api/round/finish', { roundId: s.roundId, taps: [], score: 9999 }, t, '5.5.5.5');
  assert.equal(r.statusCode, 200); assert.equal(J(r).score, 0);

  // a perfect bot with 40 ms reactions
  s = J(await post('/api/round/start', {}, t, '5.5.5.5')); clockMs += 62500;
  const bot = core.buildSchedule(s.seed).filter(e => e.type !== 'bunny').flatMap(e => e.type === 'tough' ? [[e.t + 40, e.hole], [e.t + 80, e.hole]] : [[e.t + 40, e.hole]]).filter(x => x[0] < 60000);
  r = await post('/api/round/finish', { roundId: s.roundId, taps: bot }, t, '5.5.5.5');
  assert.equal(r.statusCode, 422); assert.equal(J(r).code, 'rejected');

  // taps claimed later than real elapsed time
  s = J(await post('/api/round/start', {}, t, '5.5.5.5')); clockMs += 61100;
  r = await post('/api/round/finish', { roundId: s.roundId, taps: [[59900, 1]] }, t, '5.5.5.5');
  assert.equal(r.statusCode, 422);

  // third strike -> banned
  s = J(await post('/api/round/start', {}, t, '5.5.5.5')); clockMs += 62500;
  r = await post('/api/round/finish', { roundId: s.roundId, taps: [[500, 99]] }, t, '5.5.5.5');
  assert.equal(r.statusCode, 422); assert.equal(J(r).banned, true);
  const next = await post('/api/round/start', {}, t, '5.5.5.5');
  assert.equal(next.statusCode, 403);
  const cm = await pool.query("select coalesce(sum(total),0) t from country_month where country='BR'");
  assert.equal(Number(cm.rows[0].t), 0, 'rejected rounds never reach the country total');
  const rj = await pool.query("select count(*)::int n from rounds where status='rejected'");
  assert.equal(rj.rows[0].n >= 3, true, 'rejected rounds are kept for audit');
});

test('malformed tap logs are rejected, not crashed on', { skip }, async () => {
  const t = (await join('weirdo', 'DE', '6.6.6.6')).body.token;
  for (const bad of ['x', [[1]], [[1.5, 2]], [[70000, 1]], [[5, 99]], [[9, 1], [3, 1]], null]) {
    const s = J(await post('/api/round/start', {}, t, '6.6.6.6')); clockMs += 62500;
    const r = await post('/api/round/finish', { roundId: s.roundId, taps: bad }, t, '6.6.6.6');
    assert.ok([422, 403, 400].includes(r.statusCode), 'status ' + r.statusCode);
    await pool.query("update players set banned=false, strikes=0 where name='weirdo'");
  }
});

test('admin: rejecting a round takes the points back and fixes totals and best', { skip }, async () => {
  const { rejectRound } = require('../scripts/admin.js');
  const rng = core.mulberry32(77);
  const t = (await join('adminvictim', 'KR', '10.0.0.1')).body.token;
  const r1 = await playRound(t, (s) => humanLog(s, rng, 0.9), { ip: '10.0.0.1' });
  const r2 = await playRound(t, (s) => humanLog(s, rng, 0.4), { ip: '10.0.0.1' });
  assert.ok(r1.body.score > r2.body.score);
  const month = nowDate.toISOString().slice(0, 7);
  const q = async () => (await pool.query("select total::int, players, rounds from country_month where country='KR' and month=$1", [month])).rows[0];
  assert.equal((await q()).total, r1.body.score + r2.body.score);
  const id1 = (await pool.query("select id from rounds where score=$1 and player_id=(select id from players where name='adminvictim')", [r1.body.score])).rows[0].id;
  await rejectRound(pool, id1);
  assert.deepEqual(await q(), { total: r2.body.score, players: 1, rounds: 1 });
  const p = (await pool.query("select best_score, rounds from players where name='adminvictim'")).rows[0];
  assert.equal(p.best_score, r2.body.score); assert.equal(p.rounds, 1);
  const id2 = (await pool.query("select id from rounds where score=$1 and status<>'rejected' and player_id=(select id from players where name='adminvictim')", [r2.body.score])).rows[0].id;
  await rejectRound(pool, id2);
  assert.deepEqual(await q(), { total: 0, players: 0, rounds: 0 });
  assert.equal(await rejectRound(pool, id2), 'already rejected');
});

test('security headers are present', { skip }, async () => {
  const r = await get('/index.html');
  assert.ok(r.headers['content-security-policy'].includes("frame-ancestors 'self'"));
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('rate limit on join per IP', { skip }, async () => {
  let blocked = 0;
  for (let i = 0; i < 40; i++) { const r = await join('flood' + i + 'x', 'FR', '7.7.7.7'); if (r.res.statusCode === 429) blocked++; }
  assert.ok(blocked >= 9, 'blocked ' + blocked);
});

test('monthly reset: a new month starts at zero and the old one is archived', { skip }, async () => {
  const { archiveFinishedMonths } = require('../server/db.js');
  const before = J(await get('/api/state', null, '8.8.8.8'));
  assert.ok(before.countries.length >= 2);
  nowDate = new Date('2026-11-01T00:00:05Z');
  await new Promise(r => setTimeout(r, 3100));            // state cache is 3 s
  const after = J(await get('/api/state', null, '8.8.8.9'));
  assert.equal(after.month, '2026-11');
  assert.equal(after.countries.length, 0, 'everything starts at zero on the 1st');
  const done = await archiveFinishedMonths(pool, '2026-11');
  assert.deepEqual(done, ['2026-10']);
  const hof = await pool.query("select * from hall_of_fame where month='2026-10' order by rank");
  assert.ok(hof.rows.length >= 2 && hof.rows[0].rank === 1);
  assert.deepEqual(await archiveFinishedMonths(pool, '2026-11'), [], 'archiving is idempotent');
  const hall = J(await get('/api/hall-of-fame', null, '8.8.8.11'));
  assert.equal(hall.months[0].month, '2026-10'); assert.equal(hall.months[0].top[0].rank, 1);
  // player best round survives the reset (default scope = all time)
  const pl = J(await get('/api/players', null, '8.8.8.10'));
  assert.ok(pl.players.length >= 3);
  // playing in the new month starts the new total
  const t = (await join('november1', 'VN', '9.9.9.9')).body.token;
  const r = await playRound(t, (seed) => humanLog(seed, core.mulberry32(5), 0.7), { ip: '9.9.9.9' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.body.country.total, r.body.score);
  assert.equal(r.body.country.rank, 1);
});
