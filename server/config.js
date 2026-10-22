const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

module.exports = {
  port: int(env.PORT, 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://squeak:squeak@localhost:5432/squeak',
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',
  // server-side secret used to hash IP addresses (so the raw IP is never stored)
  hashSecret: env.HASH_SECRET || 'dev-only-change-me',
  behindCloudflare: bool(env.BEHIND_CLOUDFLARE, false),
  trustProxy: bool(env.TRUST_PROXY, true),
  turnstile: { siteKey: env.TURNSTILE_SITE_KEY || '', secret: env.TURNSTILE_SECRET || '' },
  // Players board: 'all' = best round ever, 'month' = best round this month
  playersBoardScope: env.PLAYERS_BOARD_SCOPE === 'month' ? 'month' : 'all',
  // timing rules for a round (ms)
  roundMinWallMs: int(env.ROUND_MIN_WALL_MS, 61000),     // countdown + 60 s of play, minus slack
  roundMaxWallMs: int(env.ROUND_MAX_WALL_MS, 150000),
  // optional anti-abuse cap, 0 = off. Rounds that count towards the country total per player per UTC day.
  dailyRoundCap: int(env.DAILY_ROUND_CAP, 0),
  rateLimits: {
    joinPerIpPerHour: int(env.RL_JOIN_IP_HOUR, 30),
    startPerPlayerPerMin: int(env.RL_START_PLAYER_MIN, 12),
    startPerIpPerMin: int(env.RL_START_IP_MIN, 120),
    finishPerPlayerPerMin: int(env.RL_FINISH_PLAYER_MIN, 12),
    readPerIpPerMin: int(env.RL_READ_IP_MIN, 240)
  },
  maxStrikes: int(env.MAX_STRIKES, 5),
  retention: {
    tapLogDays: int(env.TAPLOG_RETENTION_DAYS, 30),
    emptyGuestHours: int(env.EMPTY_GUEST_HOURS, 24),
    inactiveGuestDays: int(env.INACTIVE_GUEST_DAYS, 365)
  },
  // extra Content-Security-Policy sources, e.g. for Google AdSense once you add ads (see README)
  cspScript: env.CSP_SCRIPT || '', cspImg: env.CSP_IMG || '', cspConnect: env.CSP_CONNECT || '', cspFrame: env.CSP_FRAME || '',
  staticDir: env.STATIC_DIR || require('path').join(__dirname, '..', 'public'),
  sharedDir: require('path').join(__dirname, '..', 'shared')
};
