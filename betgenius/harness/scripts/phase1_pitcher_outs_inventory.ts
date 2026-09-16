#!/usr/bin/env -S deno run --no-check --allow-net --allow-env --allow-read
// Read-only: pitcher_outs warehouse vs market_config.warehouseOddsAvailable=false.
// Also probes SELECT grants needed for game-market context.

import { closePool, getDbFromEnv } from "../lib/env.ts";

function denied(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.toLowerCase().includes("permission denied");
}

const db = getDbFromEnv();
try {
  const keys = await db.query<{ market_key: string; rows: string; events: string; first_game: string | null; last_game: string | null }>(
    `SELECT market_key,
            COUNT(*)::text AS rows,
            COUNT(DISTINCT event_id)::text AS events,
            MIN(commence_time)::date::text AS first_game,
            MAX(commence_time)::date::text AS last_game
     FROM cache_mlb_historical_odds
     WHERE market_key ILIKE '%pitcher%out%'
        OR market_key ILIKE '%pitcher_outs%'
        OR market_key = 'pitcher_outs'
        OR market_key ILIKE '%outs%'
     GROUP BY market_key
     ORDER BY COUNT(*) DESC`,
  );

  const exact = await db.query<{ rows: string; events: string; first_game: string | null; last_game: string | null }>(
    `SELECT COUNT(*)::text AS rows,
            COUNT(DISTINCT event_id)::text AS events,
            MIN(commence_time)::date::text AS first_game,
            MAX(commence_time)::date::text AS last_game
     FROM cache_mlb_historical_odds
     WHERE market_key = 'pitcher_outs'`,
  );

  const ph = await db.query<{ rows: string; first_game: string | null; last_game: string | null }>(
    `SELECT COUNT(*)::text AS rows,
            MIN(game_date)::text AS first_game,
            MAX(game_date)::text AS last_game
     FROM pick_history
     WHERE sport = 'mlb'
       AND mlb_market_type = 'pitcher_outs'
       AND COALESCE(is_synthetic, false) = false
       AND COALESCE(voided, false) = false`,
  );

  async function probe(label: string, sql: string): Promise<string> {
    try {
      await db.query(sql);
      return "SELECT ok";
    } catch (e) {
      return denied(e) ? "PERMISSION DENIED" : (e instanceof Error ? e.message : String(e));
    }
  }

  const grants = {
    cache_mlb_historical_odds: await probe("odds", "SELECT 1 FROM cache_mlb_historical_odds LIMIT 1"),
    cache_mlb_historical_outcomes: await probe("outcomes", "SELECT 1 FROM cache_mlb_historical_outcomes LIMIT 1"),
    cache_mlb_historical_bullpen: await probe("bullpen", "SELECT 1 FROM cache_mlb_historical_bullpen LIMIT 1"),
    cache_mlb_boxscore_player_stats: await probe("boxscore", "SELECT 1 FROM cache_mlb_boxscore_player_stats LIMIT 1"),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    marketConfig: {
      cliMarket: "pitcher_outs",
      oddsMarketKey: "pitcher_outs",
      allowedSources: ["pick_history"],
      warehouseOddsAvailable: false,
    },
    warehouseExactKey_pitcher_outs: exact[0] ?? null,
    warehouseKeysMatchingOutsOrPitcher: keys,
    pickHistory_pitcher_outs: ph[0] ?? null,
    harnessReadonlyGrants: grants,
    recommendation:
      exact[0] && parseInt(exact[0].rows, 10) > 0
        ? "Warehouse rows exist. market_config still warehouseOddsAvailable=false / pick_history-only. Do not flip the flag until a warehouse backtest is gated. Do not re-score."
        : "No warehouse rows on market_key=pitcher_outs. Keep pick_history-only. Check warehouseKeysMatchingOutsOrPitcher for aliases.",
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  await closePool();
}
