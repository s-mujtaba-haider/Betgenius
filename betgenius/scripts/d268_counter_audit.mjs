#!/usr/bin/env node
// D-268 counter audit — query DB and compare to Dashboard counters.
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local at runtime.
// No credentials embedded in source.

import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^export\s+/, "").split("="))
    .map(([k, ...rest]) => [k, rest.join("=").replace(/^"|"$/g, "")])
);

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE) {
  console.error("missing supabase env");
  process.exit(1);
}

const HEADERS = {
  apikey: SERVICE,
  Authorization: `Bearer ${SERVICE}`,
  Accept: "application/json",
};

async function rpc(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

const today = process.argv[2] || "2026-05-19";

for (const sport of ["nba", "mlb"]) {
  console.log(`\n===== ${sport.toUpperCase()} (game_date=${today}) =====`);

  const all = await rpc("recommendations_cache", `game_date=eq.${today}&sport=eq.${sport}&select=id,game_id,prop_type,confidence,player_name,is_secondary_market&limit=2000`);
  console.log(`  total recommendations_cache rows: ${all.length}`);

  const gameLevelTypes = ["spread", "game_total", "h2h", "spreads", "totals"];
  const playerProps = all.filter((r) => !gameLevelTypes.includes(r.prop_type));
  console.log(`  player props (Dashboard universe): ${playerProps.length}`);

  const distinctGames = new Set(playerProps.map((r) => r.game_id).filter(Boolean));
  console.log(`  distinct game_id (from player props): ${distinctGames.size}`);

  const allDistinctGames = new Set(all.map((r) => r.game_id).filter(Boolean));
  console.log(`  distinct game_id (ALL rows incl game-level): ${allDistinctGames.size}`);

  const confGte65 = playerProps.filter((r) => r.confidence >= 65);
  console.log(`  conf>=65 ALL (raw Recommendations counter): ${confGte65.length}`);
  const confGte65NoSecondary = playerProps.filter((r) => r.confidence >= 65 && !r.is_secondary_market);
  console.log(`  conf>=65 minus secondary (Dashboard Recommendations counter): ${confGte65NoSecondary.length}`);

  const confGte60 = playerProps.filter((r) => r.confidence >= 60);
  console.log(`  conf>=60 ALL: ${confGte60.length}`);
  const confGte60NoSecondary = playerProps.filter((r) => r.confidence >= 60 && !r.is_secondary_market);
  console.log(`  conf>=60 minus secondary (All Picks visible): ${confGte60NoSecondary.length}`);

  const gameLevel = all.filter((r) => gameLevelTypes.includes(r.prop_type));
  console.log(`  game-level picks: ${gameLevel.length}`);
  const byType = {};
  for (const r of gameLevel) byType[r.prop_type] = (byType[r.prop_type] ?? 0) + 1;
  console.log(`    by prop_type: ${JSON.stringify(byType)}`);

  const sampleTypes = new Set(all.map((r) => r.prop_type));
  console.log(`  ALL distinct prop_types: ${[...sampleTypes].sort().join(", ")}`);
}

const errorRows = await rpc("error_log", `function_name=eq.anthropic_mlb&created_at=gte.2026-05-18&select=function_name,error_type,created_at&limit=10`);
console.log(`\n===== anthropic_mlb error_log rows (since 2026-05-18) =====`);
console.log(`  count: ${errorRows.length}`);
for (const r of errorRows.slice(0, 5)) console.log(`    ${r.created_at} | ${r.error_type}`);
