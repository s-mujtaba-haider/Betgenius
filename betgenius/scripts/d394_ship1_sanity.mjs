#!/usr/bin/env node
// D-394 SHIP 1 — sanity gate: snapshot weights + verify the new RPC
// reproduces the baseline HR on the FULL NBA corpus.
//
// If d394_nba_score_at_weights() called with current_weights == p_weights
// (no change) returns a baseline HR that matches an independent in-table
// computation, the harness math is correct. If it doesn't reproduce,
// STOP — don't trust any proposals built on top of a broken harness.

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
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };

const NBA_WEIGHT_COLS = ["w_l5","w_l10","w_season","w_floor_ceiling","w_recent_form","w_home_away","w_rest","w_b2b","w_minutes_trend","w_pace","w_opp_defense","w_prop_type","w_z_score","w_role_change","w_vig_filter","w_usg_rate","w_regression","w_market_conf","w_ha_split","w_minutes_floor","w_consistency","w_stale_data","w_player_injury"];

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}
async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 500)}` };
  return await res.json();
}
async function headCount(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}&select=id`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  const cr = res.headers.get("content-range");
  return cr ? parseInt(cr.split("/").pop(), 10) : null;
}

async function main() {
  console.log("=== Snapshot algorithm_weights id=1 for the 23 NBA columns ===");
  const w = await rest(`algorithm_weights?id=eq.1&select=${NBA_WEIGHT_COLS.join(",")}`);
  if (w.error) { console.error(w.error); process.exit(1); }
  const current = w.data[0];
  console.log(JSON.stringify(current, null, 2));

  // Persist the snapshot (rollback reference)
  const snapshotPath = resolve(REPORT_DIR, "d394_pre_optimization_weights.json");
  writeFileSync(snapshotPath, JSON.stringify({ ts: new Date().toISOString(), source: "algorithm_weights row id=1, 23 NBA columns at D-394 SHIP 1 baseline", weights: current }, null, 2));
  console.log(`Snapshot written: ${snapshotPath}`);

  console.log("\n=== Independent ground-truth count of resolved live NBA picks ===");
  const allCount = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.false&hit=not.is.null&prop_type=in.%28points%2Crebounds%2Cassists%2Cthrees%2Cdouble_double%29");
  console.log(`  resolved NBA picks in optimizer's universe: ${allCount}`);

  // Independent baseline at conf>=60 — without applying any weight transform.
  // We can't easily compute "what stored confidence >= 60" with a single REST head count
  // since the stored confidence is already at current weights; that's exactly the baseline.
  const baselineN = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.false&hit=not.is.null&prop_type=in.%28points%2Crebounds%2Cassists%2Cthrees%2Cdouble_double%29&confidence=gte.60");
  console.log(`  resolved at conf>=60 (current weights — independent baseline n): ${baselineN}`);
  const baselineHits = await headCount("pick_history?sport=eq.nba&is_synthetic=eq.false&hit=eq.true&prop_type=in.%28points%2Crebounds%2Cassists%2Cthrees%2Cdouble_double%29&confidence=gte.60");
  console.log(`  resolved at conf>=60 with hit=true (independent baseline hits): ${baselineHits}`);
  console.log(`  independent baseline HR (n>0): ${baselineN > 0 ? (baselineHits / baselineN * 100).toFixed(3) + "%" : "n/a"}`);

  console.log("\n=== Call d394_nba_score_at_weights with current==proposed (no-change) on FULL corpus ===");
  console.log("  (this should reproduce the independent baseline; otherwise the RPC math is wrong)");
  const splitModes = ["all", "train", "validate"];
  const rpcResults = {};
  for (const mode of splitModes) {
    const t0 = Date.now();
    const r = await rpc("d394_nba_score_at_weights", {
      p_weights: current,
      p_current_weights: current,
      p_min_conf: 60,
      p_split_mode: mode,
    });
    const dur = Date.now() - t0;
    if (r.error) { console.error(`  ${mode}: ERROR ${r.error}`); rpcResults[mode] = { error: r.error }; continue; }
    rpcResults[mode] = r;
    console.log(`  split=${mode}  duration=${dur}ms`);
    console.log(`    n_total: ${r.n_total}  objective_n (conf>=60): ${r.objective_n}  objective_hits: ${r.objective_hits}  objective_HR: ${(r.objective_hit_rate * 100).toFixed(3)}%`);
    console.log(`    tiers: lean_n=${r.lean_n} (HR ${(r.lean_hr * 100).toFixed(2)}%)  good_n=${r.good_n} (HR ${(r.good_hr * 100).toFixed(2)}%)  strong_n=${r.strong_n} (HR ${(r.strong_hr * 100).toFixed(2)}%)  elite_n=${r.elite_n} (HR ${(r.elite_hr * 100).toFixed(2)}%)`);
    const pmKeys = Object.keys(r.per_market || {});
    if (pmKeys.length > 0) {
      console.log(`    per_market:`);
      for (const k of pmKeys) console.log(`      ${k.padEnd(14)} n=${r.per_market[k].n}  hr=${(r.per_market[k].hr * 100).toFixed(2)}%`);
    }
  }

  console.log("\n=== Sanity-gate verdict ===");
  const allMode = rpcResults["all"];
  if (!allMode || allMode.error) {
    console.log("  ✗ FAIL — RPC error on split=all");
    process.exit(1);
  }
  // The independent baseline is at conf>=60 with CURRENT weights. The RPC at same weights
  // should match exactly (the stored confidence IS the current-weights confidence; no delta applied).
  const rpcN = allMode.objective_n;
  const rpcHits = allMode.objective_hits;
  const nMatch = rpcN === baselineN;
  const hMatch = rpcHits === baselineHits;
  console.log(`  independent baseline:    n=${baselineN}  hits=${baselineHits}  HR=${(baselineHits/baselineN*100).toFixed(3)}%`);
  console.log(`  RPC at p_weights=current: n=${rpcN}  hits=${rpcHits}  HR=${(allMode.objective_hit_rate * 100).toFixed(3)}%`);
  console.log(`  n matches: ${nMatch ? "✓" : "✗"}  hits matches: ${hMatch ? "✓" : "✗"}`);

  // Split balance
  const trainN = rpcResults["train"]?.n_total;
  const validateN = rpcResults["validate"]?.n_total;
  const totalN = rpcResults["all"]?.n_total;
  if (trainN && validateN && totalN) {
    const trainPct = trainN / totalN * 100;
    const validatePct = validateN / totalN * 100;
    console.log(`  Split balance:  train n=${trainN} (${trainPct.toFixed(1)}%)  validate n=${validateN} (${validatePct.toFixed(1)}%)`);
    if (Math.abs(trainPct - 70) > 2) console.log(`  ⚠ split balance off from expected 70/30 by >2pp — investigate`);
    else console.log(`  ✓ split balance within expected 70/30 (±2pp)`);
  }

  writeFileSync(resolve(REPORT_DIR, "d394_sanity.json"), JSON.stringify({
    ts: new Date().toISOString(),
    weights: current,
    independent_baseline: { n: baselineN, hits: baselineHits, hr: baselineN > 0 ? baselineHits / baselineN : 0 },
    rpc_results: rpcResults,
    sanity: { n_matches: nMatch, hits_match: hMatch, train_pct: totalN ? trainN/totalN : null },
  }, null, 2));
  console.log(`\nWrote d394_sanity.json`);

  if (!nMatch || !hMatch) {
    console.log("\n✗ SANITY GATE FAILED — baseline does not reproduce. Harness is wrong. STOP.");
    process.exit(1);
  }
  console.log("\n✓ SANITY GATE PASSED — proceed to SHIP 2.");
}

main().catch((e) => { console.error(e); process.exit(1); });
