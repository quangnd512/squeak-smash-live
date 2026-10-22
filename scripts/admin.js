#!/usr/bin/env node
// Small admin tool. On the VPS:  docker compose exec api node scripts/admin.js <command>
//   suspects [n]          list the latest rounds that looked odd (default 30)
//   reject-round <id>     take one round back: removes its points from the country total, fixes the player's best
//   ban <name>            player can no longer play and disappears from the Players board
//   unban <name>
//   purge <name>          ban + take back ALL of that player's rounds
//   stats                 quick numbers for today / this month
const { makePool } = require('../server/db.js');
const cfg = require('../server/config.js');

async function rejectRound(pool, id) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const { rows } = await c.query('select id, player_id, country, month, score, status from rounds where id = $1 for update', [id]);
    const r = rows[0];
    if (!r) throw new Error('no such round');
    if (r.status === 'rejected') { await c.query('rollback'); return 'already rejected'; }
    await c.query("update rounds set status = 'rejected', flags = flags || array['manual'] where id = $1", [id]);
    await c.query('update country_month set total = total - $3, rounds = rounds - 1 where month = $1 and country = $2', [r.month, r.country, r.score]);
    const still = await c.query("select 1 from rounds where player_id = $1 and month = $2 and status <> 'rejected' limit 1", [r.player_id, r.month]);
    if (!still.rowCount) {
      await c.query('delete from month_players where month = $1 and player_id = $2', [r.month, r.player_id]);
      await c.query('update country_month set players = players - 1 where month = $1 and country = $2', [r.month, r.country]);
    }
    const best = await c.query("select score, finished_at, month from rounds where player_id = $1 and status <> 'rejected' order by score desc, finished_at asc limit 1", [r.player_id]);
    const b = best.rows[0];
    await c.query('update players set rounds = greatest(rounds - 1, 0), best_score = $2, best_at = $3, best_month = $4 where id = $1',
      [r.player_id, b ? b.score : 0, b ? b.finished_at : null, b ? b.month : null]);
    await c.query('commit');
    return 'rejected round ' + id + ' (-' + r.score + ' points for ' + r.country + ')';
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const pool = makePool(cfg.databaseUrl);
  try {
    if (cmd === 'suspects') {
      const { rows } = await pool.query(
        `select r.id, p.name, r.country, r.score, r.status, array_to_string(r.flags, ',') flags, to_char(r.finished_at, 'YYYY-MM-DD HH24:MI') at
         from rounds r join players p on p.id = r.player_id where r.status <> 'ok' order by r.finished_at desc limit $1`, [parseInt(arg || '30', 10)]);
      console.table(rows);
    } else if (cmd === 'reject-round') {
      console.log(await rejectRound(pool, parseInt(arg, 10)));
    } else if (cmd === 'ban' || cmd === 'unban') {
      const r = await pool.query(cmd === 'ban' ? 'update players set banned = true where name_key = $1' : 'update players set banned = false, strikes = 0 where name_key = $1', [String(arg).toLowerCase()]);
      console.log(r.rowCount ? cmd + ' ok' : 'no such player');
    } else if (cmd === 'purge') {
      const p = await pool.query('update players set banned = true where name_key = $1 returning id', [String(arg).toLowerCase()]);
      if (!p.rowCount) { console.log('no such player'); return; }
      const ids = await pool.query("select id from rounds where player_id = $1 and status <> 'rejected'", [p.rows[0].id]);
      for (const { id } of ids.rows) console.log(await rejectRound(pool, id));
      console.log('purged', ids.rowCount, 'rounds');
    } else if (cmd === 'stats') {
      const a = await pool.query("select count(*)::int rounds, count(distinct player_id)::int players, coalesce(sum(score),0)::int points from rounds where status <> 'rejected' and finished_at > now() - interval '24 hours'");
      const b = await pool.query("select count(*)::int players_total, count(*) filter (where created_at > now() - interval '24 hours')::int new_24h from players");
      const c = await pool.query("select count(*)::int suspect from rounds where status = 'suspect' and finished_at > now() - interval '24 hours'");
      const d = await pool.query("select count(*)::int rejected from rounds where status = 'rejected' and finished_at > now() - interval '24 hours'");
      console.table([{ ...a.rows[0], ...b.rows[0], ...c.rows[0], ...d.rows[0] }]);
    } else if (cmd === 'sources') {
      // which traffic source brings players who stay? "back" = played again on a later UTC day than the sign-up day
      const days = parseInt(arg, 10) || 30;
      const q = await pool.query(`
        select coalesce(p.src, '(none)') as source,
               count(*)::int as new_players,
               count(*) filter (where p.rounds >= 3)::int as three_plus_rounds,
               count(*) filter (where exists (select 1 from rounds r where r.player_id = p.id and r.status <> 'rejected'
                                              and (r.finished_at at time zone 'UTC')::date > (p.created_at at time zone 'UTC')::date))::int as came_back,
               round(100.0 * count(*) filter (where exists (select 1 from rounds r where r.player_id = p.id and r.status <> 'rejected'
                                              and (r.finished_at at time zone 'UTC')::date > (p.created_at at time zone 'UTC')::date)) / count(*), 1) as back_pct
          from players p
         where p.created_at > now() - ($1 || ' days')::interval and not p.banned
         group by 1 order by new_players desc`, [String(days)]);
      console.table(q.rows);
    } else {
      console.log('commands: suspects [n] | reject-round <id> | ban <name> | unban <name> | purge <name> | stats | sources [days]');
    }
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { rejectRound };
