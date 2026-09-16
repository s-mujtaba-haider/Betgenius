// D-367 — T11 sweep over NBA weights, ported to TypeScript per D-364/D-366 pattern.
//
// D-393 (2026-06-02) — GUARDS PORTED from optimize-weights-mlb:
//   1. Deterministic 70/30 train/validate split (TS-side hash on pick.id)
//   2. ±50% per-weight magnitude cap (configurable via body.magnitude_cap)
//   3. 6-class dual-criterion classifier:
//      APPLY / HOLD_OVERFIT / HOLD_MARKET_REGRESS / HOLD_CAP_HIT / NO_MOVE / FROZEN_AT_ZERO
//   4. n>=25 per-market regression gate on the VALIDATE split
//   The NBA pre-weight delta math (recomputeConf) is UNCHANGED — guards wrap
//   the existing scoring, they do NOT replace it.
//   Why: D-367's apply blew up (HR 91.67%→67.86%) precisely because it ran
//   WITHOUT these guards (large moves w_l10 0.75→2.5 = +233% and the
//   NEW/∞ move w_minutes_trend 0→1.5 would have been caught by HOLD_CAP_HIT
//   and FROZEN_AT_ZERO respectively).
//
// SCORE COLUMN SEMANTICS (NBA-SPECIFIC):
//   pick_history.score_X stores the PRE-WEIGHT raw factor value (e.g. score_l5
//   is the +15 / +12 / +5 / 0 / -8 / -15 bucket output, not raw_l5 * weight).
//   This differs from MLB where score_X stored the POST-weight contribution.
//   Rescale formula here:
//     new_conf = stored_conf + Σ score_X * (new_w_X - current_w_X)
//   Then clamp [0,100] and apply trivial-line cap if score_trivial_line_cap=true.
//
// SAFETY (matches d366 hard guardrails + D-393 classifier):
//   - Out-of-bounds [0.0, 5.0] aborts (existing)
//   - ≥5 NEW zeros beyond baseline aborts (existing)
//   - Per-weight classifier holds overfit / cap-hit / market-regress (D-393)
//   - dry_run by default; apply=true required to PATCH

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const cors = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...cors, "Content-Type": "application/json" } }); }
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

// 23 NBA weights → pick_history column → algorithm_weights column.
// Order matches the SQL backtest_weights_v3_synthetic_windowed formula so the
// optimizer covers exactly the same surface, with the proviso that pick_history
// stores the pre-weight raw factor value (not the post-weight contribution).
interface WeightSpec {
  db_column: string;   // algorithm_weights column
  score_column: string; // pick_history column (stores raw pre-weight factor)
}

const NBA_WEIGHTS: WeightSpec[] = [
  { db_column: "w_l5",             score_column: "score_l5" },
  { db_column: "w_l10",            score_column: "score_l10" },
  { db_column: "w_season",         score_column: "score_season" },
  { db_column: "w_floor_ceiling",  score_column: "score_floor_ceiling" },
  { db_column: "w_recent_form",    score_column: "score_recent_form" },
  { db_column: "w_home_away",      score_column: "score_home_away" },
  { db_column: "w_rest",           score_column: "score_rest" },
  { db_column: "w_b2b",            score_column: "score_b2b" },
  { db_column: "w_minutes_trend",  score_column: "score_minutes_trend" },
  { db_column: "w_pace",           score_column: "score_pace" },
  { db_column: "w_opp_defense",    score_column: "score_opp_defense" },
  { db_column: "w_prop_type",      score_column: "score_prop_type_penalty" },
  { db_column: "w_z_score",        score_column: "score_z_score" },
  { db_column: "w_role_change",    score_column: "score_role_change" },
  { db_column: "w_vig_filter",     score_column: "score_vig_filter" },
  { db_column: "w_usg_rate",       score_column: "score_usg_rate" },
  { db_column: "w_regression",     score_column: "score_regression" },
  { db_column: "w_market_conf",    score_column: "score_market_conf" },
  { db_column: "w_ha_split",       score_column: "score_home_away_split" },
  { db_column: "w_minutes_floor",  score_column: "score_minutes_volume" },   // see note below
  { db_column: "w_consistency",    score_column: "score_consistency" },
  { db_column: "w_stale_data",     score_column: "score_stale_data" },
  { db_column: "w_player_injury",  score_column: "score_player_injury" },
];
// Note: SQL formula uses w_minutes_floor for BOTH score_minutes_volume and
// score_minutes_stability. We mirror that by including only one column in the
// optimizer and applying the same weight twice via the helper below.
const MIN_STABILITY_COL = "score_minutes_stability"; // shares w_minutes_floor with score_minutes_volume

interface Pick {
  id: string;             // D-393: needed for deterministic split hash
  prop_type: string;
  confidence: number;     // stored production confidence
  hit: boolean | null;
  scores: Record<string, number>; // score_X → raw pre-weight value
  trivial_line_cap: boolean;
}

// D-393: deterministic hash on pick.id, seeded to mirror MLB's
// `hashtextextended(id::text, 12345) % 100`. Returns 0-99.
function pickSplitBucket(id: string, seed: number = 12345): number {
  // Simple FNV-ish string hash; deterministic across runs given same id+seed.
  let h = seed >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h ^ id.charCodeAt(i)) * 16777619) >>> 0;
  }
  return h % 100;
}

async function loadPicks(maxRows: number, isSyntheticFilter: boolean | null): Promise<Pick[]> {
  const cols = [
    "id",  // D-393: needed for split
    "confidence", "hit", "prop_type", "score_trivial_line_cap", "score_trivial_line_penalty",
    ...NBA_WEIGHTS.map(w => w.score_column),
    MIN_STABILITY_COL,
  ].join(",");
  const picks: Pick[] = [];
  let offset = 0;
  const pageSize = 1000;
  let filterStr = "sport=eq.nba&hit=not.is.null&prop_type=in.(points,rebounds,assists,threes,double_double)";
  if (isSyntheticFilter !== null) filterStr += `&is_synthetic=eq.${isSyntheticFilter}`;
  while (picks.length < maxRows) {
    const limit = Math.min(pageSize, maxRows - picks.length);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/pick_history?${filterStr}&select=${cols}&order=created_at.desc&limit=${limit}&offset=${offset}`,
      { headers: sH() },
    );
    if (!r.ok) throw new Error(`pick_history load ${r.status}`);
    const page = await r.json() as Array<Record<string, unknown>>;
    if (!page || page.length === 0) break;
    for (const row of page) {
      const scores: Record<string, number> = {};
      for (const w of NBA_WEIGHTS) {
        const v = row[w.score_column];
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n) && n !== 0) scores[w.score_column] = n;
      }
      const minStab = row[MIN_STABILITY_COL];
      const minStabN = typeof minStab === "number" ? minStab : Number(minStab);
      if (Number.isFinite(minStabN) && minStabN !== 0) scores[MIN_STABILITY_COL] = minStabN;
      picks.push({
        id: String(row.id ?? ""),
        prop_type: String(row.prop_type ?? ""),
        confidence: Number(row.confidence) || 0,
        hit: row.hit === null ? null : Boolean(row.hit),
        scores,
        trivial_line_cap: row.score_trivial_line_cap === true,
      });
      if (picks.length >= maxRows) break;
    }
    if (page.length < limit) break;
    offset += limit;
    if (offset > 100000) break;
  }
  return picks;
}

// Confidence at trial weights, using the delta formula:
//   new_conf = stored_conf + Σ raw_score_X * (new_w_X - current_w_X)
// Clamp to [0,100]. If trivial_line_cap and new_conf > 65: cap to 65.
// D-393: UNCHANGED — this is NBA's pre-weight delta math; guards wrap it.
function recomputeConf(pick: Pick, current: Record<string, number>, trial: Record<string, number>): number {
  let delta = 0;
  for (const w of NBA_WEIGHTS) {
    const s = pick.scores[w.score_column];
    if (s === undefined || s === 0) continue;
    delta += s * (trial[w.db_column] - current[w.db_column]);
  }
  // score_minutes_stability shares w_minutes_floor.
  const sStab = pick.scores[MIN_STABILITY_COL];
  if (sStab !== undefined && sStab !== 0) {
    delta += sStab * (trial.w_minutes_floor - current.w_minutes_floor);
  }
  let c = Math.round(pick.confidence + delta);
  if (c < 0) c = 0; else if (c > 100) c = 100;
  if (pick.trivial_line_cap && c > 65) c = 65;
  return c;
}

interface Stats {
  objective_n: number; objective_hits: number; objective_hit_rate: number;
  per_market: Record<string, { n: number; hits: number; hr: number }>;
}

// D-393: extended to include per-market stats (needed for HOLD_MARKET_REGRESS check)
function computeStats(picks: Pick[], current: Record<string, number>, trial: Record<string, number>, minConf: number): Stats {
  let n = 0, h = 0;
  const per_market: Record<string, { n: number; hits: number; hr: number }> = {};
  for (const p of picks) {
    const c = recomputeConf(p, current, trial);
    if (c >= minConf) {
      n++;
      if (p.hit === true) h++;
      const pm = per_market[p.prop_type] ?? { n: 0, hits: 0, hr: 0 };
      pm.n++;
      if (p.hit === true) pm.hits++;
      per_market[p.prop_type] = pm;
    }
  }
  for (const m of Object.keys(per_market)) {
    const pm = per_market[m];
    pm.hr = pm.n > 0 ? pm.hits / pm.n : 0;
  }
  return {
    objective_n: n, objective_hits: h, objective_hit_rate: n > 0 ? h / n : 0,
    per_market,
  };
}

interface RunBody {
  apply?: boolean;
  apply_columns?: string[];               // D-393: ported from MLB — apply only a subset
  min_confidence_for_objective?: number;
  min_picks_for_objective?: number;
  weight_grid?: number[];
  magnitude_cap?: number;                 // D-393: ±N fractional cap. Default 0.5 (=±50%).
  market_regression_min_n?: number;       // D-393: n threshold for HOLD_MARKET_REGRESS. Default 25.
  max_picks?: number;
  is_synthetic_filter?: boolean | null;   // null = both (default real)
  split_seed?: number;                    // D-393: seed for deterministic 70/30 split. Default 12345.
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
  const minPicks = body.min_picks_for_objective ?? 100;
  const grid = body.weight_grid ?? [0.0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
  const magnitudeCap = body.magnitude_cap ?? 0.5;
  const marketRegressionMinN = body.market_regression_min_n ?? 25;
  const maxPicks = Math.min(body.max_picks ?? 5000, 10000);
  const isSynthFilter = body.is_synthetic_filter === undefined ? false : body.is_synthetic_filter;
  const splitSeed = body.split_seed ?? 12345;

  const t0 = Date.now();

  // Load current 23 NBA weights.
  const allCols = NBA_WEIGHTS.map(w => w.db_column);
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
  const proposed = { ...current };

  const picks = await loadPicks(maxPicks, isSynthFilter);
  const tLoad = Date.now() - t0;
  if (picks.length === 0) return j({ error: "no_picks_loaded", filter: { is_synthetic: isSynthFilter } }, 500);

  // D-393: deterministic 70/30 split (mirrors MLB's hashtextextended(id::text, 12345) % 100 < 70).
  const trainPicks: Pick[] = [];
  const validatePicks: Pick[] = [];
  for (const p of picks) {
    const bucket = pickSplitBucket(p.id, splitSeed);
    if (bucket < 70) trainPicks.push(p);
    else validatePicks.push(p);
  }

  // Baselines (cold = current weights) on TRAIN and VALIDATE.
  const trainBaseline = computeStats(trainPicks, current, current, minConf);
  const validateBaseline = computeStats(validatePicks, current, current, minConf);

  // D-393: per-weight classifier log (mirrors MLB structure).
  type Classification = "APPLY" | "HOLD_OVERFIT" | "HOLD_MARKET_REGRESS" | "HOLD_CAP_HIT" | "NO_MOVE" | "FROZEN_AT_ZERO";
  const log: Array<{
    weight: string;
    score_column: string;
    current: number;
    cap_lo: number;
    cap_hi: number;
    grid_in_cap: number[];
    train_best_value: number;
    train_hr_pre: number; train_hr_post: number;
    validate_hr_at_best: number;
    validate_market_regressions: Array<{ market: string; pre_hr: number; post_hr: number; delta_pp: number; pre_n: number; post_n: number }>;
    classification: Classification;
    note?: string;
  }> = [];

  // D-393: per-weight classification loop (mirrors optimize-weights-mlb structure,
  // but using NBA's in-memory recomputeConf instead of SQL RPCs).
  for (const w of NBA_WEIGHTS) {
    const cur = proposed[w.db_column];

    // FROZEN_AT_ZERO: matches MLB pattern. For NBA, current=0 means the
    // delta formula contributes nothing for that weight (score * 0 = 0),
    // so a NEW non-zero value would have UNKNOWN effect (delta formula
    // CAN compute it since it uses (new_w - current_w) = new_w; but the
    // signal direction is unknown — D-367's w_minutes_trend 0→1.5 move
    // exhibited exactly this overfit risk). Classify as FROZEN_AT_ZERO
    // to require deliberate operator unfreeze.
    if (cur === 0) {
      log.push({
        weight: w.db_column, score_column: w.score_column, current: cur,
        cap_lo: 0, cap_hi: 0, grid_in_cap: [0],
        train_best_value: 0, train_hr_pre: 0, train_hr_post: 0, validate_hr_at_best: 0,
        validate_market_regressions: [],
        classification: "FROZEN_AT_ZERO",
        note: "current = 0; movement requires deliberate operator unfreeze (mirrors MLB d372 FROZEN_AT_ZERO; D-367's w_minutes_trend 0→1.5 move was the canonical risk this catches)",
      });
      continue;
    }

    const capLo = cur * (1 - magnitudeCap);
    const capHi = cur * (1 + magnitudeCap);
    const gridInCap = grid.filter(v => v >= capLo && v <= capHi);
    if (gridInCap.length === 0) {
      log.push({
        weight: w.db_column, score_column: w.score_column, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: [],
        train_best_value: cur, train_hr_pre: 0, train_hr_post: 0, validate_hr_at_best: 0,
        validate_market_regressions: [],
        classification: "NO_MOVE",
        note: "no grid value falls within cap range",
      });
      continue;
    }

    // Pre-train HR at proposed (= current at start of loop)
    const preTrain = computeStats(trainPicks, current, proposed, minConf);
    const preTrainHR = preTrain.objective_hit_rate;
    let bestVal: number | null = null;
    let bestTrainHR = preTrainHR;
    for (const v of gridInCap) {
      if (v === cur) continue;
      proposed[w.db_column] = v;
      const s = computeStats(trainPicks, current, proposed, minConf);
      if (s.objective_n < minPicks) continue;
      if (s.objective_hit_rate > bestTrainHR) {
        bestTrainHR = s.objective_hit_rate;
        bestVal = v;
      }
    }
    proposed[w.db_column] = cur; // restore

    if (bestVal === null) {
      // Check uncapped to detect HOLD_CAP_HIT vs NO_MOVE
      const uncappedGrid = grid.filter(v => v !== cur && (v < capLo || v > capHi));
      let uncappedBestVal: number | null = null;
      let uncappedBestHR = preTrainHR;
      for (const v of uncappedGrid) {
        proposed[w.db_column] = v;
        const s = computeStats(trainPicks, current, proposed, minConf);
        if (s.objective_n < minPicks) continue;
        if (s.objective_hit_rate > uncappedBestHR) {
          uncappedBestHR = s.objective_hit_rate;
          uncappedBestVal = v;
        }
      }
      proposed[w.db_column] = cur;

      if (uncappedBestVal !== null) {
        log.push({
          weight: w.db_column, score_column: w.score_column, current: cur,
          cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
          train_best_value: cur, train_hr_pre: preTrainHR, train_hr_post: preTrainHR,
          validate_hr_at_best: 0,
          validate_market_regressions: [],
          classification: "HOLD_CAP_HIT",
          note: `train wanted ${uncappedBestVal} (HR ${(uncappedBestHR * 100).toFixed(3)}%) which exceeds ±${(magnitudeCap*100).toFixed(0)}% cap. Frozen at current ${cur}. Flag for future run.`,
        });
        continue;
      }

      log.push({
        weight: w.db_column, score_column: w.score_column, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
        train_best_value: cur, train_hr_pre: preTrainHR, train_hr_post: preTrainHR,
        validate_hr_at_best: 0,
        validate_market_regressions: [],
        classification: "NO_MOVE",
        note: `no value in cap improves train HR beyond ${(preTrainHR * 100).toFixed(3)}%`,
      });
      continue;
    }

    // Train improves. Evaluate validate at bestVal.
    proposed[w.db_column] = bestVal;
    const vStats = computeStats(validatePicks, current, proposed, minConf);
    proposed[w.db_column] = cur; // restore

    const validateImproves = vStats.objective_hit_rate > validateBaseline.objective_hit_rate;
    const regressions: Array<{ market: string; pre_hr: number; post_hr: number; delta_pp: number; pre_n: number; post_n: number }> = [];
    for (const [m, post] of Object.entries(vStats.per_market)) {
      const pre = validateBaseline.per_market[m] ?? { n: 0, hits: 0, hr: 0 };
      if (post.n >= marketRegressionMinN && post.hr < pre.hr) {
        regressions.push({ market: m, pre_hr: pre.hr, post_hr: post.hr, delta_pp: (post.hr - pre.hr) * 100, pre_n: pre.n, post_n: post.n });
      }
    }

    if (!validateImproves) {
      log.push({
        weight: w.db_column, score_column: w.score_column, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
        train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
        validate_hr_at_best: vStats.objective_hit_rate,
        validate_market_regressions: [],
        classification: "HOLD_OVERFIT",
        note: `train HR ${(preTrainHR * 100).toFixed(3)} → ${(bestTrainHR * 100).toFixed(3)} but validate ${(validateBaseline.objective_hit_rate * 100).toFixed(3)} → ${(vStats.objective_hit_rate * 100).toFixed(3)} (no lift)`,
      });
      continue;
    }
    if (regressions.length > 0) {
      log.push({
        weight: w.db_column, score_column: w.score_column, current: cur,
        cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
        train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
        validate_hr_at_best: vStats.objective_hit_rate,
        validate_market_regressions: regressions,
        classification: "HOLD_MARKET_REGRESS",
        note: `train + validate aggregate improve but ${regressions.length} market(s) regress at n>=${marketRegressionMinN}`,
      });
      continue;
    }

    // APPLY: commit.
    proposed[w.db_column] = bestVal;
    log.push({
      weight: w.db_column, score_column: w.score_column, current: cur,
      cap_lo: capLo, cap_hi: capHi, grid_in_cap: gridInCap,
      train_best_value: bestVal, train_hr_pre: preTrainHR, train_hr_post: bestTrainHR,
      validate_hr_at_best: vStats.objective_hit_rate,
      validate_market_regressions: [],
      classification: "APPLY",
      note: `validate HR ${(validateBaseline.objective_hit_rate * 100).toFixed(3)} → ${(vStats.objective_hit_rate * 100).toFixed(3)}`,
    });
  }

  const trainFinal = computeStats(trainPicks, current, proposed, minConf);
  const validateFinal = computeStats(validatePicks, current, proposed, minConf);

  // Existing safety (preserved):
  const outOfBounds = Object.entries(proposed).filter(([_, v]) => v < 0 || v > 5).map(([k, v]) => ({ k, v }));
  const initialZeros = Object.entries(initialWeights).filter(([_, v]) => v === 0).map(([k]) => k);
  const newZeros = Object.entries(proposed).filter(([k, v]) => v === 0 && !initialZeros.includes(k)).map(([k]) => k);
  const safetyAbort = outOfBounds.length > 0 || newZeros.length >= 5;

  const changes = NBA_WEIGHTS
    .filter(w => proposed[w.db_column] !== initialWeights[w.db_column])
    .map(w => ({
      column: w.db_column,
      score_column: w.score_column,
      initial: initialWeights[w.db_column],
      final: proposed[w.db_column],
      direction: proposed[w.db_column] > initialWeights[w.db_column] ? "up" : "down",
      magnitude_pct: initialWeights[w.db_column] !== 0
        ? (proposed[w.db_column] - initialWeights[w.db_column]) / initialWeights[w.db_column]
        : null,
    }));

  const classCount: Record<string, number> = {};
  for (const entry of log) classCount[entry.classification] = (classCount[entry.classification] ?? 0) + 1;

  let writeStatus: number | null = null;
  let appliedSubset: Record<string, number> | null = null;
  if (apply && !safetyAbort) {
    const subset = applyColumns && applyColumns.length > 0
      ? Object.fromEntries(applyColumns.map(c => [c, proposed[c]]))
      : Object.fromEntries(changes.map(c => [c.column, c.final]));
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/algorithm_weights?id=eq.1`, {
      method: "PATCH",
      headers: { ...sH(), Prefer: "return=minimal" },
      body: JSON.stringify(subset),
    });
    writeStatus = patch.status;
    appliedSubset = subset;
  }

  if (safetyAbort) {
    return j({
      success: false, reason: "safety_abort",
      out_of_bounds: outOfBounds, new_zeros_beyond_baseline: newZeros, initial_zeros: initialZeros,
      baselines: { train: trainBaseline, validate: validateBaseline },
      final: { train: trainFinal, validate: validateFinal },
      proposed_weights: proposed, initial_weights: initialWeights,
      changes, per_weight_log: log, classification_counts: classCount,
      duration_ms: Date.now() - t0, load_ms: tLoad, picks_loaded: picks.length,
      split: { train_n: trainPicks.length, validate_n: validatePicks.length, split_seed: splitSeed },
    }, 200);
  }

  return j({
    success: true, apply, write_status: writeStatus, applied_subset: appliedSubset,
    picks_loaded: picks.length,
    picks_by_market: picks.reduce((acc, p) => { acc[p.prop_type] = (acc[p.prop_type] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    split: { train_n: trainPicks.length, validate_n: validatePicks.length, split_seed: splitSeed },
    baselines: { train: trainBaseline, validate: validateBaseline },
    final: { train: trainFinal, validate: validateFinal },
    delta_train_objective_hr: trainFinal.objective_hit_rate - trainBaseline.objective_hit_rate,
    delta_validate_objective_hr: validateFinal.objective_hit_rate - validateBaseline.objective_hit_rate,
    initial_weights: initialWeights, proposed_weights: proposed, apply_changes: changes,
    classification_counts: classCount,
    per_weight_log: log,
    safety: { out_of_bounds: outOfBounds, initial_zeros: initialZeros, new_zeros_beyond_baseline: newZeros },
    config: { min_conf: minConf, min_picks: minPicks, grid, magnitude_cap: magnitudeCap, market_regression_min_n: marketRegressionMinN, max_picks: maxPicks, is_synthetic_filter: isSynthFilter, split_seed: splitSeed },
    load_ms: tLoad, duration_ms: Date.now() - t0,
  });
});
