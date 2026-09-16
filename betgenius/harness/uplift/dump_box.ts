// Phase 1 uplift — dump every MLB box-score player line, read-only.
//
// game_date is pulled as ::text ON PURPOSE. Read as a timestamp it arrives
// shifted by the client timezone, which moves a late start across midnight and
// lets an as-of join match a game to its OWN box score. Everything downstream
// joins on the local calendar date string.
import { closePool, getDbFromEnv } from "../lib/env.ts";
import { writeCsv } from "./csv.ts";

const db = getDbFromEnv();
const rows = await db.query<Record<string, unknown>>(`
  select b.player_id, b.game_pk, b.game_date::text as game_date, b.team_id,
         b.player_name, b.position_type, b.is_starter, b.batting_order_slot,
         b.at_bats, b.hits, b.home_runs, b.total_bases, b.rbi, b.plate_appearances,
         b.runs_scored, b.batter_strikeouts, b.batter_walks,
         b.innings_pitched, b.pitches_thrown, b.strikeouts, b.walks,
         b.batters_faced, b.pitcher_runs, b.pitcher_earned_runs, b.outs
    from cache_mlb_boxscore_player_stats b
   order by b.game_date, b.game_pk, b.player_id`);
console.log(`[box] ${rows.length} rows`);
await writeCsv("harness/uplift/data/boxscores.csv", rows);
await closePool();
