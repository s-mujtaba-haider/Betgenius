#!/usr/bin/env node
// D-388 — new-lines gap test. Are there (player, prop, side) tuples in
// props_cache that DON'T appear in rec_cache today? Those would be
// "new lines added intraday that never got scored / displayed."
// Also test the inverse: does created_at preservation correctly identify
// the "frozen UX" symptom?

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const todayCompact = today.replace(/-/g, "");

  // Distinct (player_name, prop_type, pick_side) tuples in props_cache today (across all bookmakers)
  console.log("=== (1) Distinct (player|prop|side) tuples in props_cache today (player props only) ===");
  const pp = await rest(`props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&prop_type=in.%28hits%2Chome_runs%2Ctotal_bases%2Crbis%2Cpitcher_strikeouts%29&select=player_name,prop_type,pick_side,first_seen,last_seen&limit=10000`);
  if (pp.error) { console.error(pp.error); return; }
  const ppTuples = new Map();
  for (const r of pp.data) {
    const k = `${r.player_name}|${r.prop_type}|${r.pick_side}`;
    if (!ppTuples.has(k)) ppTuples.set(k, { earliest_first_seen: r.first_seen, latest_last_seen: r.last_seen });
    else {
      const e = ppTuples.get(k);
      if (r.first_seen < e.earliest_first_seen) e.earliest_first_seen = r.first_seen;
      if (r.last_seen > e.latest_last_seen) e.latest_last_seen = r.last_seen;
    }
  }
  console.log(`  props_cache rows (player markets): ${pp.data.length}`);
  console.log(`  distinct (player|prop|side) tuples: ${ppTuples.size}`);

  // Distinct tuples in rec_cache today (player props)
  const rc = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&prop_type=in.%28hits%2Chome_runs%2Ctotal_bases%2Crbis%2Cpitcher_strikeouts%29&select=player_name,prop_type,pick_side,created_at&limit=10000`);
  if (rc.error) { console.error(rc.error); return; }
  const rcTuples = new Set();
  for (const r of rc.data) rcTuples.add(`${r.player_name}|${r.prop_type}|${r.pick_side}`);
  console.log(`  rec_cache (player markets): ${rc.data.length} rows, ${rcTuples.size} distinct tuples`);

  // Set diff: in props but NOT in rec
  const inPropsNotRec = [...ppTuples.keys()].filter((k) => !rcTuples.has(k));
  console.log(`\n  in props_cache but NOT in rec_cache: ${inPropsNotRec.length}`);
  // Show 10 examples ordered by latest_last_seen DESC (most recent first)
  const sortedGap = inPropsNotRec
    .map((k) => ({ k, ...ppTuples.get(k) }))
    .sort((a, b) => b.latest_last_seen.localeCompare(a.latest_last_seen));
  console.log("  Top 10 by recency (latest_last_seen):");
  for (const e of sortedGap.slice(0, 10)) {
    console.log(`    ${e.k.padEnd(60).slice(0, 60)}  first=${e.earliest_first_seen.slice(11, 19)}  last=${e.latest_last_seen.slice(11, 19)}`);
  }

  // (2) For inPropsNotRec — how many were added LATE in the day? (intraday new lines that didn't make it)
  const lateCutoff = `${today}T17:00:00`;
  const lateNewMisses = sortedGap.filter((e) => e.earliest_first_seen > lateCutoff);
  console.log(`\n  Of those, first_seen > ${lateCutoff} (late-arriving lines that never scored): ${lateNewMisses.length}`);

  // (3) Inverse: rec_cache rows for player markets, by created_at hour distribution
  console.log("\n=== (2) rec_cache (player markets only) created_at hour distribution today ===");
  const byHour = new Map();
  for (const r of rc.data) {
    const h = r.created_at.slice(0, 13);
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  for (const [h, n] of [...byHour.entries()].sort()) console.log(`  ${h}: ${n}`);

  // (4) Reverse-check: count of (player|prop|side) tuples in rec_cache that DON'T appear in props_cache
  const inRecNotProps = [...rcTuples].filter((k) => !ppTuples.has(k));
  console.log(`\n  in rec_cache but NOT in props_cache: ${inRecNotProps.length}`);
  if (inRecNotProps.length > 0) {
    console.log("  Top 5:");
    for (const k of inRecNotProps.slice(0, 5)) console.log(`    ${k}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
