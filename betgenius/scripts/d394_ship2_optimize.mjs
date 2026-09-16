#!/usr/bin/env node
// D-394 SHIP 2 — full-corpus guarded optimizer orchestrator.
//
// Mirrors d372-optimize-mlb's structure but in Node, calling d394_nba_score_at_weights
// per trial. NO writes to algorithm_weights. Outputs a per-weight classification
// table with full holdout (validate) evidence.
//
// 2 passes, coordinate descent within ±50% magnitude cap, dual-criterion
// classifier (APPLY / HOLD_OVERFIT / HOLD_MARKET_REGRESS / HOLD_CAP_HIT /
// NO_MOVE / FROZEN_AT_ZERO).
//
// Pre-state snapshot: d394_pre_optimization_weights.json (from SHIP 1).
// Post-run snapshot: read algorithm_weights, confirm identical.

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

const NBA_WEIGHTS = [
  "w_l5","w_l10","w_season","w_floor_ceiling","w_recent_form","w_home_away","w_rest","w_b2b",
  "w_minutes_trend","w_pace","w_opp_defense","w_prop_type","w_z_score","w_role_change",
  "w_vig_filter","w_usg_rate","w_regression","w_market_conf","w_ha_split","w_minutes_floor",
  "w_consistency","w_stale_data","w_player_injury",
];
const GRID = [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
const MAGNITUDE_CAP = 0.5;            // ±50%
const MIN_CONF = 60;
const MIN_PICKS = 100;
const MARKET_REGRESSION_MIN_N = 25;
const NUM_PASSES = 2;

async function readWeights() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/algorithm_weights?id=eq.1&select=${NBA_WEIGHTS.join(",")}`, { headers: H });
  if (!r.ok) throw new Error(`weights read failed: ${r.status}`);
  return (await r.json())[0];
}

async function rpc(weights, currentWeights, splitMode) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/d394_nba_score_at_weights`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ p_weights: weights, p_current_weights: currentWeights, p_min_conf: MIN_CONF, p_split_mode: splitMode }),
  });
  if (!r.ok) throw new Error(`rpc failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return await r.json();
}

async function main() {
  const t0 = Date.now();
  const initialWeights = await readWeights();
  const current = { ...initialWeights };
  const proposed = { ...initialWeights };

  console.log("=== Initial weights (snapshot reference) ===");
  console.log(JSON.stringify(initialWeights, null, 2));

  // Baselines (split=train and split=validate) at CURRENT weights
  console.log("\n=== Baselines on FULL corpus (no movement) ===");
  const trainBaseline = await rpc(current, current, "train");
  const validateBaseline = await rpc(current, current, "validate");
  console.log(`  train  : n=${trainBaseline.objective_n}  HR=${(trainBaseline.objective_hit_rate*100).toFixed(3)}%`);
  console.log(`  validate: n=${validateBaseline.objective_n} HR=${(validateBaseline.objective_hit_rate*100).toFixed(3)}%`);

  let rpcCalls = 2;

  // Per-weight classification log
  const log = [];

  for (let pass = 0; pass < NUM_PASSES; pass++) {
    console.log(`\n=== Pass ${pass + 1} of ${NUM_PASSES} ===`);
    for (const w of NBA_WEIGHTS) {
      const cur = proposed[w];

      if (cur === 0) {
        log.push({ pass, weight: w, current: cur, classification: "FROZEN_AT_ZERO", note: "current = 0; movement requires deliberate operator unfreeze" });
        console.log(`  ${w.padEnd(22)} cur=${cur}  → FROZEN_AT_ZERO`);
        continue;
      }

      const capLo = cur * (1 - MAGNITUDE_CAP);
      const capHi = cur * (1 + MAGNITUDE_CAP);
      const gridInCap = GRID.filter(v => v >= capLo && v <= capHi);
      const gridOutCap = GRID.filter(v => v !== cur && (v < capLo || v > capHi));

      if (gridInCap.length === 0) {
        log.push({ pass, weight: w, current: cur, cap_lo: capLo, cap_hi: capHi, classification: "NO_MOVE", note: "no grid value falls within cap range" });
        console.log(`  ${w.padEnd(22)} cur=${cur} cap=[${capLo},${capHi}]  → NO_MOVE`);
        continue;
      }

      // Pre-train HR at proposed (= current at first iteration of this weight in this pass)
      const trialBase = { ...proposed };
      const preTrain = await rpc(trialBase, current, "train");
      rpcCalls++;
      const preTrainHR = preTrain.objective_hit_rate;
      let bestVal = null;
      let bestTrainHR = preTrainHR;

      for (const v of gridInCap) {
        if (v === cur) continue;
        trialBase[w] = v;
        const s = await rpc(trialBase, current, "train");
        rpcCalls++;
        if (s.objective_n < MIN_PICKS) continue;
        if (s.objective_hit_rate > bestTrainHR) {
          bestTrainHR = s.objective_hit_rate;
          bestVal = v;
        }
      }
      trialBase[w] = cur;

      if (bestVal === null) {
        // Check uncapped → HOLD_CAP_HIT vs NO_MOVE
        let uncappedBestVal = null;
        let uncappedBestHR = preTrainHR;
        for (const v of gridOutCap) {
          trialBase[w] = v;
          const s = await rpc(trialBase, current, "train");
          rpcCalls++;
          if (s.objective_n < MIN_PICKS) continue;
          if (s.objective_hit_rate > uncappedBestHR) {
            uncappedBestHR = s.objective_hit_rate;
            uncappedBestVal = v;
          }
        }
        trialBase[w] = cur;

        if (uncappedBestVal !== null) {
          log.push({
            pass, weight: w, current: cur, cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
            train_best_value: cur, train_hr_pre: preTrainHR, train_hr_post: preTrainHR,
            classification: "HOLD_CAP_HIT",
            note: `train wanted ${uncappedBestVal} (HR ${(uncappedBestHR * 100).toFixed(3)}%) which exceeds ±${(MAGNITUDE_CAP*100)}% cap. Frozen at ${cur}.`,
          });
          console.log(`  ${w.padEnd(22)} cur=${cur} cap=[${capLo},${capHi}]  → HOLD_CAP_HIT (uncapped wanted ${uncappedBestVal} for HR ${(uncappedBestHR*100).toFixed(2)}%)`);
          continue;
        }

        log.push({
          pass, weight: w, current: cur, cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
          train_best_value: cur, train_hr_pre: preTrainHR, train_hr_post: preTrainHR,
          classification: "NO_MOVE",
          note: `no value in cap improves train HR beyond ${(preTrainHR * 100).toFixed(3)}%`,
        });
        console.log(`  ${w.padEnd(22)} cur=${cur} cap=[${capLo},${capHi}]  → NO_MOVE (train HR ${(preTrainHR*100).toFixed(2)}%)`);
        continue;
      }

      // Train improves. Validate eval at bestVal.
      trialBase[w] = bestVal;
      const vStats = await rpc(trialBase, current, "validate");
      rpcCalls++;
      trialBase[w] = cur;

      const validateImproves = vStats.objective_hit_rate > validateBaseline.objective_hit_rate;
      const regressions = [];
      for (const [m, post] of Object.entries(vStats.per_market || {})) {
        const pre = (validateBaseline.per_market || {})[m] ?? { n: 0, hits: 0, hr: 0 };
        if (post.n >= MARKET_REGRESSION_MIN_N && post.hr < pre.hr) {
          regressions.push({ market: m, pre_hr: pre.hr, post_hr: post.hr, delta_pp: (post.hr - pre.hr) * 100, pre_n: pre.n, post_n: post.n });
        }
      }

      if (!validateImproves) {
        log.push({
          pass, weight: w, current: cur, cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
          train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
          validate_hr_at_best: vStats.objective_hit_rate,
          validate_market_regressions: [],
          classification: "HOLD_OVERFIT",
          note: `train ${(preTrainHR*100).toFixed(3)}→${(bestTrainHR*100).toFixed(3)} but validate ${(validateBaseline.objective_hit_rate*100).toFixed(3)}→${(vStats.objective_hit_rate*100).toFixed(3)} (no lift)`,
        });
        console.log(`  ${w.padEnd(22)} cur=${cur} bestv=${bestVal}  → HOLD_OVERFIT (train ↑ ${(bestTrainHR*100).toFixed(2)}%, validate ${(vStats.objective_hit_rate*100).toFixed(2)}%)`);
        continue;
      }

      if (regressions.length > 0) {
        log.push({
          pass, weight: w, current: cur, cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
          train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
          validate_hr_at_best: vStats.objective_hit_rate,
          validate_market_regressions: regressions,
          classification: "HOLD_MARKET_REGRESS",
          note: `train + validate aggregate improve but ${regressions.length} market(s) regress at n>=${MARKET_REGRESSION_MIN_N}`,
        });
        console.log(`  ${w.padEnd(22)} cur=${cur} bestv=${bestVal}  → HOLD_MARKET_REGRESS (${regressions.length} regressed: ${regressions.map(r=>r.market).join(",")})`);
        continue;
      }

      // APPLY
      proposed[w] = bestVal;
      log.push({
        pass, weight: w, current: cur, cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
        train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
        validate_hr_at_best: vStats.objective_hit_rate,
        validate_market_regressions: [],
        classification: "APPLY",
        note: `validate HR ${(validateBaseline.objective_hit_rate*100).toFixed(3)}→${(vStats.objective_hit_rate*100).toFixed(3)}`,
      });
      console.log(`  ${w.padEnd(22)} cur=${cur} → ${bestVal}  *** APPLY ***  (validate ${(validateBaseline.objective_hit_rate*100).toFixed(2)}→${(vStats.objective_hit_rate*100).toFixed(2)}%)`);
    }
  }

  // Final stats at proposed weights
  console.log("\n=== Final stats at proposed weights ===");
  const trainFinal = await rpc(proposed, current, "train");
  const validateFinal = await rpc(proposed, current, "validate");
  rpcCalls += 2;
  console.log(`  train:    ${(trainBaseline.objective_hit_rate*100).toFixed(3)}% → ${(trainFinal.objective_hit_rate*100).toFixed(3)}%  Δ ${((trainFinal.objective_hit_rate-trainBaseline.objective_hit_rate)*100).toFixed(3)}pp`);
  console.log(`  validate: ${(validateBaseline.objective_hit_rate*100).toFixed(3)}% → ${(validateFinal.objective_hit_rate*100).toFixed(3)}%  Δ ${((validateFinal.objective_hit_rate-validateBaseline.objective_hit_rate)*100).toFixed(3)}pp`);

  // Classification summary
  const classCount = {};
  for (const e of log) classCount[e.classification] = (classCount[e.classification] || 0) + 1;
  console.log("\n=== Classification counts (across all passes) ===");
  for (const [k, n] of Object.entries(classCount).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${n}`);

  // Changes
  const changes = NBA_WEIGHTS.filter(w => proposed[w] !== initialWeights[w]).map(w => ({
    column: w,
    initial: initialWeights[w],
    final: proposed[w],
    magnitude_pct: initialWeights[w] !== 0 ? (proposed[w] - initialWeights[w]) / initialWeights[w] * 100 : null,
  }));
  console.log("\n=== Proposed APPLY subset (if any) ===");
  if (changes.length === 0) console.log("  (none — every potential move was guarded)");
  for (const c of changes) console.log(`  ${c.column.padEnd(22)} ${c.initial} → ${c.final}  (${c.magnitude_pct?.toFixed(1)}%)`);

  // Verify: zero writes — re-read weights
  const weightsAfter = await readWeights();
  const identical = JSON.stringify(initialWeights) === JSON.stringify(weightsAfter);
  console.log(`\n=== Zero-write verification ===`);
  console.log(`  pre/post algorithm_weights snapshot identical: ${identical ? "✓ YES" : "✗ NO — INVESTIGATE"}`);

  const out = {
    ts: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    rpc_calls: rpcCalls,
    initial_weights: initialWeights,
    proposed_weights: proposed,
    changes,
    baselines: { train: trainBaseline, validate: validateBaseline },
    final: { train: trainFinal, validate: validateFinal },
    delta_train_hr_pp: (trainFinal.objective_hit_rate - trainBaseline.objective_hit_rate) * 100,
    delta_validate_hr_pp: (validateFinal.objective_hit_rate - validateBaseline.objective_hit_rate) * 100,
    classification_counts: classCount,
    per_weight_log: log,
    weights_after: weightsAfter,
    zero_writes_confirmed: identical,
    config: { num_passes: NUM_PASSES, grid: GRID, magnitude_cap: MAGNITUDE_CAP, min_conf: MIN_CONF, min_picks: MIN_PICKS, market_regression_min_n: MARKET_REGRESSION_MIN_N },
  };
  writeFileSync(resolve(REPORT_DIR, "d394_optimizer_run.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote d394_optimizer_run.json  (${rpcCalls} RPC calls, ${((Date.now()-t0)/1000).toFixed(1)}s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
