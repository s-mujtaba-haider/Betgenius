#!/usr/bin/env node
// D-396 SHIP 2 — saturation + prop-coverage diagnostic. READ-ONLY.
//
// D. Same-players-always-elite: pull last 14 days of MLB conf>=90 picks.
//    Identify the players that recur. Quantify.
// E. Prop-type coverage: pull last 7 days of MLB recommendations_cache,
//    bucket by prop_type. Determine which markets are dominant + which
//    are missing.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const REPORT_DIR = resolve(projectRoot, "docs", "loop", "reports");
mkdirSync(REPORT_DIR, { recursive: true });

const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["]?([^"\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["]?([^"\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status}` };
  return { data: await res.json() };
}
async function head(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}&select=id`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  const cr = res.headers.get("content-range");
  return cr ? parseInt(cr.split("/").pop(), 10) : null;
}

const out = { ts: new Date().toISOString() };

async function main() {
  const today = new Date();
  const slate = new Date(today.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);

  // ===== D: SATURATION — recurring elite-tier players (last 14d MLB) =====
  console.log("=== D. SATURATION: MLB conf>=90 picks last 14 days, grouped by player ===");
  const since = new Date(today.getTime() - 14 * 86400 * 1000).toISOString().slice(0, 10);
  const elites = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&confidence=gte.90&game_date=gte.${since}&select=player_name,prop_type,line,pick_side,confidence,game_date,hit&order=game_date.desc&limit=2000`);
  if (elites.error) { console.log(`  ERROR: ${elites.error}`); }
  else {
    const byPlayer = new Map();
    for (const r of elites.data) {
      if (!byPlayer.has(r.player_name)) byPlayer.set(r.player_name, []);
      byPlayer.get(r.player_name).push(r);
    }
    const sorted = [...byPlayer.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`  Total conf>=90 MLB picks last 14d: ${elites.data.length}`);
    console.log(`  Distinct players hitting 90+: ${byPlayer.size}`);
    console.log("\n  Top 15 most-recurring conf>=90 players:");
    console.log("  player                              n_appearances  distinct_dates  hits  HR%   recent_prop_types");
    out.recurring_elites = [];
    for (const [player, picks] of sorted.slice(0, 15)) {
      const dates = new Set(picks.map(p => p.game_date));
      const hits = picks.filter(p => p.hit === true).length;
      const misses = picks.filter(p => p.hit === false).length;
      const resolved = hits + misses;
      const hrStr = resolved > 0 ? (hits / resolved * 100).toFixed(1) + "%" : "n/a";
      const propTypes = [...new Set(picks.map(p => p.prop_type))].join(",");
      console.log(`  ${player.padEnd(36).slice(0,36)}  ${String(picks.length).padStart(5)}          ${String(dates.size).padStart(5)}        ${String(hits).padStart(3)}   ${hrStr.padStart(6)}  ${propTypes}`);
      out.recurring_elites.push({ player, n_appearances: picks.length, distinct_dates: dates.size, hits, misses, hr: resolved > 0 ? hits/resolved : null, prop_types: [...new Set(picks.map(p => p.prop_type))] });
    }
  }

  // Cross-check: D-385's empirical settle on conf>=70 → elite-TAKE HR was 41.9% (n=31)
  console.log("\n  Cross-check D-385 elite-saturation finding:");
  const elite14d = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&confidence=gte.90&hit=not.is.null&game_date=gte.${since}&select=hit&limit=2000`);
  if (!elite14d.error) {
    const hits = elite14d.data.filter(r => r.hit === true).length;
    const total = elite14d.data.length;
    console.log(`    last 14d MLB conf>=90 resolved: n=${total}  hits=${hits}  HR=${total > 0 ? (hits/total*100).toFixed(1) : "n/a"}%`);
    out.elite_hr_14d = { n: total, hits, hr: total > 0 ? hits/total : null };
  }
  const good14d = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&confidence=gte.70&confidence=lt.80&hit=not.is.null&game_date=gte.${since}&select=hit&limit=2000`);
  if (!good14d.error) {
    const hits = good14d.data.filter(r => r.hit === true).length;
    const total = good14d.data.length;
    console.log(`    last 14d MLB conf 70-79 (good) resolved: n=${total}  hits=${hits}  HR=${total > 0 ? (hits/total*100).toFixed(1) : "n/a"}%`);
    out.good_hr_14d = { n: total, hits, hr: total > 0 ? hits/total : null };
  }

  // ===== E: PROP COVERAGE — recommendations_cache by prop_type (7d) =====
  console.log("\n\n=== E. PROP COVERAGE: MLB recommendations_cache last 7 days, by prop_type ===");
  const since7 = new Date(today.getTime() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  const recsCount = {};
  const propTypes = ["hits", "home_runs", "total_bases", "rbis", "pitcher_strikeouts", "spreads", "h2h", "totals", "runs_scored", "strikeouts", "pitcher_outs", "pitcher_record_a_win"];
  for (const pt of propTypes) {
    const n = await head(`recommendations_cache?sport=eq.mlb&game_date=gte.${since7}&prop_type=eq.${pt}`);
    if (n !== null && n > 0) recsCount[pt] = n;
  }
  console.log("  prop_type distribution (rec_cache rows last 7d):");
  for (const [pt, n] of Object.entries(recsCount).sort((a, b) => b[1] - a[1])) console.log(`    ${pt.padEnd(22)}  ${n}`);
  out.recs_by_prop = recsCount;
  const totalRecs = Object.values(recsCount).reduce((a, b) => a + b, 0);
  console.log(`  total MLB rec_cache rows last 7d: ${totalRecs}`);

  // ===== E (continued): for each player-prop type, how many at conf>=70 (recommendation-tier)? =====
  console.log("\n  ↑ tier breakdown: how many of each prop_type cleared conf>=70 in last 7d?");
  const recsAt70 = {};
  for (const pt of propTypes) {
    const n = await head(`recommendations_cache?sport=eq.mlb&game_date=gte.${since7}&prop_type=eq.${pt}&confidence=gte.70`);
    if (n !== null && n > 0) recsAt70[pt] = n;
  }
  console.log("  conf>=70 distribution (the subscriber-actionable subset):");
  for (const [pt, n] of Object.entries(recsAt70).sort((a, b) => b[1] - a[1])) console.log(`    ${pt.padEnd(22)}  ${n}`);
  out.recs_at_70_by_prop = recsAt70;

  // Compare to props_cache: what's the UPSTREAM distribution of available prop types (today)?
  console.log("\n  PROPS_CACHE upstream comparison: distinct prop_types in today's MLB props_cache");
  const todayCompact = slate.replace(/-/g, "");
  const propsCacheToday = await rest(`props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&select=prop_type`);
  if (!propsCacheToday.error) {
    const upstream = {};
    for (const r of propsCacheToday.data) upstream[r.prop_type] = (upstream[r.prop_type] || 0) + 1;
    for (const [pt, n] of Object.entries(upstream).sort((a, b) => b[1] - a[1])) console.log(`    ${pt.padEnd(22)}  ${n}`);
    out.props_cache_upstream_today = upstream;
  }

  writeFileSync(resolve(REPORT_DIR, "d396_saturation_coverage.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote d396_saturation_coverage.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
