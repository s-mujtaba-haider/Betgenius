#!/usr/bin/env node
// D-393 SHIP 1 — quantify current resolved NBA corpus post-D-389a drain.
//
// The D-389a drain restored throughput. NBA props_cache has been dry per
// D-387 (NBA offseason / Finals window), but historically-resolved NBA
// picks should still exist in pick_history. Count by total + per-market
// + per-tier (60+/70+/80+/90+).

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["]?([^"\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["]?([^"\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function headCount(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}&select=id`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  const cr = res.headers.get("content-range");
  return cr ? parseInt(cr.split("/").pop(), 10) : null;
}

async function main() {
  // Total resolved NBA live picks
  console.log("=== Resolved live NBA picks (sport=nba, is_synthetic=false, hit IS NOT NULL) ===");
  const all = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.false&hit=not.is.null");
  console.log(`  total resolved: ${all}`);

  console.log("\n=== By prop_type (D-367 optimizer markets: points, rebounds, assists, threes, double_double) ===");
  for (const pt of ["points", "rebounds", "assists", "threes", "double_double"]) {
    const n = await headCount(`pick_history?sport=eq.nba&is_synthetic=eq.false&hit=not.is.null&prop_type=eq.${pt}`);
    console.log(`  ${pt.padEnd(18)}: ${n}`);
  }

  console.log("\n=== By tier (confidence) ===");
  for (const cutoff of [60, 70, 80, 90]) {
    const n = await headCount(`pick_history?sport=eq.nba&is_synthetic=eq.false&hit=not.is.null&confidence=gte.${cutoff}`);
    console.log(`  conf≥${cutoff}: ${n}`);
  }

  console.log("\n=== Resolution split (hit=true / false / null) ===");
  const t = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.false&hit=eq.true");
  const f = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.false&hit=eq.false");
  const nul = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.false&hit=is.null");
  console.log(`  hit=true:  ${t}`);
  console.log(`  hit=false: ${f}`);
  console.log(`  hit=null:  ${nul}  (PUSH for game-side or unresolved)`);

  console.log("\n=== Recent (last 90 days) ===");
  const since = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);
  const recent = await headCount(`pick_history?sport=eq.nba&is_synthetic=eq.false&hit=not.is.null&game_date=gte.${since}`);
  console.log(`  resolved in last 90d: ${recent}`);

  console.log("\n=== Synthetic NBA corpus (for comparison) ===");
  const synth = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.true&hit=not.is.null");
  console.log(`  total resolved synthetic: ${synth}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
