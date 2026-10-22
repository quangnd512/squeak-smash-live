-- Squeak Smash! schema. Safe to run many times (everything is IF NOT EXISTS).

create table if not exists players (
  id          bigserial primary key,
  token_hash  bytea       not null unique,          -- sha256 of the secret the browser keeps; the secret itself is never stored
  name        text        not null,
  name_key    text        not null unique,          -- lower-cased, used for the "name is taken" check
  country     char(2)     not null,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  rounds      integer     not null default 0,
  best_score  integer     not null default 0,
  best_at     timestamptz,
  best_month  char(7),
  strikes     integer     not null default 0,       -- rejected rounds
  banned      boolean     not null default false
);
-- where the player came from (first visit's ?utm_source=, e.g. "reddit_ph"). A marketing tag only, never personal data.
alter table players add column if not exists src text;
create index if not exists players_best_idx   on players (best_score desc, best_at asc) where best_score > 0 and not banned;
create index if not exists players_bestm_idx   on players (best_month, best_score desc, best_at asc) where best_score > 0 and not banned;
create index if not exists players_lastseen_idx on players (last_seen);

create table if not exists rounds (
  id           bigserial primary key,
  player_id    bigint      not null references players(id) on delete cascade,
  country      char(2)     not null,
  month        char(7)     not null,                -- YYYY-MM in UTC
  seed         bigint      not null,
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  score        integer     not null,
  hits         integer     not null,
  taps         integer     not null,
  max_combo    integer     not null,
  status       text        not null check (status in ('ok','suspect','rejected')),
  flags        text[]      not null default '{}',
  ip_hash      text,
  taps_json    jsonb                                -- kept for audits, wiped by the retention job
);
create index if not exists rounds_month_idx  on rounds (month, country);
create index if not exists rounds_player_idx on rounds (player_id, finished_at desc);
create index if not exists rounds_status_idx on rounds (status) where status <> 'ok';

-- authoritative monthly numbers, one row per country per month
create table if not exists country_month (
  month    char(7)  not null,
  country  char(2)  not null,
  total    bigint   not null default 0,
  players  integer  not null default 0,             -- different players who played this month
  rounds   integer  not null default 0,
  primary key (month, country)
);
create index if not exists country_month_rank_idx on country_month (month, total desc);

create table if not exists month_players (
  month      char(7) not null,
  player_id  bigint  not null references players(id) on delete cascade,
  primary key (month, player_id)
);

-- final standings of finished months (the "Hall of Fame")
create table if not exists hall_of_fame (
  month    char(7)  not null,
  rank     integer  not null,
  country  char(2)  not null,
  total    bigint   not null,
  players  integer  not null,
  primary key (month, rank)
);
