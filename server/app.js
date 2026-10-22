'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fastify = require('fastify');
const core = require('../shared/game-core.js');
const countries = require('../shared/countries.json');
const { checkName } = require('./names.js');

const COUNTRY_NAME = new Map(countries.map(c => [c.c, c.n]));
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const monthOf = (d) => d.toISOString().slice(0, 7);
function monthInfo(now) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const next = new Date(Date.UTC(y, m + 1, 1));
  return { month: monthOf(now), resetAt: next.toISOString(), daysLeft: Math.max(1, Math.ceil((next - now) / 86400000)) };
}

async function buildApp({ cfg, pool, redis, now = () => new Date(), clock = () => Date.now(), fetchImpl = fetch, logger = false }) {
  const app = fastify({ logger, trustProxy: cfg.trustProxy, bodyLimit: 32 * 1024 });

  /* ---------- security headers (also set here so they apply even without a reverse proxy) ---------- */
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com" + (cfg.cspScript ? ' ' + cfg.cspScript : ''),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:" + (cfg.cspImg ? ' ' + cfg.cspImg : ''),
    "connect-src 'self'" + (cfg.cspConnect ? ' ' + cfg.cspConnect : ''),
    "frame-src https://challenges.cloudflare.com" + (cfg.cspFrame ? ' ' + cfg.cspFrame : ''),
    "frame-ancestors 'self'", "base-uri 'none'", "form-action 'self'"
  ].join('; ');
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (!req.url.startsWith('/api/')) reply.header('content-security-policy', csp);
  });

  /* ---------- helpers ---------- */
  const ipOf = (req) => {
    if (cfg.behindCloudflare && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']);
    return req.ip;
  };
  const ipHash = (ip) => crypto.createHmac('sha256', cfg.hashSecret).update(ip).digest('hex').slice(0, 24);

  // fixed-window counter in Redis. returns true when the caller is still under the limit
  async function allow(key, max, windowSec) {
    const k = 'rl:' + key;
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, windowSec);
    return n <= max;
  }
  function tooMany(reply) {
    return reply.code(429).send({ error: 'Too many requests. Please slow down a little.' });
  }

  async function auth(req, reply) {
    const h = req.headers.authorization || '';
    const m = /^Bearer ([A-Za-z0-9_-]{30,80})$/.exec(h);
    if (!m) { reply.code(401).send({ error: 'Not signed in as a guest. Please start again.', code: 'no_token' }); return null; }
    const { rows } = await pool.query(
      'select id, name, country, rounds, best_score, banned, strikes from players where token_hash = $1', [sha(m[1])]);
    if (!rows.length) { reply.code(401).send({ error: 'Unknown guest. Please start again.', code: 'bad_token' }); return null; }
    return rows[0];
  }

  /* ---------- standings (cached for 3 s) ---------- */
  const cache = { c: null, cAt: 0 };
  async function standings(month) {
    const t = Date.now();
    if (cache.c && cache.month === month && t - cache.cAt < 3000) return cache.c;
    const { rows } = await pool.query(
      'select country, total::float8 as total, players, rounds from country_month where month = $1 and players >= 1 order by total desc, players desc, country asc', [month]);
    const list = rows.map(r => ({ c: r.country, n: COUNTRY_NAME.get(r.country) || r.country, total: Number(r.total), players: r.players, rounds: r.rounds }));
    cache.c = list; cache.cAt = t; cache.month = month;
    return list;
  }
  const invalidate = () => { cache.c = null; };

  async function playerRank(best, bestAt, scope, month) {
    if (!best) return null;
    if (scope === 'month') {
      const { rows } = await pool.query(
        `select count(*)::int + 1 as r from players where best_month = $1 and best_score > 0 and not banned
           and (best_score > $2 or (best_score = $2 and best_at < $3))`, [month, best, bestAt]);
      return rows[0].r;
    }
    const { rows } = await pool.query(
      `select count(*)::int + 1 as r from players where best_score > 0 and not banned
         and (best_score > $1 or (best_score = $1 and best_at < $2))`, [best, bestAt]);
    return rows[0].r;
  }

  /* ---------- routes ---------- */
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async () => ({
    turnstileSiteKey: cfg.turnstile.siteKey || null,
    playersBoardScope: cfg.playersBoardScope,
    duration: core.DURATION_MS
  }));

  // traffic source tag from ?utm_source=: lower-case letters, digits, _ . - only, max 32 chars; anything else becomes null
  function cleanSrc(v) {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_.-]{0,31}$/.test(s) ? s : null;
  }

  // become a guest player: no e-mail, no password. The browser keeps the secret token.
  app.post('/api/join', async (req, reply) => {
    const ip = ipOf(req);
    if (!(await allow('join:' + ip, cfg.rateLimits.joinPerIpPerHour, 3600))) return tooMany(reply);
    const b = req.body || {};
    const nm = checkName(b.name);
    if (!nm.ok) return reply.code(400).send({ error: nm.error, field: 'name' });
    if (typeof b.country !== 'string' || !COUNTRY_NAME.has(b.country.toUpperCase())) return reply.code(400).send({ error: 'Please choose your country.', field: 'country' });
    const country = b.country.toUpperCase();

    if (cfg.turnstile.secret) {
      let ok = false;
      try {
        const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: cfg.turnstile.secret, response: String(b.turnstile || ''), remoteip: ip })
        });
        ok = !!(await res.json()).success;
      } catch (e) { ok = false; }
      if (!ok) return reply.code(403).send({ error: 'Could not verify that you are human. Please try again.', code: 'turnstile' });
    }

    const secret = crypto.randomBytes(32).toString('base64url');
    try {
      const { rows } = await pool.query(
        'insert into players (token_hash, name, name_key, country, src) values ($1,$2,$3,$4,$5) returning id, name, country',
        [sha(secret), nm.name, nm.key, country, cleanSrc(b.src)]);
      return { token: secret, player: { name: rows[0].name, country: rows[0].country, best: 0, rounds: 0 } };
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'That name is already taken. Try another one.', field: 'name' });
      throw e;
    }
  });

  app.get('/api/me', async (req, reply) => {
    const p = await auth(req, reply); if (!p) return;
    await pool.query('update players set last_seen = now() where id = $1 and last_seen < now() - interval \'10 minutes\'', [p.id]);
    return { name: p.name, country: p.country, best: p.best_score, rounds: p.rounds, banned: p.banned };
  });

  // 1) ask for a round: the server picks the seed and remembers when it started
  app.post('/api/round/start', async (req, reply) => {
    const ip = ipOf(req);
    if (!(await allow('start:ip:' + ip, cfg.rateLimits.startPerIpPerMin, 60))) return tooMany(reply);
    const p = await auth(req, reply); if (!p) return;
    if (p.banned) return reply.code(403).send({ error: 'This player can no longer play.', code: 'banned' });
    if (!(await allow('start:p:' + p.id, cfg.rateLimits.startPerPlayerPerMin, 60))) return tooMany(reply);
    if (cfg.dailyRoundCap > 0) {
      const day = now().toISOString().slice(0, 10);
      const n = parseInt(await redis.get('cap:' + p.id + ':' + day) || '0', 10);
      if (n >= cfg.dailyRoundCap) return reply.code(429).send({ error: 'You reached the daily round limit. Come back tomorrow!', code: 'daily_cap' });
    }
    const seed = crypto.randomInt(1, 2 ** 32);
    const roundId = crypto.randomBytes(12).toString('base64url');
    const startedAt = clock();
    // one active round per player: starting a new one replaces (cancels) the old one
    await redis.set('round:' + p.id, JSON.stringify({ roundId, seed, startedAt }), 'EX', Math.ceil(cfg.roundMaxWallMs / 1000) + 30);
    return { roundId, seed, duration: core.DURATION_MS };
  });

  // 2) hand in the tap log: the server replays it and decides the score
  app.post('/api/round/finish', async (req, reply) => {
    const ip = ipOf(req);
    const p = await auth(req, reply); if (!p) return;
    if (!(await allow('finish:p:' + p.id, cfg.rateLimits.finishPerPlayerPerMin, 60))) return tooMany(reply);
    const b = req.body || {};
    if (typeof b.roundId !== 'string') return reply.code(400).send({ error: 'Bad request.' });

    // single use: GETDEL makes sure a round can be handed in only once
    const raw = await redis.getdel('round:' + p.id);
    if (!raw) return reply.code(409).send({ error: 'This round has expired or was already submitted.', code: 'no_round' });
    const r = JSON.parse(raw);
    if (r.roundId !== b.roundId) return reply.code(409).send({ error: 'This round was replaced by a newer one.', code: 'wrong_round' });

    const wall = clock() - r.startedAt;
    if (wall < cfg.roundMinWallMs) return reply.code(400).send({ error: 'That round was handed in too early.', code: 'too_early' });
    if (wall > cfg.roundMaxWallMs) return reply.code(409).send({ error: 'This round took too long and expired.', code: 'expired' });

    const rep = core.replay(r.seed, b.taps);
    let status = 'ok', flags = [];
    if (rep.error) { status = 'rejected'; flags = ['malformed:' + rep.error]; }
    else {
      // a tap cannot be later than the real time that passed (minus the ~2.3 s countdown)
      const lastTap = rep.tapTimes.length ? rep.tapTimes[rep.tapTimes.length - 1] : 0;
      if (lastTap > wall - 1500) { status = 'rejected'; flags = ['tap_after_wall_clock']; }
      else { const a = core.analyze(rep); status = a.verdict; flags = a.flags; }
    }

    const nowD = now(), month = monthOf(nowD);
    const before = await (async () => { cache.c = null; return standings(month); })();
    const rankBefore = before.findIndex(x => x.c === p.country);

    if (status === 'rejected') {
      const { rows } = await pool.query('update players set strikes = strikes + 1, banned = (strikes + 1 >= $2) where id = $1 returning banned, strikes', [p.id, cfg.maxStrikes]);
      await pool.query(
        `insert into rounds (player_id,country,month,seed,started_at,score,hits,taps,max_combo,status,flags,ip_hash,taps_json)
         values ($1,$2,$3,$4,to_timestamp($5/1000.0),0,0,0,0,'rejected',$6,$7,$8)`,
        [p.id, p.country, month, r.seed, r.startedAt, flags, ipHash(ip), JSON.stringify(Array.isArray(b.taps) ? b.taps.slice(0, core.MAX_TAPS) : null)]);
      return reply.code(422).send({ error: 'We could not verify this round, so it was not counted.', code: 'rejected', banned: rows[0].banned });
    }

    const client = await pool.connect();
    let out;
    try {
      await client.query('begin');
      await client.query(
        `insert into rounds (player_id,country,month,seed,started_at,score,hits,taps,max_combo,status,flags,ip_hash,taps_json)
         values ($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7,$8,$9,$10,$11,$12,$13)`,
        [p.id, p.country, month, r.seed, r.startedAt, rep.score, rep.hits, rep.taps, rep.maxCombo, status, flags, ipHash(ip), JSON.stringify(b.taps)]);
      const mp = await client.query('insert into month_players (month, player_id) values ($1,$2) on conflict do nothing', [month, p.id]);
      await client.query(
        `insert into country_month (month, country, total, players, rounds) values ($1,$2,$3,$4,1)
         on conflict (month, country) do update
           set total = country_month.total + excluded.total, players = country_month.players + excluded.players, rounds = country_month.rounds + 1`,
        [month, p.country, rep.score, mp.rowCount]);
      const up = await client.query(
        `update players set rounds = rounds + 1, last_seen = now(),
           best_score = case when $2 > best_score then $2 else best_score end,
           best_at    = case when $2 > best_score then now() else best_at end,
           best_month = case when $2 > best_score then $3 else best_month end
         where id = $1 returning rounds, best_score, best_at, best_month`, [p.id, rep.score, month]);
      await client.query('commit');
      out = up.rows[0];
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; }
    finally { client.release(); }

    if (cfg.dailyRoundCap > 0) {
      const k = 'cap:' + p.id + ':' + nowD.toISOString().slice(0, 10);
      await redis.incr(k); await redis.expire(k, 172800);
    }
    invalidate();
    const after = await standings(month);
    const rankAfter = after.findIndex(x => x.c === p.country);
    const mine = after[rankAfter];
    const aboveBefore = rankBefore >= 0 ? before.slice(0, rankBefore).map(x => x.c) : [];
    const aboveAfter = after.slice(0, rankAfter).map(x => x.c);
    const passed = aboveBefore.filter(c => !aboveAfter.includes(c)).map(c => ({ c, n: COUNTRY_NAME.get(c) }));
    const prevBest = p.best_score;
    const pr = await playerRank(out.best_score, out.best_at, cfg.playersBoardScope, month);
    const totalPlayers = (await pool.query(
      cfg.playersBoardScope === 'month'
        ? 'select count(*)::int n from players where best_score > 0 and not banned and best_month = $1'
        : 'select count(*)::int n from players where best_score > 0 and not banned', cfg.playersBoardScope === 'month' ? [month] : [])).rows[0].n;

    const stats = { hits: rep.hits, maxCombo: rep.maxCombo, accuracy: rep.taps ? rep.okTaps / rep.taps : 0 };
    let target = null;
    if (rankAfter > 0) { const rv = after[rankAfter - 1]; target = { type: 'chase', country: mine.n, rival: rv.n, need: rv.total - mine.total + 1 }; }
    else if (after.length > 1) target = { type: 'lead', country: mine.n, rival: after[1].n, lead: mine.total - after[1].total };

    return {
      score: rep.score, stats, status,
      player: { name: p.name, country: p.country, best: out.best_score, rounds: out.rounds, previousBest: prevBest, record: rep.score > prevBest, rank: pr, ranked: totalPlayers },
      country: { c: p.country, n: COUNTRY_NAME.get(p.country), total: mine ? mine.total : rep.score, players: mine ? mine.players : 1, rank: rankAfter + 1, of: after.length, rankBefore: rankBefore + 1 },
      passed, target
    };
  });

  app.get('/api/state', async (req, reply) => {
    if (!(await allow('read:' + ipOf(req), cfg.rateLimits.readPerIpPerMin, 60))) return tooMany(reply);
    const mi = monthInfo(now());
    reply.header('cache-control', 'public, max-age=3');
    return { ...mi, countries: await standings(mi.month) };
  });

  app.get('/api/players', async (req, reply) => {
    if (!(await allow('read:' + ipOf(req), cfg.rateLimits.readPerIpPerMin, 60))) return tooMany(reply);
    const mi = monthInfo(now());
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '15', 10) || 15));
    const q = cfg.playersBoardScope === 'month'
      ? await pool.query('select name, country, best_score from players where best_score > 0 and not banned and best_month = $1 order by best_score desc, best_at asc limit $2', [mi.month, limit])
      : await pool.query('select name, country, best_score from players where best_score > 0 and not banned order by best_score desc, best_at asc limit $1', [limit]);
    const list = q.rows.map((r, i) => ({ rank: i + 1, name: r.name, c: r.country, best: r.best_score }));
    let me = null;
    if (req.headers.authorization) {
      const m = /^Bearer ([A-Za-z0-9_-]{30,80})$/.exec(req.headers.authorization);
      if (m) {
        const { rows } = await pool.query('select name, country, best_score, best_at, best_month, banned from players where token_hash = $1', [sha(m[1])]);
        const p = rows[0];
        if (p && !p.banned && p.best_score > 0 && (cfg.playersBoardScope === 'all' || p.best_month === mi.month)) {
          me = { rank: await playerRank(p.best_score, p.best_at, cfg.playersBoardScope, mi.month), name: p.name, c: p.country, best: p.best_score };
        }
      }
    }
    return { scope: cfg.playersBoardScope, players: list, me };
  });

  // final standings of finished months (top 5 each)
  app.get('/api/hall-of-fame', async (req, reply) => {
    if (!(await allow('read:' + ipOf(req), cfg.rateLimits.readPerIpPerMin, 60))) return tooMany(reply);
    const { rows } = await pool.query(
      `select month, rank, country, total::float8 as total, players from hall_of_fame
       where rank <= 5 and month in (select month from hall_of_fame group by month order by month desc limit 12) order by month desc, rank asc`);
    const byMonth = {};
    rows.forEach(r => { (byMonth[r.month] = byMonth[r.month] || []).push({ rank: r.rank, c: r.country, n: COUNTRY_NAME.get(r.country) || r.country, total: Number(r.total), players: r.players }); });
    reply.header('cache-control', 'public, max-age=300');
    return { months: Object.keys(byMonth).sort().reverse().map(m => ({ month: m, top: byMonth[m] })) };
  });

  /* ---------- static files (the game itself) ---------- */
  await app.register(require('@fastify/static'), { root: cfg.staticDir, prefix: '/', index: ['index.html'], maxAge: '5m' });
  await app.register(require('@fastify/static'), { root: cfg.sharedDir, prefix: '/shared/', decorateReply: false, maxAge: '5m' });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation || err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY') return reply.code(400).send({ error: 'Bad request.' });
    if (err.statusCode === 413) return reply.code(413).send({ error: 'Request too large.' });
    req.log.error(err);
    reply.code(500).send({ error: 'Something went wrong on our side. Please try again.' });
  });

  return app;
}

module.exports = { buildApp, monthOf, monthInfo };
