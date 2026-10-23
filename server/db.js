'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function makePool(url) { return new Pool({ connectionString: url, max: 10 }); }

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Monthly bookkeeping. Totals never need a "reset" job: every row is keyed by month, so a new month simply starts at 0.
// This job only (a) freezes the final standings of finished months into hall_of_fame and (b) deletes old data.
async function archiveFinishedMonths(pool, currentMonth) {
  const { rows } = await pool.query(
    `select distinct month from country_month where month < $1 and month not in (select distinct month from hall_of_fame)`, [currentMonth]);
  for (const { month } of rows) {
    await pool.query(
      `insert into hall_of_fame (month, rank, country, total, players)
       select month, row_number() over (order by total desc, players desc, country asc), country, total, players
       from country_month where month = $1 and players >= 1 on conflict do nothing`, [month]);
  }
  return rows.map(r => r.month);
}

async function retention(pool, r) {
  const a = await pool.query(`update rounds set taps_json = null where taps_json is not null and finished_at < now() - ($1 || ' days')::interval and status = 'ok'`, [String(r.tapLogDays)]);
  const b = await pool.query(`delete from players where rounds = 0 and created_at < now() - ($1 || ' hours')::interval`, [String(r.emptyGuestHours)]);
  const c = await pool.query(`delete from players where last_seen < now() - ($1 || ' days')::interval and best_score < 5`, [String(r.inactiveGuestDays)]);
  const d = await pool.query(`delete from visits where day < (now() at time zone 'utc')::date - $1::int`, [r.visitDays || 400]);
  return { tapLogsWiped: a.rowCount, emptyGuestsRemoved: b.rowCount, inactiveGuestsRemoved: c.rowCount, visitRowsRemoved: d.rowCount };
}

module.exports = { makePool, migrate, archiveFinishedMonths, retention };
