// Phase 1 -- the event list, so an Odds API pull can be joined to a box score.
//
// READ ONLY. `cache_mlb_historical_events` carries the event_id <-> game_pk
// bridge, and without it an API row cannot be graded: the provider knows its own
// event id and the team names, and nothing else.
//
// The table runs to 2026-06. Beyond that the bridge has to be rebuilt from team
// names and the local calendar date, which ingest_expand.py does.
//
//   deno run --no-check --allow-net --allow-env --allow-read --allow-write \
//     harness/uplift/dump_events.ts
import { closePool, getDbFromEnv } from "../lib/env.ts";
import { writeCsv } from "./csv.ts";

const db = getDbFromEnv();
const rows = await db.query(
  `select event_id, game_pk, commence_time::text as commence_time,
          home_team, away_team
     from cache_mlb_historical_events
    order by commence_time, event_id`,
);
await closePool();
await writeCsv("harness/uplift/data/aux_events.csv", rows as Record<string, unknown>[]);
console.log(`[events] ${rows.length} rows -> harness/uplift/data/aux_events.csv`);
