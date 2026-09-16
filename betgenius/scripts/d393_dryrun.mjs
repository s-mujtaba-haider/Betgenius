#!/usr/bin/env node
// D-393 SHIP 2 — dry-run d367-optimize-nba (now guarded). Verify:
//   (a) the function runs cleanly on the live NBA corpus
//   (b) classification labels are produced per weight
//   (c) zero writes to algorithm_weights (apply=false default)
//   (d) the D-367 overfit moves (w_l10 toward 2.5, w_minutes_trend 0→1.5)
//       would now be CAUGHT (HOLD_CAP_HIT or FROZEN_AT_ZERO), not applied

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
const BACKFILL = "0e843fb5-6107-4eca-981b-4698fbf49f85";

async function readWeights(seed) {
  // Snapshot algorithm_weights id=1 for the columns the optimizer manages
  const cols = ["w_l5","w_l10","w_season","w_floor_ceiling","w_recent_form","w_home_away","w_rest","w_b2b","w_minutes_trend","w_pace","w_opp_defense","w_prop_type","w_z_score","w_role_change","w_vig_filter","w_usg_rate","w_regression","w_market_conf","w_ha_split","w_minutes_floor","w_consistency","w_stale_data","w_player_injury"];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/algorithm_weights?id=eq.1&select=${cols.join(",")}`, {
    headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
  });
  if (!r.ok) throw new Error(`weights read failed: ${r.status}`);
  return (await r.json())[0];
}

async function main() {
  console.log("=== Pre-run snapshot of algorithm_weights ===");
  const weightsBefore = await readWeights();
  console.log(JSON.stringify(weightsBefore, null, 2).slice(0, 500) + "...");

  console.log("\n=== Invoking d367-optimize-nba dry-run on REAL NBA corpus (apply=false) ===");
  const t0 = Date.now();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/d367-optimize-nba`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BACKFILL}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      apply: false,
      min_confidence_for_objective: 60,
      min_picks_for_objective: 100,
      max_picks: 2000,
      is_synthetic_filter: false,    // REAL picks
      magnitude_cap: 0.5,            // D-393 default ±50%
      market_regression_min_n: 25,   // D-393 default
    }),
  });
  const dur = Date.now() - t0;
  console.log(`  HTTP ${res.status}  duration=${dur}ms`);
  const body = await res.json();
  if (!res.ok || body.error) {
    console.log("  ERROR:", JSON.stringify(body, null, 2).slice(0, 1000));
    return;
  }

  console.log(`\n=== Pre-deploy weights snapshot vs post-dry-run snapshot (must be identical) ===`);
  const weightsAfter = await readWeights();
  const identical = JSON.stringify(weightsBefore) === JSON.stringify(weightsAfter);
  console.log(`  identical: ${identical}  (apply=false → no writes expected)`);

  console.log("\n=== Run summary ===");
  console.log(`  picks_loaded: ${body.picks_loaded}`);
  console.log(`  split: train n=${body.split?.train_n}  validate n=${body.split?.validate_n}  seed=${body.split?.split_seed}`);
  console.log(`  picks_by_market: ${JSON.stringify(body.picks_by_market)}`);
  console.log(`  baselines.train.objective_hr  : ${(body.baselines.train.objective_hit_rate*100).toFixed(3)}%  (n=${body.baselines.train.objective_n})`);
  console.log(`  baselines.validate.objective_hr: ${(body.baselines.validate.objective_hit_rate*100).toFixed(3)}%  (n=${body.baselines.validate.objective_n})`);
  console.log(`  final.train.objective_hr     : ${(body.final.train.objective_hit_rate*100).toFixed(3)}%  (n=${body.final.train.objective_n})`);
  console.log(`  final.validate.objective_hr  : ${(body.final.validate.objective_hit_rate*100).toFixed(3)}%  (n=${body.final.validate.objective_n})`);
  console.log(`  delta_train: ${(body.delta_train_objective_hr*100).toFixed(3)}pp  |  delta_validate: ${(body.delta_validate_objective_hr*100).toFixed(3)}pp`);

  console.log("\n=== classification_counts ===");
  for (const [k, n] of Object.entries(body.classification_counts || {})) console.log(`  ${k.padEnd(22)} ${n}`);

  console.log("\n=== per_weight_log (all 23 weights) ===");
  console.log("  weight                 current  cap_lo  cap_hi  classification         best_v  train_pre→post     validate_at_best  note");
  for (const e of body.per_weight_log || []) {
    const trainStr = `${(e.train_hr_pre*100).toFixed(2)}→${(e.train_hr_post*100).toFixed(2)}`;
    const valStr = e.validate_hr_at_best === 0 ? "n/a" : `${(e.validate_hr_at_best*100).toFixed(2)}%`;
    console.log(`  ${e.weight.padEnd(22)} ${String(e.current).padStart(6)}   ${String(e.cap_lo).padStart(5)}   ${String(e.cap_hi).padStart(5)}   ${e.classification.padEnd(22)} ${String(e.train_best_value).padStart(5)}   ${trainStr.padEnd(15)}    ${valStr.padEnd(8)}  ${(e.note ?? "").slice(0, 80)}`);
  }

  console.log("\n=== D-367 OVERFIT MOVES — guard catch verification ===");
  // D-367's apply: w_l10 0.75→2.5 (+233%, way over ±50% cap), w_minutes_trend 0→1.5 (FROZEN_AT_ZERO baseline)
  const wL10 = body.per_weight_log?.find((e) => e.weight === "w_l10");
  const wMT = body.per_weight_log?.find((e) => e.weight === "w_minutes_trend");
  if (wL10) {
    console.log(`  w_l10           current=${wL10.current}  classification=${wL10.classification}`);
    console.log(`    note: ${wL10.note}`);
    if (wL10.classification === "HOLD_CAP_HIT" || wL10.classification === "NO_MOVE" || wL10.classification === "HOLD_OVERFIT") {
      console.log(`    ✓ CAUGHT — would NOT apply (no longer the D-367 0.75→2.5 +233% disaster path)`);
    } else if (wL10.classification === "APPLY") {
      const newVal = wL10.train_best_value;
      const movePct = wL10.current !== 0 ? Math.abs(newVal - wL10.current) / wL10.current * 100 : null;
      console.log(`    APPLY proposed: ${wL10.current} → ${newVal}  (magnitude ${movePct?.toFixed(1)}%)`);
      console.log(`    NOTE: this is within the ±50% cap so safely bounded; the D-367 +233% move is impossible under the new gates`);
    }
  } else {
    console.log("  w_l10 not in log");
  }
  if (wMT) {
    console.log(`  w_minutes_trend current=${wMT.current}  classification=${wMT.classification}`);
    console.log(`    note: ${wMT.note}`);
    if (wMT.classification === "FROZEN_AT_ZERO") {
      console.log(`    ✓ CAUGHT — FROZEN_AT_ZERO (no longer the D-367 0→1.5 ∞-magnitude disaster path)`);
    }
  } else {
    console.log("  w_minutes_trend not in log");
  }

  // Save full report
  writeFileSync(resolve(REPORT_DIR, "d393_dryrun.json"), JSON.stringify({ ...body, weights_before: weightsBefore, weights_after: weightsAfter, weights_unchanged: identical }, null, 2));
  console.log(`\nWrote d393_dryrun.json`);

  // Final pass/fail summary
  console.log("\n=== SHIP 2 verification summary ===");
  console.log(`  zero writes confirmed: ${identical ? "✓ YES" : "✗ NO — STOP, INVESTIGATE"}`);
  console.log(`  classification produced for all 23 weights: ${(body.per_weight_log?.length ?? 0) === 23 ? "✓ YES" : `✗ NO (${body.per_weight_log?.length})`}`);
  const wL10Caught = wL10 && (wL10.classification === "HOLD_CAP_HIT" || wL10.classification === "HOLD_OVERFIT" || wL10.classification === "NO_MOVE" || (wL10.classification === "APPLY" && Math.abs(wL10.train_best_value - wL10.current) / wL10.current <= 0.5));
  const wMTCaught = wMT && wMT.classification === "FROZEN_AT_ZERO";
  console.log(`  w_l10 D-367 +233% move CAUGHT (cap or holding):    ${wL10Caught ? "✓ YES" : "✗ NO"}`);
  console.log(`  w_minutes_trend D-367 0→1.5 move CAUGHT (FROZEN):  ${wMTCaught ? "✓ YES" : "✗ NO"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
