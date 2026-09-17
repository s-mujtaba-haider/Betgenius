// READ ONLY. What lead time is the WAREHOUSE entry price actually taken at?
//
// dump_odds.ts defines the entry snapshot as min(snapshot_timestamp) strictly
// before commence_time -- the EARLIEST price the warehouse holds, not the last.
// The API pulls added in this round are taken at commence - 1h, the convention
// ingest_odds_api.ts used. If those two leads differ materially then the
// expanded dataset mixes two price conventions, and any before/after comparison
// is measuring that mismatch rather than the extra data.
//
//   deno run --no-check --allow-net --allow-env --allow-read harness/uplift/probe_entry_lead.ts
import { closePool, getDbFromEnv } from "../lib/env.ts";

const db = getDbFromEnv();
const sql = `
  with snap as (
    select event_id, market_key, min(snapshot_timestamp) as entry_snap,
           min(commence_time) as commence
      from cache_mlb_historical_odds
     where snapshot_timestamp < commence_time
     group by 1,2
  )
  select to_char(commence,'YYYY-MM') as ym,
         market_key,
         count(*) as events,
         round(avg(extract(epoch from (commence - entry_snap))/3600.0)::numeric,2) as avg_lead_h,
         round(percentile_cont(0.5) within group (
           order by extract(epoch from (commence - entry_snap))/3600.0)::numeric,2) as median_lead_h,
         round(min(extract(epoch from (commence - entry_snap))/3600.0)::numeric,2) as min_lead_h,
         round(max(extract(epoch from (commence - entry_snap))/3600.0)::numeric,2) as max_lead_h
    from snap
   where market_key in ('batter_hits','h2h','pitcher_strikeouts')
   group by 1,2
   order by 1 desc, 2
   limit 40`;
const r = await db.query(sql);
console.log("=== warehouse ENTRY snapshot lead (hours before first pitch) ===");
for (const row of r) console.log(JSON.stringify(row));
await closePool();
