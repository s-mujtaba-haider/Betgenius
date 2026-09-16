#!/usr/bin/env -S deno run --no-check --allow-net --allow-env --allow-read
/** Count distinct snapshot_timestamp per (event, player, line) in warehouse. */
import { closePool, getDbFromEnv } from "../lib/env.ts";

const market = Deno.args[0] ?? "batter_hits";
const start = Deno.args[1] ?? "2026-04-25";
const end = Deno.args[2] ?? "2026-05-24";

const db = getDbFromEnv();
const dist = await db.query<{ snap_n: string; cnt: string }>(
  `SELECT snap_n::text, COUNT(*)::text AS cnt
   FROM (
     SELECT COUNT(DISTINCT snapshot_timestamp) AS snap_n
     FROM cache_mlb_historical_odds
     WHERE market_key = $1
       AND commence_time >= $2::timestamptz
       AND commence_time < $3::timestamptz
     GROUP BY event_id, player_name, line
   ) sub
   GROUP BY snap_n
   ORDER BY snap_n::int`,
  [market, start, end],
);

console.log(JSON.stringify({ market, window: `${start}..${end}`, distribution: dist }, null, 2));
await closePool();
