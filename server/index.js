'use strict';
const cfg = require('./config.js');
const Redis = require('ioredis');
const { makePool, migrate, archiveFinishedMonths, retention } = require('./db.js');
const { buildApp, monthOf } = require('./app.js');

async function main() {
  if (process.env.NODE_ENV === 'production' && cfg.hashSecret === 'dev-only-change-me') {
    console.error('Refusing to start: set HASH_SECRET in .env'); process.exit(1);
  }
  const pool = makePool(cfg.databaseUrl);
  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2 });
  for (let i = 0; ; i++) {                       // wait for the database container on first boot
    try { await migrate(pool); break; } catch (e) { if (i > 30) throw e; console.log('waiting for database...', e.code || e.message); await new Promise(r => setTimeout(r, 2000)); }
  }
  const app = await buildApp({ cfg, pool, redis, logger: { level: 'info', redact: ['req.headers.authorization'] } });

  const housekeeping = async () => {
    try {
      const done = await archiveFinishedMonths(pool, monthOf(new Date()));
      if (done.length) app.log.info({ archived: done }, 'archived finished months');
      const r = await retention(pool, cfg.retention);
      app.log.info(r, 'retention job');
    } catch (e) { app.log.error(e, 'housekeeping failed'); }
  };
  await housekeeping();
  const timer = setInterval(housekeeping, 3600 * 1000);

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  const stop = async () => { clearInterval(timer); await app.close(); await pool.end(); redis.disconnect(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(e => { console.error(e); process.exit(1); });
