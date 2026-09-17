// Phase 1 probe -- READ ONLY. Is the 2026-05-24 stop in dump_odds.ts a real
// warehouse limit or just a hardcoded constant? And how far do the events and
// box-score tables actually run?
//
// Writes nothing. Six SELECTs, aggregate only.
//
//   deno run --no-check --allow-net --allow-env --allow-read harness/uplift/probe_warehouse.ts
import { closePool, getDbFromEnv } from "../lib/env.ts";

const db = getDbFromEnv();

async function show(label: string, sql: string) {
  try {
    const r = await db.query(sql);
    console.log(`\n=== ${label} ===`);
    for (const row of r) console.log(JSON.stringify(row));
  } catch (e) {
    console.log(`\n=== ${label} ===\nERROR ${String(e).slice(0, 160)}`);
  }
}

await show(
  "cache_mlb_historical_odds -- overall span and snapshot coverage",
  `select min(commence_time)::text as first_commence,
          max(commence_time)::text as last_commence,
          min(snapshot_timestamp)::text as first_snap,
          max(snapshot_timestamp)::text as last_snap,
          count(*) as rows,
          count(distinct event_id) as events,
          count(distinct market_key) as markets
     from cache_mlb_historical_odds`,
);

await show(
  "odds rows by month (last 18 months present)",
  `select to_char(commence_time,'YYYY-MM') as ym,
          count(*) as rows, count(distinct event_id) as events,
          count(distinct market_key) as markets,
          round(avg(extract(epoch from (commence_time - snapshot_timestamp))/3600.0)::numeric,1) as avg_lead_hours,
          count(distinct snapshot_timestamp) as snaps
     from cache_mlb_historical_odds
    group by 1 order by 1 desc limit 18`,
);

await show(
  "snapshots per event -- can line movement be reconstructed?",
  `select market_key,
          count(*) as rows,
          round(avg(n)::numeric,2) as avg_snaps_per_event,
          max(n) as max_snaps_per_event
     from (select market_key, event_id, count(distinct snapshot_timestamp) as n
             from cache_mlb_historical_odds group by 1,2) t
    group by 1 order by 2 desc limit 15`,
);

await show(
  "cache_mlb_historical_events -- how far does the event list run?",
  `select to_char(commence_time,'YYYY-MM') as ym, count(*) as events,
          count(game_pk) as with_game_pk
     from cache_mlb_historical_events
    group by 1 order by 1 desc limit 15`,
);

await show(
  "cache_mlb_boxscore_player_stats -- span and the two null columns",
  `select to_char(game_date::timestamp,'YYYY-MM') as ym,
          count(*) as rows,
          count(distinct game_pk) as games,
          count(runs_scored) as runs_scored_nn,
          count(batter_strikeouts) as batter_k_nn,
          count(hits) as hits_nn
     from cache_mlb_boxscore_player_stats
    group by 1 order by 1 desc limit 15`,
);

await show(
  "market_key inventory",
  `select market_key, count(*) as rows, min(commence_time)::text as first,
          max(commence_time)::text as last
     from cache_mlb_historical_odds group by 1 order by 2 desc limit 25`,
);

await closePool();
