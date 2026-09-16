// Phase 1 backtest harness — the metrics set.
//
// This is the actual deliverable: ROI-after-vig and CLV alongside win rate
// (not win rate alone), with an explicit false-edge flag for markets that
// look good on hit rate but don't survive contact with the vig.

import {
  impliedProb,
  isUnbettableJuice,
  noVigProb,
  passesOverBreakeven,
  unitProfit,
} from "./oddsmath.ts";

export type PickSide = "over" | "under" | "home" | "away";

export interface GradedPick {
  eventId: string;
  playerId: number;
  playerName: string;
  commenceTime: string; // ISO
  pickSide: PickSide;
  line: number;
  entryOdds: number;
  entryBookmaker: string;
  otherSideEntryOdds: number | null; // for no-vig fair-prob calc
  closingOdds: number | null;
  closingBookmaker: string | null;
  confidence: number; // post D-784 calibration — what a user would see
  confidencePreCap: number;
  projectedStat: number;
  contextCompleteness: number;
  suppressedLeakRiskFactors: string[];
  actualStat: number | null;
  hit: boolean | null; // null = push
  voided: boolean;
  voidReason?: string;
  /** D-691 win-probability path (batter_hits). */
  winProb?: number;
  edgeVsImplied?: number;
  evPerUnit?: number;
  unbettableOverBreakevenFlag?: boolean;
}

export interface ExcludedCandidate {
  eventId: string;
  playerName: string;
  line: number;
  reason:
    | "player_unresolved"
    | "no_agreeing_side"
    | "no_entry_price_for_agreeing_side"
    | "event_not_found"
    | "context_build_failed";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Wilson score interval (95% by default) — much better small-sample coverage
// than a naive normal-approximation CI on win rate.
// ---------------------------------------------------------------------------
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.959963985,
): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lo: Math.max(0, (center - margin) / denom),
    hi: Math.min(1, (center + margin) / denom),
  };
}

// ---------------------------------------------------------------------------
// Bootstrap CI on mean ROI (per-unit profit). Resampling-based so it doesn't
// assume a parametric win/loss distribution — appropriate given the mixed
// payout sizes across different American-odds lines.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMeanCI(
  values: number[],
  iterations = 2000,
  seed = 20260701,
): { mean: number; lo: number; hi: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, lo: mean, hi: mean };
  const rng = mulberry32(seed);
  const means: number[] = new Array(iterations);
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sum += values[idx];
    }
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * iterations)];
  const hi = means[Math.min(iterations - 1, Math.floor(0.975 * iterations))];
  return { mean, lo, hi };
}

// ---------------------------------------------------------------------------
// Per-tier / per-side metrics.
// ---------------------------------------------------------------------------
export interface TierMetrics {
  tierLabel: string;
  minConfidence: number;
  side: "all" | PickSide;
  n: number;
  graded: number; // wins + losses (excludes pushes/voids)
  pushes: number;
  voids: number;
  wins: number;
  losses: number;
  winRatePct: number;
  winRateCiLoPct: number;
  winRateCiHiPct: number;
  roiPct: number;
  roiCiLoPct: number;
  roiCiHiPct: number;
  totalUnits: number;
  avgClvPct: number | null;
  pctPositiveClvPct: number | null;
  clvN: number;
  avgNoVigFairProbPct: number | null;
  avgEntryImpliedProbPct: number;
  falseEdgeFlag: boolean;
  brierScore: number | null;
}

/** Live-surface picks: conf >= 60, not unbettable under juice, overs must clear implied BE. */
export function isEvPassPick(pick: GradedPick): boolean {
  if (pick.confidence < 60) return false;
  if (isUnbettableJuice(pick.confidence, pick.entryOdds, pick.pickSide))
    return false;
  if (
    pick.pickSide === "over" &&
    !passesOverBreakeven(pick.confidence, pick.entryOdds)
  )
    return false;
  return true;
}

/** Alias for live-surface parity — identical filter to isEvPassPick post-M2. */
export function isRecommendablePick(pick: GradedPick): boolean {
  return isEvPassPick(pick);
}

/** M3 production surface: ev_pass + positive EV (batter_hits recommendation_shown). */
export function isEvFilteredPick(pick: GradedPick): boolean {
  if (!isEvPassPick(pick)) return false;
  return (pick.evPerUnit ?? -Infinity) > 0;
}

/** Production parity alias for batter_hits recommendation_shown. */
export function isRecommendationShownPick(pick: GradedPick): boolean {
  return isEvFilteredPick(pick);
}

export interface TierFilterOptions {
  recommendableOnly?: boolean;
  evPassOnly?: boolean;
  evFilteredOnly?: boolean;
}

function filterPicks(
  picks: GradedPick[],
  minConfidence: number,
  side: "all" | PickSide,
  options: TierFilterOptions = {},
): GradedPick[] {
  const {
    recommendableOnly = false,
    evPassOnly = false,
    evFilteredOnly = false,
  } = options;
  return picks.filter(
    (p) =>
      p.confidence >= minConfidence &&
      (side === "all" || p.pickSide === side) &&
      (!recommendableOnly || isRecommendablePick(p)) &&
      (!evPassOnly || isEvPassPick(p)) &&
      (!evFilteredOnly || isEvFilteredPick(p)),
  );
}

export function computeTierMetrics(
  picks: GradedPick[],
  minConfidence: number,
  side: "all" | PickSide,
  tierLabel: string,
  options: TierFilterOptions = {},
): TierMetrics {
  const scoped = filterPicks(picks, minConfidence, side, options);
  const gradedPicks = scoped.filter((p) => !p.voided && p.hit !== null);
  const pushes = scoped.filter((p) => !p.voided && p.hit === null).length;
  const voids = scoped.filter((p) => p.voided).length;
  const wins = gradedPicks.filter((p) => p.hit === true).length;
  const losses = gradedPicks.filter((p) => p.hit === false).length;
  const graded = wins + losses;

  const winRatePct = graded > 0 ? (wins / graded) * 100 : 0;
  const wilson = wilsonInterval(wins, graded);

  const unitProfits = gradedPicks.map((p) =>
    unitProfit(p.entryOdds, p.hit === true),
  );
  const roiBoot = bootstrapMeanCI(unitProfits);
  const totalUnits = unitProfits.reduce((a, b) => a + b, 0);

  const clvPicks = scoped.filter((p) => p.closingOdds !== null);
  const clvValues = clvPicks.map((p) => {
    const entryImplied = impliedProb(p.entryOdds);
    const closingImplied = impliedProb(p.closingOdds as number);
    return (closingImplied - entryImplied) * 100;
  });
  const avgClvPct =
    clvValues.length > 0
      ? clvValues.reduce((a, b) => a + b, 0) / clvValues.length
      : null;
  const pctPositiveClvPct =
    clvValues.length > 0
      ? (clvValues.filter((v) => v > 0).length / clvValues.length) * 100
      : null;

  const fairProbs = scoped
    .filter((p) => p.otherSideEntryOdds !== null)
    .map((p) => noVigProb(p.entryOdds, p.otherSideEntryOdds as number) * 100);
  const avgNoVigFairProbPct =
    fairProbs.length > 0
      ? fairProbs.reduce((a, b) => a + b, 0) / fairProbs.length
      : null;

  const avgEntryImpliedProbPct =
    scoped.length > 0
      ? (scoped.reduce((sum, p) => sum + impliedProb(p.entryOdds), 0) /
          scoped.length) *
        100
      : 0;

  const brierScore = gradedPicks.length > 0 && gradedPicks.some(p => p.winProb !== undefined)
    ? gradedPicks.reduce((sum, p) => {
        const prob = p.winProb ?? (p.confidence / 100);
        return sum + Math.pow(prob - (p.hit ? 1 : 0), 2);
      }, 0) / gradedPicks.length
    : null;

  // False-edge flag: the hit rate is clearly better than a coin flip (Wilson
  // lower bound > 50%) but ROI is not statistically distinguishable from
  // break-even-or-worse (bootstrap upper bound <= 0). This is exactly the
  // "looks good on win rate, loses at scale" pattern the harness exists to
  // catch — heavily-juiced favorites are the classic false-edge shape.
  const falseEdgeFlag = graded >= 20 && wilson.lo > 0.5 && roiBoot.hi <= 0;

  return {
    tierLabel,
    minConfidence,
    side,
    n: scoped.length,
    graded,
    pushes,
    voids,
    wins,
    losses,
    winRatePct,
    winRateCiLoPct: wilson.lo * 100,
    winRateCiHiPct: wilson.hi * 100,
    roiPct: roiBoot.mean * 100,
    roiCiLoPct: roiBoot.lo * 100,
    roiCiHiPct: roiBoot.hi * 100,
    totalUnits,
    avgClvPct,
    pctPositiveClvPct,
    clvN: clvValues.length,
    avgNoVigFairProbPct,
    avgEntryImpliedProbPct,
    falseEdgeFlag,
    brierScore,
  };
}

/** M3/M5 go/no-go gate on ev_filtered / all tier metrics. */
export interface EvGateResult {
  pass: boolean;
  graded: number;
  roiPct: number;
  roiCiLoPct: number;
  roiCiHiPct: number;
  avgClvPct: number | null;
  pctPositiveClvPct: number | null;
  clvN: number;
  bonusClvPositive: boolean;
  reason: string;
}

/** @deprecated Use EvGateResult */
export type M3GateResult = EvGateResult;

const EV_GATE_MIN_GRADED = 500;

export type EvGateSide = "all" | PickSide;

export function evaluateEvGate(
  tiers: TierMetrics[],
  side: EvGateSide = "all",
  tierLabel = "ev_filtered",
): EvGateResult {
  const tier = tiers.find(
    (t) => t.tierLabel === tierLabel && t.side === side,
  );
  if (!tier) {
    return {
      pass: false,
      graded: 0,
      roiPct: 0,
      roiCiLoPct: 0,
      roiCiHiPct: 0,
      avgClvPct: null,
      pctPositiveClvPct: null,
      clvN: 0,
      bonusClvPositive: false,
      reason: `${tierLabel}/${side} tier not found`,
    };
  }

  const bonusClvPositive =
    tier.avgClvPct !== null && tier.avgClvPct > 0;

  if (tier.graded === 0) {
    return {
      pass: false,
      graded: 0,
      roiPct: tier.roiPct,
      roiCiLoPct: tier.roiCiLoPct,
      roiCiHiPct: tier.roiCiHiPct,
      avgClvPct: tier.avgClvPct,
      pctPositiveClvPct: tier.pctPositiveClvPct,
      clvN: tier.clvN,
      bonusClvPositive,
      reason: `no graded picks in ${tierLabel} slice`,
    };
  }

  const pass =
    tier.graded >= EV_GATE_MIN_GRADED
      ? tier.roiPct > 0
      : tier.roiCiLoPct > 0;

  const baseReason = tier.graded >= EV_GATE_MIN_GRADED
    ? pass
      ? `graded n=${tier.graded} >= ${EV_GATE_MIN_GRADED} and ROI ${tier.roiPct.toFixed(2)}% > 0%`
      : `graded n=${tier.graded} >= ${EV_GATE_MIN_GRADED} but ROI ${tier.roiPct.toFixed(2)}% <= 0%`
    : pass
    ? `graded n=${tier.graded} < ${EV_GATE_MIN_GRADED} but ROI CI lower bound ${tier.roiCiLoPct.toFixed(2)}% > 0%`
    : `graded n=${tier.graded} < ${EV_GATE_MIN_GRADED} and ROI CI lower bound ${tier.roiCiLoPct.toFixed(2)}% <= 0%`;
  const reason = side === "all" ? baseReason : `${side}-only: ${baseReason}`;

  return {
    pass,
    graded: tier.graded,
    roiPct: tier.roiPct,
    roiCiLoPct: tier.roiCiLoPct,
    roiCiHiPct: tier.roiCiHiPct,
    avgClvPct: tier.avgClvPct,
    pctPositiveClvPct: tier.pctPositiveClvPct,
    clvN: tier.clvN,
    bonusClvPositive,
    reason,
  };
}

/** Backward-compatible alias for M3 batter_hits gate runs. */
export const evaluateM3Gate = evaluateEvGate;

/** M6 — per-side ev_filtered gate verdicts for side-restricted surfaces. */
export interface SideEvGateResults {
  all: EvGateResult;
  over: EvGateResult;
  under: EvGateResult;
  home?: EvGateResult;
  away?: EvGateResult;
}

export function evaluateAllSideEvGates(
  tiers: TierMetrics[],
  tierLabel = "ev_filtered",
): SideEvGateResults {
  const hasHome = tiers.some((t) => t.side === "home");
  return {
    all: evaluateEvGate(tiers, "all", tierLabel),
    over: evaluateEvGate(tiers, "over", tierLabel),
    under: evaluateEvGate(tiers, "under", tierLabel),
    ...(hasHome
      ? {
          home: evaluateEvGate(tiers, "home", tierLabel),
          away: evaluateEvGate(tiers, "away", tierLabel),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Calibration reliability — calibrated confidence bucket vs realized WR.
// ---------------------------------------------------------------------------
export interface CalibrationBucket {
  bucketLabel: string;
  lo: number;
  hi: number;
  n: number;
  avgConfidence: number;
  realizedWinRatePct: number;
}

export function computeCalibrationBuckets(
  picks: GradedPick[],
): CalibrationBucket[] {
  const bucketsDef = [
    [0, 60],
    [60, 70],
    [70, 80],
    [80, 90],
    [90, 101],
  ] as const;
  const out: CalibrationBucket[] = [];
  for (const [lo, hi] of bucketsDef) {
    const inBucket = picks.filter(
      (p) =>
        p.confidence >= lo && p.confidence < hi && !p.voided && p.hit !== null,
    );
    const wins = inBucket.filter((p) => p.hit === true).length;
    out.push({
      bucketLabel: hi >= 101 ? `${lo}+` : `${lo}-${hi - 1}`,
      lo,
      hi,
      n: inBucket.length,
      avgConfidence:
        inBucket.length > 0
          ? inBucket.reduce((a, p) => a + p.confidence, 0) / inBucket.length
          : 0,
      realizedWinRatePct:
        inBucket.length > 0 ? (wins / inBucket.length) * 100 : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cumulative units + max drawdown (chronological order, flat 1u staking).
// ---------------------------------------------------------------------------
export interface DrawdownResult {
  finalCumulativeUnits: number;
  maxDrawdownUnits: number;
  peakUnits: number;
  n: number;
}

export function computeDrawdown(
  picksChronological: GradedPick[],
): DrawdownResult {
  const graded = picksChronological
    .filter((p) => !p.voided && p.hit !== null)
    .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const p of graded) {
    cumulative += unitProfit(p.entryOdds, p.hit === true);
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return {
    finalCumulativeUnits: cumulative,
    maxDrawdownUnits: maxDrawdown,
    peakUnits: peak,
    n: graded.length,
  };
}

// ---------------------------------------------------------------------------
// Baselines. SharpAI's ROI/CLV must beat these to demonstrate a real edge
// rather than a market-structure artifact.
// ---------------------------------------------------------------------------
export interface BaselineResult {
  label: string;
  n: number;
  winRatePct: number;
  roiPct: number;
}

/** Bet the side the market itself favors (lower payout / higher implied
 *  probability) on every gradeable candidate — mirrors the convention
 *  already used by backtest-mlb-v3-historical's market_baseline mode
 *  (`side = overP > underP ? "over" : "under"`). A real algo edge should
 *  beat blindly following the market's own favorite. */
export function computeMarketFavoriteBaseline(
  allGradablePairs: Array<{
    overOdds: number | null;
    underOdds: number | null;
    actualStat: number | null;
    line: number;
  }>,
): BaselineResult {
  const rows = allGradablePairs.filter(
    (r) => r.overOdds !== null && r.underOdds !== null && r.actualStat !== null,
  );
  let wins = 0;
  const profits: number[] = [];
  for (const r of rows) {
    const overP = impliedProb(r.overOdds as number);
    const underP = impliedProb(r.underOdds as number);
    const side: PickSide = overP > underP ? "over" : "under";
    const odds =
      side === "over" ? (r.overOdds as number) : (r.underOdds as number);
    const actual = r.actualStat as number;
    if (Math.abs(actual - r.line) < 0.0001) continue; // push — excluded from graded set
    const hit = side === "over" ? actual > r.line : actual < r.line;
    if (hit) wins++;
    profits.push(unitProfit(odds, hit));
  }
  const n = profits.length;
  return {
    label: "market_favorite",
    n,
    winRatePct: n > 0 ? (wins / n) * 100 : 0,
    roiPct: n > 0 ? (profits.reduce((a, b) => a + b, 0) / n) * 100 : 0,
  };
}

/** Flat-bet-all baseline is just the "all" tier row itself (every taken
 *  candidate regardless of confidence) — exposed here as a labeled
 *  standalone metric so it reads clearly next to the other baselines
 *  instead of requiring the reader to cross-reference the tier table. */
export function computeFlatBetAllBaseline(picks: GradedPick[]): BaselineResult {
  const graded = picks.filter((p) => !p.voided && p.hit !== null);
  const wins = graded.filter((p) => p.hit === true).length;
  const profits = graded.map((p) => unitProfit(p.entryOdds, p.hit === true));
  const n = graded.length;
  return {
    label: "flat_bet_all",
    n,
    winRatePct: n > 0 ? (wins / n) * 100 : 0,
    roiPct: n > 0 ? (profits.reduce((a, b) => a + b, 0) / n) * 100 : 0,
  };
}

/** Theoretical zero-skill baseline: expected ROI of a true-50%-win-rate
 *  bettor facing the SAME odds distribution the algo actually got. Shows
 *  what ROI pure chance would produce given the market's vig structure —
 *  SharpAI's ROI must clear this by a real margin, not just be "less
 *  negative than -100%". */
export function computeCoinFlipBaseline(picks: GradedPick[]): BaselineResult {
  const graded = picks.filter((p) => !p.voided && p.hit !== null);
  const evs = graded.map((p) => {
    const b = unitProfit(p.entryOdds, true);
    return 0.5 * b + 0.5 * -1;
  });
  const n = evs.length;
  return {
    label: "coin_flip_ev",
    n,
    winRatePct: 50,
    roiPct: n > 0 ? (evs.reduce((a, b) => a + b, 0) / n) * 100 : 0,
  };
}
