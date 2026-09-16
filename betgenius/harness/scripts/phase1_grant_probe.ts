#!/usr/bin/env -S deno run --no-check --allow-net --allow-env --allow-read
// Read-only SELECT probes for Phase 1 game-market tables. No secrets printed.

import { closePool, getDbFromEnv } from "../lib/env.ts";

function denied(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.toLowerCase().includes("permission denied");
}

const db = getDbFromEnv();

async function probe(
  sql: string,
): Promise<{ ok: true; row: unknown } | { ok: false; denied: boolean; err: string }> {
  try {
    const r = await db.query(sql);
    return { ok: true, row: r[0] ?? null };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, denied: denied(e), err: err.slice(0, 200) };
  }
}

try {
  const report = {
    generatedAt: new Date().toISOString(),
    cache_mlb_historical_outcomes: await probe(
      "SELECT COUNT(*)::int AS n FROM cache_mlb_historical_outcomes",
    ),
    cache_mlb_historical_bullpen: await probe(
      "SELECT COUNT(*)::int AS n FROM cache_mlb_historical_bullpen",
    ),
    cache_mlb_historical_pitcher_statcast: await probe(
      "SELECT COUNT(*)::int AS n FROM cache_mlb_historical_pitcher_statcast",
    ),
    cache_mlb_boxscore_player_stats: await probe(
      "SELECT COUNT(*)::int AS n FROM cache_mlb_boxscore_player_stats",
    ),
    cache_mlb_pitcher_season_stats: await probe(
      "SELECT COUNT(*)::int AS n FROM cache_mlb_pitcher_season_stats",
    ),
    recommendations_cache: await probe("SELECT 1 AS n FROM recommendations_cache LIMIT 1"),
    totals_warehouse: await probe(
      `SELECT COUNT(*)::int AS n,
              MIN(commence_time)::text AS mn,
              MAX(commence_time)::text AS mx
       FROM cache_mlb_historical_odds WHERE market_key = 'totals'`,
    ),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await closePool();
}
