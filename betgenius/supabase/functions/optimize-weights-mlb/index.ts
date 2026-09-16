// D-372 — Full 44,590-corpus MLB T11 optimizer.
//
// ARCHITECTURE: corpus stays in PostgreSQL. The optimizer calls the SQL RPCs
// d372_search_weight_grid (batched per-weight grid eval) and d372_score_at_weights
// (single-trial scoring). Edge function memory holds only weight dicts + a
// per-weight log. No Pick[] array, no in-edge iteration over picks.
//
// SPLIT: deterministic hash on UUID via hashtextextended(id::text, 12345).
// Same hash in TS not needed — SQL filters server-side.
//
// CLASSIFIER FIXES (D-371 follow-ups):
//   - Market-regression gate: n>=50 → n>=25 (D-371 SHIP 4 lesson; small markets
//     like batter_rbis n=18-29 fell through the old gate).
//   - FROZEN_AT_ZERO unchanged: classification remains for the 4 zero-pinned
//     weights. Their stored s_X is 0 by construction (f_raw × 0 = 0); the
//     factor's signal is unrecoverable without re-scoring. Documented as a
//     design constraint, not a classifier bug.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const cors = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

type Market = "pitcher" | "batter" | "game";
// D-498 (2026-06-09) extended era union from "D340" | "D362" to include the
// post-D340 / pre-D362 era markers. The 8 weights added (D347/D348/D349/D354)
// were read by the scorer but absent from this ALL_WEIGHTS array; per
// D-497-R audit they're production-active at seed defaults but never tuned.
// Adding them to the type union + the array makes them eligible for T11
// optimizer sweeps. NO weight VALUE changes in this batch — only what the
// optimizer is ALLOWED to tune. A re-tune (D-499) is a separate CEO step.
interface WeightSpec { db_column: string; market: Market; era: "D340" | "D347" | "D348" | "D349" | "D354" | "D362" }

const ALL_WEIGHTS: WeightSpec[] = [
  // 10 PITCHER (D-340)
  { db_column: "w_mlb_pitcher_k_rate",          market: "pitcher", era: "D340" },
  { db_column: "w_mlb_pitcher_form",            market: "pitcher", era: "D340" },
  { db_column: "w_mlb_opposing_lineup_k",       market: "pitcher", era: "D340" },
  { db_column: "w_mlb_handedness_matchup",      market: "pitcher", era: "D340" },
  { db_column: "w_mlb_pitch_count_trend",       market: "pitcher", era: "D340" },
  { db_column: "w_mlb_rest_pitcher",            market: "pitcher", era: "D340" },
  { db_column: "w_mlb_pitcher_ballpark_factor", market: "pitcher", era: "D340" },
  { db_column: "w_mlb_pitcher_weather_wind",    market: "pitcher", era: "D340" },
  { db_column: "w_mlb_pitcher_weather_temp",    market: "pitcher", era: "D340" },
  { db_column: "w_mlb_pitcher_umpire_k_zone",   market: "pitcher", era: "D340" },
  // 12 BATTER (D-340)
  { db_column: "w_mlb_batter_hit_rate",             market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_form",                 market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_pitcher_quality",      market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_recent_ab",            market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_handedness_matchup",   market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_ballpark_hits_factor", market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_weather_temp",         market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_lineup_consistency",   market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_power_rate",           market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_form_power",           market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_pitcher_hr_rate",      market: "batter", era: "D340" },
  { db_column: "w_mlb_batter_weather_wind",         market: "batter", era: "D340" },
  // 11 GAME (D-340)
  { db_column: "w_mlb_game_offense_diff",     market: "game", era: "D340" },
  { db_column: "w_mlb_game_pitching_matchup", market: "game", era: "D340" },
  { db_column: "w_mlb_game_bullpen_strength", market: "game", era: "D340" },
  { db_column: "w_mlb_game_recent_run_diff",  market: "game", era: "D340" },
  { db_column: "w_mlb_game_h2h_recent",       market: "game", era: "D340" },
  { db_column: "w_mlb_game_team_form",        market: "game", era: "D340" },
  { db_column: "w_mlb_game_ballpark",         market: "game", era: "D340" },
  { db_column: "w_mlb_game_weather_wind",     market: "game", era: "D340" },
  { db_column: "w_mlb_game_weather_temp",     market: "game", era: "D340" },
  { db_column: "w_mlb_game_umpire_k_zone",    market: "game", era: "D340" },
  { db_column: "w_mlb_lineup_vs_hand_split",  market: "game", era: "D340" },
  // 13 D-362
  { db_column: "w_mlb_pitcher_xera_edge",   market: "pitcher", era: "D362" },
  { db_column: "w_mlb_pitcher_baa",         market: "pitcher", era: "D362" },
  { db_column: "w_mlb_catcher_framing",     market: "pitcher", era: "D362" },
  { db_column: "w_mlb_pitcher_pitch_mix_k", market: "pitcher", era: "D362" },
  { db_column: "w_mlb_batter_xba",                  market: "batter", era: "D362" },
  { db_column: "w_mlb_batter_exit_velo_trend",      market: "batter", era: "D362" },
  { db_column: "w_mlb_batter_barrel_rate",          market: "batter", era: "D362" },
  { db_column: "w_mlb_batter_xslg_regression",      market: "batter", era: "D362" },
  { db_column: "w_mlb_batter_babip",                market: "batter", era: "D362" },
  { db_column: "w_mlb_batter_vs_pitcher_hand_split",market: "batter", era: "D362" },
  { db_column: "w_mlb_bullpen_quality",             market: "batter", era: "D362" },
  { db_column: "w_mlb_wind_direction_hr",           market: "batter", era: "D362" },
  { db_column: "w_mlb_pitcher_hr_per_9",            market: "batter", era: "D362" },
  // 8 D-498 (2026-06-09) — close the D-497-R column-coverage gap.
  // Market routing matches each weight's _shared/mlb_weights.ts namespace:
  //   W       (pitcher namespace) → market: "pitcher"
  //   W_BATTER (batter namespace) → market: "batter"
  // Sibling-matched: each new entry has the same shape as existing D-340
  // entries in the same market. Grid + cap come from the global body params
  // (no per-entry bounds in WeightSpec).
  //
  // 3 D-347 (batter, batter, batter — _shared/mlb_weights.ts:85-87)
  { db_column: "w_mlb_lineup_spot",                 market: "batter",  era: "D347" },
  { db_column: "w_mlb_day_after_night_fatigue",     market: "batter",  era: "D347" },
  { db_column: "w_mlb_travel_getaway",              market: "batter",  era: "D347" },
  // 1 D-348 (pitcher — _shared/mlb_weights.ts:58)
  { db_column: "w_mlb_pitcher_command_trend",       market: "pitcher", era: "D348" },
  // 2 D-349 (pitcher namespace + batter namespace — _shared/mlb_weights.ts:60,89)
  { db_column: "w_mlb_pitcher_velocity_trend",      market: "pitcher", era: "D349" },
  { db_column: "w_mlb_pitcher_baa_vs_hand",         market: "batter",  era: "D349" },
  // 2 D-354 (pitcher namespace + batter namespace — _shared/mlb_weights.ts:62,91)
  { db_column: "w_mlb_lineup_k_composition",        market: "pitcher", era: "D354" },
  { db_column: "w_mlb_hitter_streak_fatigue",       market: "batter",  era: "D354" },
];

interface GridResult {
  objective_n: number;
  objective_hits: number;
  objective_hit_rate: number;
  per_market: Record<string, { n: number; hits: number; hr: number }>;
}

async function searchGrid(weight_col: string, base: Record<string, number>, current: Record<string, number>, grid: number[], minConf: number, split: string): Promise<Record<string, GridResult> | { error: string }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/d372_search_weight_grid`, {
    method: "POST",
    headers: sH(),
    body: JSON.stringify({
      p_weight_col: weight_col,
      p_base_weights: base,
      p_current_weights: current,
      p_grid: grid,
      p_min_conf: minConf,
      p_split_mode: split,
    }),
  });
  if (!r.ok) return { error: `rpc ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const raw = await r.json() as Record<string, Record<string, unknown>>;
  const out: Record<string, GridResult> = {};
  for (const [gv, stats] of Object.entries(raw || {})) {
    const pm: Record<string, { n: number; hits: number; hr: number }> = {};
    const pmRaw = stats.per_market as Record<string, Record<string, unknown>> | null;
    if (pmRaw) {
      for (const [m, v] of Object.entries(pmRaw)) {
        pm[m] = { n: Number(v.n) || 0, hits: Number(v.hits) || 0, hr: Number(v.hr) || 0 };
      }
    }
    out[gv] = {
      objective_n: Number(stats.objective_n) || 0,
      objective_hits: Number(stats.objective_hits) || 0,
      objective_hit_rate: Number(stats.objective_hit_rate) || 0,
      per_market: pm,
    };
  }
  return out;
}

async function scoreAt(base: Record<string, number>, current: Record<string, number>, minConf: number, split: string): Promise<GridResult | { error: string }> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/d372_score_at_weights`, {
    method: "POST",
    headers: sH(),
    body: JSON.stringify({ p_weights: base, p_current_weights: current, p_min_conf: minConf, p_split_mode: split }),
  });
  if (!r.ok) return { error: `rpc ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const stats = await r.json() as Record<string, unknown>;
  const pm: Record<string, { n: number; hits: number; hr: number }> = {};
  const pmRaw = stats.per_market as Record<string, Record<string, unknown>> | null;
  if (pmRaw) {
    for (const [m, v] of Object.entries(pmRaw)) {
      pm[m] = { n: Number(v.n) || 0, hits: Number(v.hits) || 0, hr: Number(v.hr) || 0 };
    }
  }
  return {
    objective_n: Number(stats.objective_n) || 0,
    objective_hits: Number(stats.objective_hits) || 0,
    objective_hit_rate: Number(stats.objective_hit_rate) || 0,
    per_market: pm,
  };
}

interface RunBody {
  apply?: boolean;
  apply_columns?: string[];
  min_confidence_for_objective?: number;
  weight_grid?: number[];
  magnitude_cap?: number;
  market_regression_min_n?: number; // D-372: gate lowered to 25 default
  pass_index?: number;              // 0 or 1 — supports paginated multi-invocation
  state?: Record<string, number>;   // optional starting proposed state (for pass 2 OR pagination)
  weight_start_idx?: number;        // chunked execution: process ALL_WEIGHTS[start..end)
  weight_end_idx?: number;          // (end exclusive). Default: 0..ALL_WEIGHTS.length (full — 54 as of D-498).
  skip_cap_hit_detection?: boolean; // when true, NO_MOVE without checking the uncapped grid (saves 1 RPC/weight)
  skip_baselines_and_finals?: boolean; // when true, skip the 4 baseline/final RPCs (for chunked runs)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const auth = req.headers.get("authorization") ?? "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  let body: RunBody = {};
  try { body = await req.json(); } catch { /* */ }
  const apply = body.apply ?? false;
  const applyColumns = body.apply_columns;
  const minConf = body.min_confidence_for_objective ?? 60;
  const grid = body.weight_grid ?? [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
  const magnitudeCap = body.magnitude_cap ?? 0.5;
  const marketRegressionMinN = body.market_regression_min_n ?? 25; // D-372 fix
  const passIndex = body.pass_index ?? 0;
  const wStart = Math.max(0, body.weight_start_idx ?? 0);
  const wEnd = Math.min(ALL_WEIGHTS.length, body.weight_end_idx ?? ALL_WEIGHTS.length);
  const skipCap = body.skip_cap_hit_detection ?? false;
  const skipBaselines = body.skip_baselines_and_finals ?? false;

  const t0 = Date.now();

  // Load current weights
  const allCols = ALL_WEIGHTS.map(w => w.db_column);
  const wR = await fetch(`${SUPABASE_URL}/rest/v1/algorithm_weights?id=eq.1&select=${allCols.join(",")}`, { headers: sH() });
  if (!wR.ok) return j({ error: `algorithm_weights read ${wR.status}` }, 500);
  const rows = await wR.json() as Array<Record<string, unknown>>;
  const dbRow = rows[0] ?? {};
  const current: Record<string, number> = {};
  for (const k of allCols) {
    const v = dbRow[k];
    current[k] = typeof v === "number" ? v : Number(v) || 0;
  }
  const initialWeights = { ...current };

  // Starting state: caller-provided (pass 2) OR copy of current (pass 1)
  const proposed: Record<string, number> = body.state ? { ...current, ...body.state } : { ...current };

  // Baselines (cold = current weights). Skippable for chunked runs.
  const trainBaseline = skipBaselines
    ? { objective_n: 0, objective_hits: 0, objective_hit_rate: 0, per_market: {} as Record<string, { n: number; hits: number; hr: number }> }
    : await scoreAt(current, current, minConf, "train");
  if (!skipBaselines && "error" in trainBaseline) return j({ error: "train_baseline_failed", detail: (trainBaseline as { error: string }).error }, 500);
  const validateBaseline = skipBaselines
    ? { objective_n: 0, objective_hits: 0, objective_hit_rate: 0, per_market: {} as Record<string, { n: number; hits: number; hr: number }> }
    : await scoreAt(current, current, minConf, "validate");
  if (!skipBaselines && "error" in validateBaseline) return j({ error: "validate_baseline_failed", detail: (validateBaseline as { error: string }).error }, 500);
  // When baselines are skipped, callers must pass them in via `body.state.__baseline_validate_hr` etc — but
  // simpler approach: chunked runs use the FULL baselines from the first chunk via the orchestrator.
  // For HOLD_OVERFIT classification, fall back to vStats.objective_hit_rate > current pre-chunk validate hr.
  // To keep this clean, when skipBaselines=true, we treat validateImproves = (vStats > 0) which is too loose.
  // → Use body.state.__validate_baseline_hr if provided.
  const validateBaselineHR = (body.state as Record<string, unknown> | undefined)?.["__validate_baseline_hr"] !== undefined
    ? Number((body.state as Record<string, unknown>)["__validate_baseline_hr"])
    : (validateBaseline as GridResult).objective_hit_rate;

  // Per-weight log
  const log: Array<{
    pass: number;
    weight: string;
    market: string;
    era: string;
    current: number;
    cap_lo: number;
    cap_hi: number;
    grid_in_cap: number[];
    train_best_value: number;
    train_hr_pre: number; train_hr_post: number;
    validate_hr_at_best: number;
    validate_market_regressions: Array<{ market: string; pre: number; post: number; delta_pp: number; pre_n: number; post_n: number }>;
    classification: "APPLY" | "HOLD_OVERFIT" | "HOLD_MARKET_REGRESS" | "HOLD_CAP_HIT" | "NO_MOVE" | "FROZEN_AT_ZERO";
    note?: string;
  }> = [];

  let totalRpc = 2;

  // Single-pass coordinate descent over [wStart, wEnd) (caller can chunk across invocations)
  for (let _i = wStart; _i < wEnd; _i++) {
    const w = ALL_WEIGHTS[_i];
    const cur = proposed[w.db_column];
    if (cur === 0) {
      log.push({
        pass: passIndex, weight: w.db_column, market: w.market, era: w.era, current: cur,
        cap_lo: 0, cap_hi: 0, grid_in_cap: [0],
        train_best_value: 0, train_hr_pre: 0, train_hr_post: 0, validate_hr_at_best: 0,
        validate_market_regressions: [],
        classification: "FROZEN_AT_ZERO",
        note: "current = 0; stored s_X = f_raw × 0 = 0; factor signal unrecoverable from MV without re-scoring",
      });
      continue;
    }
    const capLo = cur * (1 - magnitudeCap);
    const capHi = cur * (1 + magnitudeCap);
    const gridInCap = grid.filter(v => v >= capLo && v <= capHi);
    if (gridInCap.length === 0) {
      log.push({
        pass: passIndex, weight: w.db_column, market: w.market, era: w.era, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: [],
        train_best_value: cur, train_hr_pre: 0, train_hr_post: 0, validate_hr_at_best: 0,
        validate_market_regressions: [],
        classification: "NO_MOVE",
        note: "no grid value falls within cap range",
      });
      continue;
    }

    // Per-value train scoring (avoids the d372_search_weight_grid CROSS JOIN penalty).
    // Single-trial RPC is ~0.5s vs grid's ~4s/value due to row explosion.
    const preTrialBase = { ...proposed };
    const preTrainStats = await scoreAt(preTrialBase, current, minConf, "train");
    totalRpc++;
    if ("error" in preTrainStats) return j({ error: "preTrainStats_failed", detail: (preTrainStats as { error: string }).error, weight: w.db_column }, 500);
    const preTrainHR = preTrainStats.objective_hit_rate;
    let bestVal: number | null = null;
    let bestTrainHR = preTrainHR;
    let bestTrainStats: GridResult = preTrainStats;
    for (const v of gridInCap) {
      if (v === cur) continue;
      preTrialBase[w.db_column] = v;
      const s = await scoreAt(preTrialBase, current, minConf, "train");
      totalRpc++;
      if ("error" in s) return j({ error: "train_trial_failed", detail: (s as { error: string }).error, weight: w.db_column, value: v }, 500);
      if (s.objective_n < 100) continue;
      if (s.objective_hit_rate > bestTrainHR) {
        bestTrainHR = s.objective_hit_rate;
        bestVal = v;
        bestTrainStats = s;
      }
    }
    preTrialBase[w.db_column] = cur; // restore

    if (bestVal === null) {
      // Check uncapped to detect CAP_HIT (skippable to save RPCs)
      const uncappedGrid = grid.filter(v => v !== cur && (v < capLo || v > capHi));
      if (!skipCap && uncappedGrid.length > 0) {
        let uncappedBestHR = preTrainHR;
        let uncappedBestVal: number | null = null;
        for (const v of uncappedGrid) {
          preTrialBase[w.db_column] = v;
          const s = await scoreAt(preTrialBase, current, minConf, "train");
          totalRpc++;
          if ("error" in s) continue;
          if (s.objective_n < 100) continue;
          if (s.objective_hit_rate > uncappedBestHR) {
            uncappedBestHR = s.objective_hit_rate;
            uncappedBestVal = v;
          }
        }
        preTrialBase[w.db_column] = cur;
        if (uncappedBestVal !== null) {
          log.push({
              pass: passIndex, weight: w.db_column, market: w.market, era: w.era, current: cur,
              cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
              train_best_value: cur, train_hr_pre: preTrainHR, train_hr_post: preTrainHR,
              validate_hr_at_best: 0,
              validate_market_regressions: [],
            classification: "HOLD_CAP_HIT",
            note: `train wanted ${uncappedBestVal} (HR ${(uncappedBestHR * 100).toFixed(3)}%) which exceeds the ±${(magnitudeCap*100).toFixed(0)}% cap. Frozen at current ${cur}. Flag for future run.`,
          });
          continue;
        }
      }
      log.push({
        pass: passIndex, weight: w.db_column, market: w.market, era: w.era, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
        train_best_value: cur, train_hr_pre: preTrainHR, train_hr_post: preTrainHR,
        validate_hr_at_best: 0,
        validate_market_regressions: [],
        classification: "NO_MOVE",
        note: `no value in cap improves train HR beyond ${(preTrainHR * 100).toFixed(3)}%`,
      });
      continue;
    }

    // Train improves. Evaluate validate at best_v via single-trial RPC.
    preTrialBase[w.db_column] = bestVal;
    const vStats = await scoreAt(preTrialBase, current, minConf, "validate");
    preTrialBase[w.db_column] = cur;
    totalRpc++;
    if ("error" in vStats) return j({ error: "validate_trial_failed", detail: (vStats as { error: string }).error, weight: w.db_column }, 500);

    const validateImproves = vStats.objective_hit_rate > validateBaselineHR;
    const regressions: Array<{ market: string; pre: number; post: number; delta_pp: number; pre_n: number; post_n: number }> = [];
    for (const [m, post] of Object.entries(vStats.per_market)) {
      const pre = validateBaseline.per_market[m] ?? { n: 0, hits: 0, hr: 0 };
      // D-372 fix: n>=25 (down from D-371's n>=50)
      if (post.n >= marketRegressionMinN && post.hr < pre.hr) {
        regressions.push({ market: m, pre: pre.hr, post: post.hr, delta_pp: (post.hr - pre.hr) * 100, pre_n: pre.n, post_n: post.n });
      }
    }

    if (!validateImproves) {
      log.push({
        pass: passIndex, weight: w.db_column, market: w.market, era: w.era, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
        train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
        validate_hr_at_best: vStats.objective_hit_rate,
        validate_market_regressions: [],
        classification: "HOLD_OVERFIT",
        note: `train HR ${(preTrainHR * 100).toFixed(3)} → ${(bestTrainHR * 100).toFixed(3)} but validate HR ${(validateBaseline.objective_hit_rate * 100).toFixed(3)} → ${(vStats.objective_hit_rate * 100).toFixed(3)} (no lift)`,
      });
      continue;
    }
    if (regressions.length > 0) {
      log.push({
        pass: passIndex, weight: w.db_column, market: w.market, era: w.era, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
        train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
        validate_hr_at_best: vStats.objective_hit_rate,
        validate_market_regressions: regressions,
        classification: "HOLD_MARKET_REGRESS",
        note: `train + validate aggregate improve but ${regressions.length} market(s) regress on validate at n≥${marketRegressionMinN}`,
      });
      continue;
    }
    // APPLY: commit
    proposed[w.db_column] = bestVal;
    log.push({
      pass: passIndex, weight: w.db_column, market: w.market, era: w.era, current: cur,
      cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
      train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
      validate_hr_at_best: vStats.objective_hit_rate,
      validate_market_regressions: [],
      classification: "APPLY",
      note: `validate HR ${(validateBaseline.objective_hit_rate * 100).toFixed(3)} → ${(vStats.objective_hit_rate * 100).toFixed(3)}`,
    });
  }

  // Final stats with proposed weights. Skippable for chunked runs (caller aggregates after final chunk).
  const trainFinal = skipBaselines
    ? { objective_n: 0, objective_hits: 0, objective_hit_rate: 0, per_market: {} as Record<string, { n: number; hits: number; hr: number }> }
    : await scoreAt(proposed, current, minConf, "train");
  if (!skipBaselines) { totalRpc++; if ("error" in trainFinal) return j({ error: "train_final_failed", detail: (trainFinal as { error: string }).error }, 500); }
  const validateFinal = skipBaselines
    ? { objective_n: 0, objective_hits: 0, objective_hit_rate: 0, per_market: {} as Record<string, { n: number; hits: number; hr: number }> }
    : await scoreAt(proposed, current, minConf, "validate");
  if (!skipBaselines) { totalRpc++; if ("error" in validateFinal) return j({ error: "validate_final_failed", detail: (validateFinal as { error: string }).error }, 500); }

  const classCount: Record<string, number> = {};
  for (const entry of log) classCount[entry.classification] = (classCount[entry.classification] ?? 0) + 1;

  const applyChanges = ALL_WEIGHTS
    .filter(w => proposed[w.db_column] !== initialWeights[w.db_column])
    .map(w => ({
      column: w.db_column, market: w.market, era: w.era,
      initial: initialWeights[w.db_column], final: proposed[w.db_column],
      direction: proposed[w.db_column] > initialWeights[w.db_column] ? "up" : "down",
      magnitude_pct: initialWeights[w.db_column] !== 0
        ? (proposed[w.db_column] - initialWeights[w.db_column]) / initialWeights[w.db_column]
        : null,
    }));

  const outOfBounds = Object.entries(proposed).filter(([_, v]) => v < 0 || v > 5).map(([k, v]) => ({ k, v }));
  const initialZeros = Object.entries(initialWeights).filter(([_, v]) => v === 0).map(([k]) => k);
  const newZeros = Object.entries(proposed).filter(([k, v]) => v === 0 && !initialZeros.includes(k)).map(([k]) => k);

  let writeStatus: number | null = null;
  let appliedSubset: Record<string, number> | null = null;
  if (apply) {
    if (outOfBounds.length > 0) return j({ success: false, reason: "out_of_bounds_safety", out_of_bounds: outOfBounds }, 200);
    const subset = applyColumns && applyColumns.length > 0
      ? Object.fromEntries(applyColumns.map(c => [c, proposed[c]]))
      : Object.fromEntries(applyChanges.map(c => [c.column, c.final]));
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/algorithm_weights?id=eq.1`, {
      method: "PATCH",
      headers: { ...sH(), Prefer: "return=minimal" },
      body: JSON.stringify(subset),
    });
    writeStatus = patch.status;
    appliedSubset = subset;
  }

  return j({
    success: true,
    apply,
    write_status: writeStatus,
    applied_subset: appliedSubset,
    baselines: { train: trainBaseline, validate: validateBaseline },
    final: { train: trainFinal, validate: validateFinal },
    delta_train_objective_hr: trainFinal.objective_hit_rate - trainBaseline.objective_hit_rate,
    delta_validate_objective_hr: validateFinal.objective_hit_rate - validateBaseline.objective_hit_rate,
    initial_weights: initialWeights,
    proposed_weights: proposed,
    apply_changes: applyChanges,
    classification_counts: classCount,
    per_weight_log: log,
    safety: { out_of_bounds: outOfBounds, initial_zeros: initialZeros, new_zeros_beyond_baseline: newZeros },
    config: { min_conf: minConf, grid, magnitude_cap: magnitudeCap, market_regression_min_n: marketRegressionMinN, pass_index: passIndex },
    total_rpc_calls: totalRpc,
    duration_ms: Date.now() - t0,
  });
});
