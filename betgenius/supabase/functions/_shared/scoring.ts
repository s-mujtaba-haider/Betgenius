// _shared/scoring.ts — Single source of truth for player-prop scoring math.
//
// Imported by:
//   - supabase/functions/process-games/index.ts (Dashboard cron)
//   - supabase/functions/analyze-pick/index.ts  (Evaluator)
//
// D-155 (May 14, 2026, CEO §19.3): extracted from process-games to close
// D-148 v2 Finding #1 (Evaluator/Dashboard scoring divergence). Pure-math
// only — no module-level mutable state, no Deno.serve, no top-level fetches
// (except loadWeightsFromDB which is a self-contained startup helper).
// Callers load state (BDL injuries, game-line cache) and pass into scoring
// functions via the `helpers` parameter on scoreOneSide.
//
// FORMULA POLICY (CEO §19.3):
//   - calculateConfidenceScore uses score_season 4-bucket (10/3/0/-8)
//     — NOT analyze-pick's prior score_trend 6-bucket
//   - All factors multiplied by weights from algorithm_weights DB row
//     (analyze-pick previously used unweighted raw arithmetic)
//   - scoreOneSide applies 13 post-calc bonuses + D-127 trivial cap (L1)
//     + D-140 layer-2 cap + D-142 verdict-from-finalScore + D-136/D-137/
//     D-139 new factors

// =============================================================================
// TYPES
// =============================================================================

export interface ScoringWeights {
  l5: number; l10: number; season: number; floorCeiling: number;
  recentForm: number; homeAway: number; rest: number; b2b: number;
  minutesTrend: number; pace: number; oppDefense: number;
  propType: number; zScore: number; roleChange: number; vigFilter: number;
  usgRate: number; regression: number; marketConf: number; haSplit: number;
  minutesFloor: number; consistency: number; staleData: number; playerInjury: number;
  lowMinRisk: number;    // D-136 Tier 2 #7
  blowoutRisk: number;   // D-137 Tier 2 #6 V0-B
  lineMovement: number;  // D-139 Tier 2 #5 V0
}

export interface ExtractedProp {
  playerName: string;
  propType: string;
  line: number;
  odds: number;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  bookmaker?: string;
  availableBooks?: Array<{ bookmaker: string; line: number; odds: number; pick_side: string }>;
}

export interface GameLogEntry {
  date: string;
  opponent: string;
  homeAway: string;
  stats: Record<string, number>;
}

export interface PlayerResult {
  id: string;
  displayName: string;
  team: string;
  position: string;
}

export interface MinutesTrend {
  l5Avg: number;
  l10Avg: number;
  direction: "up" | "down" | "stable";
  score: number;
}

export interface AbsenceInfo {
  daysGap: number;
  gamesEstimate: number;
  fromDate: string;
  toDate: string;
}

export interface OpponentStats {
  pointsAllowedPerGame: number;
  reboundsAllowedPerGame: number;
  assistsAllowedPerGame: number;
  oppFieldGoalPct: number;
  oppThreePointPct: number;
  pace: number;
  defensiveRating: number;
  defenseRank: string;
  oppOwnTurnovers: number;
  oppOwnSteals: number;
  oppOwnBlocks: number;
  oppOwnTwoPtFGPct: number;
  oppOwnThreePtFGPct: number;
  oppOwnFGPct: number;
  oppPaceFactor: number;
  // D-186 (May 15, 2026): GOAT per-opp-position advanced metrics. Keys are
  // normalized positions: PG/SG/SF/PF/C. Optional — populated only when
  // cache_team_advanced_stats_by_position has rows for the snapshot. Used by
  // calculatePaceDefenseScores rebounds + assists branches for position-aware
  // matchup signal that's strictly additive over the team-level baseline.
  defensiveRatingVsPosition?: Record<string, number>;
  defensiveReboundPctVsPosition?: Record<string, number>;
  assistPctVsPosition?: Record<string, number>;
}

export interface PropAnalysisResult {
  playerName: string;
  team: string;
  propType: string;
  line: number;
  pickSide: "over" | "under";
  odds: number;
  confidence: number;
  // D-406: pre-cap confidence (BEFORE Layer-2 D-140 cap at scoring.ts:1144).
  // Layer-1 cap effect is already baked in; caveat documented.
  confidence_pre_cap?: number;
  verdict: string;
  // D-164 (May 14, 2026): unbettable juice gate per confidence tier.
  unbettableJuiceFlag?: boolean;
  // D-166 (May 14, 2026): coin-flip sanity check (Elite + ~50% season).
  coinFlipFlag?: boolean;
  // D-167 (May 14, 2026): Failure Mode D — Elite + 3+ negative factors.
  negativeStackingFlag?: boolean;
  negativeFactorCount?: number;
  hitRates: { l5: string; l10: string; season: string };
  hitRatesRaw?: { l5Hits: number; l10Hits: number; seasonRate: number; seasonHits: number; seasonTotal: number };
  gamesPlayed?: number;
  seasonAvg?: number;
  recentAvg?: number;
  floor?: number;
  ceiling?: number;
  last5Values?: number[];
  isHome?: boolean;
  aiAnalysis?: string | null;
  isBackToBack?: boolean;
  restDays?: number;
  minutesTrend?: MinutesTrend;
  oppStats?: OpponentStats | null;
  breakdown?: Record<string, number>;
  opponent?: string;
  gameTime?: string;
  absenceInfo?: AbsenceInfo | null;
  projectionData?: { projectedStat: number; statStdDev: number; zScore: number; perMinRate: number; projectedMinutes: number; teammateInjuriesCount: number; usageBoost: number };
  // D-198 (May 17, 2026): Tier-Aware Scoring (Tier 4 #11) audit. Captures
  // finalScore BEFORE per-tier weight modifiers apply. On initial ship
  // (identity 1.0 multipliers), confidence_pre_tier_aware === confidence.
  // Diverges once §19.3 tunes individual multipliers in
  // algorithm_weights_tier_modifiers table.
  confidence_pre_tier_aware?: number | null;
  _prop?: ExtractedProp;
}

// D-198 — Tier-Aware Scoring multiplier table shape, fetched from
// public.algorithm_weights_tier_modifiers and applied as a second pass
// in scoreOneSide after the initial confidence stabilises. Structured
// as Map<tier, Map<factorName, multiplier>>; absent entries default to
// 1.0 (identity, no behavior change).
export type TierName = "elite" | "strong" | "good" | "lean" | "pass";
export type TierModifiers = Map<TierName, Map<string, number>>;

// D-201 (Batch 2 Task 2.3) — fetch tier multipliers from DB. Returns
// null on any failure (callers default to identity). Cached at the
// cron-tick level by caller; do NOT cache module-level here (per-cron
// freshness wanted in case CEO §19.3 hot-tunes a multiplier).
export async function loadTierModifiersFromDB(): Promise<TierModifiers | null> {
  try {
    const url = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get("SUPABASE_URL");
    const key = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env?.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return null;
    const res = await fetch(`${url}/rest/v1/algorithm_weights_tier_modifiers?select=tier,factor_name,multiplier`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const out: TierModifiers = new Map();
    for (const r of rows) {
      const t = String(r.tier) as TierName;
      const f = String(r.factor_name);
      const m = Number(r.multiplier);
      if (!Number.isFinite(m)) continue;
      let inner = out.get(t);
      if (!inner) { inner = new Map<string, number>(); out.set(t, inner); }
      inner.set(f, m);
    }
    return out;
  } catch (_e) {
    return null;
  }
}

export interface CachedPlayerData {
  player: PlayerResult;
  gameLog: GameLogEntry[];
  minutesTrend: MinutesTrend;
}

export interface GameLineSnapshot {
  spread: number | null;
  favoredTeam: string | null;
  spreadT0: number | null;
}

export interface BdlInjury {
  playerName: string;
  status: string;
  description: string;
  teamName: string;
  returnDate: string | null;
}

export interface ScoreOneSideHelpers {
  getTeamInjuries: (team: string) => Promise<string[]>;
  getGameLine: (homeTeam: string, awayTeam: string, gameDate: string) => GameLineSnapshot | null;
  getPlayerInjury: (playerName: string, teamName: string) => { isInjured: boolean; status: string; penalty: number };
  asOfDate?: Date;
  // D-198 — optional tier-modifier table; absent or null means identity
  // (1.0 multipliers, no behavior change). Cron tick fetches once at
  // start and threads through every per-pick scoreOneSide invocation.
  tierModifiers?: TierModifiers | null;
}

// D-198 — derive tier from confidence using the D-101 thresholds. Mirrors
// getScoreLabel but returns the lowercase tier name used as the key into
// algorithm_weights_tier_modifiers.
export function tierFromConfidence(c: number): TierName {
  if (c >= 90) return "elite";
  if (c >= 80) return "strong";
  if (c >= 70) return "good";
  if (c >= 60) return "lean";
  return "pass";
}

// D-198 — apply tier-modifier deltas. For each factor in the breakdown,
// compute (multiplier - 1.0) × baseWeight × factorMagnitude and add to
// score. With identity (1.0) multipliers, all deltas are zero and the
// final score equals the pre-modifier score.
//
// Breakdown key → ScoringWeights key map. Must enumerate every factor
// captured in breakdown that should be tier-adjustable. Order doesn't
// matter — sum is commutative.
const TIER_MODIFIER_KEY_MAP: Record<string, keyof ScoringWeights> = {
  l5HitRate: "l5",
  l10HitRate: "l10",
  seasonHitRate: "season",
  floorCeiling: "floorCeiling",
  recentForm: "recentForm",
  homeAway: "homeAway",
  restDays: "rest",
  backToBack: "b2b",
  minutesTrend: "minutesTrend",
  pace: "pace",
  opponentDefense: "oppDefense",
  propTypePenalty: "propType",
  zScoreBonus: "zScore",
  consistencyBonus: "consistency",
  roleChangeBonus: "roleChange",
  vigFilterPenalty: "vigFilter",
  usgBonus: "usgRate",
  regressionBonus: "regression",
  marketConfBonus: "marketConf",
  homeAwaySplitBonus: "haSplit",
  minutesVolumeBonus: "minutesFloor",
  minutesStabilityBonus: "minutesFloor",
  staleDataPenalty: "staleData",
  playerInjuryPenalty: "playerInjury",
  lowMinRiskPenalty: "lowMinRisk",
  blowoutRiskPenalty: "blowoutRisk",
  lineMovementBonus: "lineMovement",
};

export function applyTierAwareModifiers(
  preTierAwareScore: number,
  breakdown: Record<string, number>,
  weights: ScoringWeights,
  tierModifiers: TierModifiers | null | undefined,
): number {
  if (!tierModifiers) return preTierAwareScore;
  const tier = tierFromConfidence(preTierAwareScore);
  const tierMap = tierModifiers.get(tier);
  if (!tierMap) return preTierAwareScore;
  let delta = 0;
  for (const [bkKey, weightKey] of Object.entries(TIER_MODIFIER_KEY_MAP)) {
    const magnitude = breakdown[bkKey];
    if (typeof magnitude !== "number" || magnitude === 0) continue;
    const multiplier = tierMap.get(weightKey) ?? 1.0;
    if (multiplier === 1.0) continue;
    const baseWeight = weights[weightKey];
    if (typeof baseWeight !== "number" || baseWeight === 0) continue;
    delta += Math.round(magnitude * baseWeight * (multiplier - 1));
  }
  return Math.max(0, Math.min(100, preTierAwareScore + delta));
}

// =============================================================================
// WEIGHTS
// =============================================================================

export function getDefaultWeights(): ScoringWeights {
  return {
    l5: 1.0, l10: 0.0, season: 1.75, floorCeiling: 1.5,
    recentForm: 1.5, homeAway: 0.0, rest: 0.0, b2b: 2.25,
    minutesTrend: 0.0, pace: 0.5, oppDefense: 0.0,
    propType: 0.25, zScore: 0.25, roleChange: 2.0, vigFilter: 0.0,
    usgRate: 1.0, regression: 1.0, marketConf: 2.0, haSplit: 0.0,
    minutesFloor: 2.5, consistency: 1.0, staleData: 2.25, playerInjury: 0.75,
    lowMinRisk: 1.0,
    blowoutRisk: 1.0,
    lineMovement: 1.0,
  };
}

export async function loadWeightsFromDB(): Promise<ScoringWeights> {
  const fallback = getDefaultWeights();
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) { console.log("[weights] No DB credentials, using defaults"); return fallback; }
    const res = await fetch(url + "/rest/v1/algorithm_weights?id=eq.1&select=*", {
      headers: { "apikey": key, "Authorization": "Bearer " + key }
    });
    if (!res.ok) { console.log("[weights] DB fetch failed: " + res.status); return fallback; }
    const rows = await res.json();
    if (rows.length === 0) { console.log("[weights] No weights row found, using defaults"); return fallback; }
    const w = rows[0];
    const loaded: ScoringWeights = {
      l5: w.w_l5 ?? 1.0, l10: w.w_l10 ?? 0.0, season: w.w_season ?? 1.75,
      floorCeiling: w.w_floor_ceiling ?? 1.5, recentForm: w.w_recent_form ?? 1.5,
      homeAway: w.w_home_away ?? 0.0, rest: w.w_rest ?? 0.0, b2b: w.w_b2b ?? 2.25,
      minutesTrend: w.w_minutes_trend ?? 0.0, pace: w.w_pace ?? 0.5, oppDefense: w.w_opp_defense ?? 0.0,
      propType: w.w_prop_type ?? 0.25, zScore: w.w_z_score ?? 0.25, roleChange: w.w_role_change ?? 2.0,
      vigFilter: w.w_vig_filter ?? 0.0, usgRate: w.w_usg_rate ?? 1.0, regression: w.w_regression ?? 1.0,
      marketConf: w.w_market_conf ?? 2.0, haSplit: w.w_ha_split ?? 0.0,
      minutesFloor: w.w_minutes_floor ?? 2.5, consistency: w.w_consistency ?? 1.0,
      staleData: w.w_stale_data ?? 2.25, playerInjury: w.w_player_injury ?? 0.75,
      lowMinRisk: w.w_low_min_risk ?? 1.0,
      blowoutRisk: w.w_blowout_risk ?? 1.0,
      lineMovement: w.w_line_movement ?? 1.0,
    };
    console.log("[weights] Loaded from DB: win_pct=" + (w.backtest_win_pct || "n/a") + " roi=" + (w.backtest_roi || "n/a"));
    return loaded;
  } catch (err) {
    console.log("[weights] Error loading: " + err + " — using defaults");
    return fallback;
  }
}

// =============================================================================
// STAT LOOKUPS / DNP FILTER
// =============================================================================

// D-246 (2026-05-19): label arrays semantics = FALLBACK LIST (try in order,
// first non-undefined wins). Previously the loop SUMmed across labels, which
// is the wrong shape for multi-source key drift. Threes specifically: ESPN
// gamelogs return key "3PT" (made-attempted format e.g. "3-7" or numeric);
// BDL returns "3PM". Pre-D-246 PROP_STAT_MAP listed only "3PM" → ESPN-source
// rows produced stats[3PM] === undefined → getStatValue returned null →
// scoreOneSide skipped both sides → ZERO threes picks in production for 90
// days. Adding "3PT" as fallback unblocks ESPN-source threes scoring.
export const PROP_STAT_MAP: Record<string, string[]> = {
  points: ["PTS"], rebounds: ["REB"], assists: ["AST"], threes: ["3PM", "3PT"],
  steals: ["STL"], blocks: ["BLK"], turnovers: ["TO"],
  player_points: ["PTS"], player_rebounds: ["REB"], player_assists: ["AST"],
  player_threes: ["3PM", "3PT"], player_steals: ["STL"], player_blocks: ["BLK"],
  player_turnovers: ["TO"],
};

export function getStatValue(stats: Record<string, number>, propType: string): number | null {
  const normalizedProp = propType.replace("player_", "");
  const labels = PROP_STAT_MAP[propType] ?? PROP_STAT_MAP[normalizedProp];
  if (!labels) {
    if (stats[propType] !== undefined) return stats[propType];
    return null;
  }
  // D-246: fallback-list semantics. First label present wins. If none present,
  // null (existing behavior for the single-label cases — semantics-preserving).
  for (const label of labels) {
    if (stats[label] !== undefined) return stats[label];
  }
  return null;
}

export function isDNPGame(game: GameLogEntry): boolean {
  const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"];
  return mins === undefined || mins === null || mins === 0;
}

// =============================================================================
// PURE-MATH HELPERS (14)
// =============================================================================

export function calcHitRates(games: GameLogEntry[], propType: string, line: number, pickSide: string) {
  const values: number[] = [];
  for (const g of games) {
    if (isDNPGame(g)) continue;
    const v = getStatValue(g.stats, propType);
    if (v !== null) values.push(v);
  }
  if (!values.length) {
    return { l5: { hits: 0, total: 0, rate: 0 }, l10: { hits: 0, total: 0, rate: 0 }, season: { hits: 0, total: 0, rate: 0 }, values };
  }
  const hitFn = pickSide === "over" ? (v: number) => v > line : (v: number) => v < line;
  function rate(slice: number[]) {
    const hits = slice.filter(hitFn).length;
    return { hits, total: slice.length, rate: slice.length ? (hits / slice.length) * 100 : 0 };
  }
  return { l5: rate(values.slice(0, 5)), l10: rate(values.slice(0, 10)), season: rate(values), values };
}

export function calculateMinutesTrend(gameLog: GameLogEntry[]): MinutesTrend {
  const minutesValues: number[] = [];
  for (const game of gameLog) {
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"];
    if (typeof mins === "number" && mins > 0) minutesValues.push(mins);
  }
  if (minutesValues.length < 5) return { l5Avg: 0, l10Avg: 0, direction: "stable", score: 0 };
  const l5Values = minutesValues.slice(0, 5);
  const l10Values = minutesValues.slice(0, Math.min(10, minutesValues.length));
  const l5Avg = l5Values.reduce((a, b) => a + b, 0) / l5Values.length;
  const l10Avg = l10Values.reduce((a, b) => a + b, 0) / l10Values.length;
  const diff = l5Avg - l10Avg;
  let direction: "up" | "down" | "stable" = "stable";
  let score = 0;
  if (diff >= 5) { direction = "up"; score = 5; }
  else if (diff >= 3) { direction = "up"; score = 3; }
  else if (diff <= -5) { direction = "down"; score = -5; }
  else if (diff <= -3) { direction = "down"; score = -3; }
  return { l5Avg: Math.round(l5Avg * 10) / 10, l10Avg: Math.round(l10Avg * 10) / 10, direction, score };
}

export function detectRecentAbsence(gameLog: GameLogEntry[]): AbsenceInfo | null {
  if (gameLog.length < 2) return null;
  const recentGames = gameLog.slice(0, 5);
  for (let i = 0; i < recentGames.length - 1; i++) {
    const currentGame = recentGames[i];
    const previousGame = recentGames[i + 1];
    if (!currentGame.date || !previousGame.date) continue;
    const currentDate = new Date(currentGame.date);
    const previousDate = new Date(previousGame.date);
    if (isNaN(currentDate.getTime()) || isNaN(previousDate.getTime())) continue;
    const daysGap = Math.floor((currentDate.getTime() - previousDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysGap >= 5) {
      const gamesEstimate = Math.floor(daysGap / 2);
      const fromDateStr = previousDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const toDateStr = currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return { daysGap, gamesEstimate, fromDate: fromDateStr, toDate: toDateStr };
    }
  }
  return null;
}

export function calculateStdDev(values: number[]): number {
  if (values.length < 3) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

export function calculatePerMinuteRate(gameLog: GameLogEntry[], propType: string): number {
  let weightedStat = 0, weightedMinutes = 0;
  const recent = gameLog.slice(0, 10);
  for (let i = 0; i < recent.length; i++) {
    const game = recent[i];
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    const stat = getStatValue(game.stats, propType);
    if (mins > 0 && stat !== null) {
      const weight = i < 5 ? 2 : 1;
      weightedStat += stat * weight;
      weightedMinutes += mins * weight;
    }
  }
  return weightedMinutes > 0 ? Math.round((weightedStat / weightedMinutes) * 1000) / 1000 : 0;
}

export function projectMinutes(gameLog: GameLogEntry[], isB2B: boolean): number {
  const minutesValues: number[] = [];
  for (const game of gameLog.slice(0, 10)) {
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (mins > 0) minutesValues.push(mins);
  }
  if (!minutesValues.length) return 0;
  const l5 = minutesValues.slice(0, 5);
  const l6_10 = minutesValues.slice(5);
  const l5Avg = l5.reduce((a, b) => a + b, 0) / l5.length;
  const l6_10Avg = l6_10.length ? l6_10.reduce((a, b) => a + b, 0) / l6_10.length : l5Avg;
  let projected = (l5Avg * 2 + l6_10Avg) / 3;
  if (isB2B) projected *= 0.93;
  return Math.round(projected * 10) / 10;
}

export function computeProjectedStat(perMinRate: number, projectedMins: number, paceScore: number): number {
  const paceFactor = 1 + (paceScore * 0.01);
  return Math.round(perMinRate * projectedMins * paceFactor * 100) / 100;
}

export function calculateZScore(projected: number, line: number, stdev: number, pickSide: "over" | "under"): number {
  if (stdev <= 0) return 0;
  const edge = pickSide === "over" ? projected - line : line - projected;
  return Math.round((edge / stdev) * 100) / 100;
}

export function calculateUsageBoost(teamInjuries: string[], playerMinutes: number): { boostPct: number; injuredCount: number } {
  const significantInjuries = teamInjuries.filter(inj => {
    const lower = inj.toLowerCase();
    return lower.includes("out") || lower.includes("day-to-day");
  });
  const count = significantInjuries.length;
  const isStarter = playerMinutes >= 25;
  let boostPct = 0;
  if (count >= 3) boostPct = isStarter ? 0.10 : 0.05;
  else if (count >= 2) boostPct = isStarter ? 0.06 : 0.03;
  else if (count >= 1) boostPct = isStarter ? 0.03 : 0.01;
  return { boostPct, injuredCount: count };
}

export function detectMinutesFloor(gameLog: GameLogEntry[]): { minMinutes: number; maxMinutes: number; spread: number; isStable: boolean; isVolatile: boolean } {
  const mins: number[] = [];
  for (const game of gameLog.slice(0, 5)) {
    if (isDNPGame(game)) continue;
    const m = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (m > 0) mins.push(m);
  }
  if (mins.length < 3) return { minMinutes: 0, maxMinutes: 0, spread: 0, isStable: false, isVolatile: false };
  const minM = Math.min(...mins);
  const maxM = Math.max(...mins);
  const spread = maxM - minM;
  return { minMinutes: Math.round(minM), maxMinutes: Math.round(maxM), spread: Math.round(spread), isStable: minM >= 28 && spread <= 8, isVolatile: spread >= 15 || minM < 15 };
}

export function calculateHomeAwaySplit(gameLog: GameLogEntry[], propType: string, isHome: boolean): { splitAvg: number; oppSplitAvg: number; edgePct: number } {
  const homeVals: number[] = [], awayVals: number[] = [];
  for (const game of gameLog.slice(0, 20)) {
    if (isDNPGame(game)) continue;
    const stat = getStatValue(game.stats, propType);
    if (stat === null) continue;
    const gameIsHome = (game.homeAway ?? "").toLowerCase() === "home";
    if (gameIsHome) homeVals.push(stat); else awayVals.push(stat);
  }
  if (homeVals.length < 2 || awayVals.length < 2) return { splitAvg: 0, oppSplitAvg: 0, edgePct: 0 };
  const homeAvg = homeVals.reduce((a, b) => a + b, 0) / homeVals.length;
  const awayAvg = awayVals.reduce((a, b) => a + b, 0) / awayVals.length;
  const splitAvg = isHome ? homeAvg : awayAvg;
  const oppSplitAvg = isHome ? awayAvg : homeAvg;
  const overall = (homeAvg * homeVals.length + awayAvg * awayVals.length) / (homeVals.length + awayVals.length);
  const edgePct = overall > 0 ? ((splitAvg - overall) / overall) * 100 : 0;
  return { splitAvg: Math.round(splitAvg * 100) / 100, oppSplitAvg: Math.round(oppSplitAvg * 100) / 100, edgePct: Math.round(edgePct) };
}

export function detectMarketConfirmation(l5HitRate: number, l10HitRate: number): { isOverpriced: boolean; isColdBuy: boolean } {
  return { isOverpriced: l5HitRate >= 100 && l10HitRate < 80, isColdBuy: l5HitRate <= 20 && l10HitRate >= 50 };
}

export function detectRegression(recentAvg: number, seasonAvg: number, line: number, pickSide: "over" | "under"): { signal: "buy_low" | "sell_high" | "none"; pctDiff: number } {
  if (seasonAvg === 0) return { signal: "none", pctDiff: 0 };
  const pctDiff = ((recentAvg - seasonAvg) / seasonAvg) * 100;
  if (pickSide === "over") {
    if (pctDiff <= -20) return { signal: "buy_low", pctDiff: Math.round(pctDiff) };
    if (pctDiff >= 20) return { signal: "sell_high", pctDiff: Math.round(pctDiff) };
  } else {
    if (pctDiff >= 20) return { signal: "buy_low", pctDiff: Math.round(pctDiff) };
    if (pctDiff <= -20) return { signal: "sell_high", pctDiff: Math.round(pctDiff) };
  }
  return { signal: "none", pctDiff: Math.round(pctDiff) };
}

export function calculateUSGRate(gameLog: GameLogEntry[]): number {
  let totalFGA = 0, totalFTA = 0, totalTOV = 0, totalMIN = 0;
  let gamesUsed = 0;
  for (const game of gameLog.slice(0, 10)) {
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (mins < 5) continue;
    const fga = game.stats["FGA"] ?? game.stats["fga"] ?? 0;
    const fta = game.stats["FTA"] ?? game.stats["fta"] ?? 0;
    const tov = game.stats["TO"] ?? game.stats["to"] ?? game.stats["TOV"] ?? game.stats["tov"] ?? game.stats["Turnovers"] ?? 0;
    totalFGA += fga; totalFTA += fta; totalTOV += tov; totalMIN += mins; gamesUsed++;
  }
  if (totalMIN < 30 || gamesUsed < 3) return 0;
  const usg = ((totalFGA + 0.44 * totalFTA + totalTOV) * 48) / (totalMIN * 5);
  return Math.round(usg * 10) / 10;
}

export function detectRoleChange(gameLog: GameLogEntry[]): { detected: boolean; direction: "promotion" | "demotion" | "none"; l3Avg: number; l10Avg: number; pctChange: number } {
  const validMins: number[] = [];
  for (const game of gameLog.slice(0, 10)) {
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (mins > 0) validMins.push(mins);
  }
  if (validMins.length < 5) return { detected: false, direction: "none", l3Avg: 0, l10Avg: 0, pctChange: 0 };
  const l3 = validMins.slice(0, 3);
  const l10 = validMins;
  const l3Avg = l3.reduce((a, b) => a + b, 0) / l3.length;
  const l10Avg = l10.reduce((a, b) => a + b, 0) / l10.length;
  if (l10Avg === 0) return { detected: false, direction: "none", l3Avg, l10Avg, pctChange: 0 };
  const pctChange = ((l3Avg - l10Avg) / l10Avg) * 100;
  if (pctChange >= 30) return { detected: true, direction: "promotion", l3Avg: Math.round(l3Avg * 10) / 10, l10Avg: Math.round(l10Avg * 10) / 10, pctChange: Math.round(pctChange) };
  if (pctChange <= -30) return { detected: true, direction: "demotion", l3Avg: Math.round(l3Avg * 10) / 10, l10Avg: Math.round(l10Avg * 10) / 10, pctChange: Math.round(pctChange) };
  return { detected: false, direction: "none", l3Avg: Math.round(l3Avg * 10) / 10, l10Avg: Math.round(l10Avg * 10) / 10, pctChange: Math.round(pctChange) };
}

export function calculatePaceDefenseScores(
  opponentStats: OpponentStats | null,
  propType: string,
  pickSide: "over" | "under",
  // D-186 (May 15, 2026): optional player position enables per-opp-position
  // refinement on rebounds/assists when cache_team_advanced_stats_by_position
  // populated the lookups. Null/missing position = pre-D-186 behavior.
  playerPosition?: string | null,
): { paceScore: number; defenseScore: number } {
  if (!opponentStats) return { paceScore: 0, defenseScore: 0 };
  let paceScore = 0;
  let defenseScore = 0;
  const normalizedProp = propType.replace("player_", "");

  const ppg = opponentStats.pointsAllowedPerGame;
  const rpg = opponentStats.reboundsAllowedPerGame;
  const apg = opponentStats.assistsAllowedPerGame;
  const defRating = opponentStats.defensiveRating;
  const oppTov = opponentStats.oppOwnTurnovers;
  const oppStl = opponentStats.oppOwnSteals;
  const opp2P = opponentStats.oppOwnTwoPtFGPct;
  const opp3P = opponentStats.oppOwnThreePtFGPct;
  const oppFG = opponentStats.oppOwnFGPct;

  // D-186 position-aware lookups (only used when both position + map populated).
  // Normalizer mirrors fetch-team-advanced-stats writer: take first hyphen-
  // separated token, map G→SG / F→SF, otherwise NULL.
  const posNorm = ((p?: string | null) => {
    if (!p) return null;
    const head = String(p).trim().split("-")[0].toUpperCase();
    if (head === "PG" || head === "SG" || head === "SF" || head === "PF" || head === "C") return head;
    if (head === "G") return "SG";
    if (head === "F") return "SF";
    return null;
  })(playerPosition);
  const drVsPos = posNorm && opponentStats.defensiveRatingVsPosition
    ? opponentStats.defensiveRatingVsPosition[posNorm] : undefined;
  const drbPctVsPos = posNorm && opponentStats.defensiveReboundPctVsPosition
    ? opponentStats.defensiveReboundPctVsPosition[posNorm] : undefined;
  const astPctVsPos = posNorm && opponentStats.assistPctVsPosition
    ? opponentStats.assistPctVsPosition[posNorm] : undefined;

  const defRatingBucket = (dr: number): number => {
    if (dr >= 117) return 5;
    if (dr >= 114) return 3;
    if (dr >= 112) return 1;
    if (dr >= 110) return -1;
    if (dr >= 108) return -3;
    return -5;
  };

  const scoringMultiProps = ["pts_rebs_asts", "pts_asts", "pts_rebs"];
  const reboundMultiProps = ["rebs_asts"];
  const isScoringMulti = scoringMultiProps.includes(normalizedProp);
  const isReboundMulti = reboundMultiProps.includes(normalizedProp);

  const isVolumeScoring = normalizedProp === "points" || isScoringMulti;
  const isVolumeRebound = normalizedProp === "rebounds" || isReboundMulti || normalizedProp === "pts_rebs";
  if (ppg > 0 && (isVolumeScoring || isVolumeRebound || normalizedProp === "assists" || normalizedProp === "threes")) {
    let basePaceScore = ppg >= 122 ? 4 : ppg >= 119 ? 2 : ppg >= 116 ? 0 : ppg >= 113 ? -2 : ppg >= 110 ? -3 : -4;
    if (isVolumeRebound) basePaceScore = Math.round(basePaceScore / 2);
    paceScore = basePaceScore;
  }

  if (normalizedProp === "points") {
    if (defRating > 0) {
      defenseScore = defRatingBucket(defRating);
    } else if (ppg > 0) {
      defenseScore = ppg >= 122 ? 5 : ppg >= 119 ? 3 : ppg >= 116 ? 1 : ppg >= 113 ? -1 : ppg >= 110 ? -3 : -5;
    }
  } else if (normalizedProp === "rebounds" && rpg > 0) {
    defenseScore = rpg >= 47 ? 5 : rpg >= 45 ? 3 : rpg >= 43 ? 1 : rpg >= 41 ? -1 : rpg >= 39 ? -3 : -5;
    // D-186 position-aware refinement. NBA opp DRB% range ~0.68-0.78. Higher
    // DRB% = team better at limiting opp rebounds at THIS position (under).
    // We nudge the bucketed defenseScore by +/-2 max when signal is strong.
    if (drbPctVsPos !== undefined && drbPctVsPos > 0) {
      if (drbPctVsPos >= 0.78) defenseScore -= 2;
      else if (drbPctVsPos >= 0.75) defenseScore -= 1;
      else if (drbPctVsPos <= 0.68) defenseScore += 2;
      else if (drbPctVsPos <= 0.71) defenseScore += 1;
    }
  } else if (normalizedProp === "assists" && apg > 0) {
    defenseScore = apg >= 30 ? 5 : apg >= 28 ? 3 : apg >= 27 ? 1 : apg >= 25 ? -1 : apg >= 23 ? -3 : -5;
    // D-186 position-aware refinement. NBA opp AST% range ~0.55-0.70 (rate of
    // FGM that are assisted). Higher = opp position gets clean looks (over).
    if (astPctVsPos !== undefined && astPctVsPos > 0) {
      if (astPctVsPos >= 0.70) defenseScore += 2;
      else if (astPctVsPos >= 0.66) defenseScore += 1;
      else if (astPctVsPos <= 0.55) defenseScore -= 2;
      else if (astPctVsPos <= 0.58) defenseScore -= 1;
    }
    // D-186 secondary refinement for assists from position-specific defensive
    // rating (when DRB% missing). Lower opp DR vs this position → under bias.
    if (astPctVsPos === undefined && drVsPos !== undefined && drVsPos > 0) {
      if (drVsPos < 108) defenseScore -= 2;
      else if (drVsPos < 110) defenseScore -= 1;
      else if (drVsPos >= 117) defenseScore += 2;
      else if (drVsPos >= 114) defenseScore += 1;
    }
  } else if (normalizedProp === "threes" && opp3P > 0) {
    defenseScore = opp3P >= 38 ? 5 : opp3P >= 37 ? 3 : opp3P >= 36 ? 1 : opp3P >= 35 ? -1 : opp3P >= 34 ? -3 : -5;
  } else if (normalizedProp === "steals" && oppTov > 0) {
    defenseScore = oppTov >= 15.5 ? 5 : oppTov >= 14.5 ? 3 : oppTov >= 13.5 ? 1 : oppTov >= 12.5 ? -1 : oppTov >= 11.5 ? -3 : -5;
  } else if (normalizedProp === "turnovers" && oppStl > 0) {
    defenseScore = oppStl >= 10.5 ? 5 : oppStl >= 9.5 ? 3 : oppStl >= 8.5 ? 1 : oppStl >= 7.5 ? -1 : oppStl >= 6.5 ? -3 : -5;
  } else if (normalizedProp === "blocks" && opp2P > 0) {
    defenseScore = opp2P <= 53 ? 5 : opp2P <= 56 ? 3 : opp2P <= 59 ? 1 : opp2P <= 62 ? -1 : opp2P <= 65 ? -3 : -5;
    if (defenseScore === 0 && oppFG > 0) {
      defenseScore = oppFG <= 44 ? 5 : oppFG <= 46 ? 3 : oppFG <= 47 ? 1 : oppFG <= 49 ? -1 : oppFG <= 51 ? -3 : -5;
    }
  } else if (isScoringMulti) {
    if (defRating > 0) {
      defenseScore = defRatingBucket(defRating);
    } else if (ppg > 0) {
      defenseScore = ppg >= 122 ? 5 : ppg >= 119 ? 3 : ppg >= 116 ? 1 : ppg >= 113 ? -1 : ppg >= 110 ? -3 : -5;
    }
  } else if (isReboundMulti && rpg > 0) {
    defenseScore = rpg >= 47 ? 5 : rpg >= 45 ? 3 : rpg >= 43 ? 1 : rpg >= 41 ? -1 : rpg >= 39 ? -3 : -5;
  } else if (normalizedProp === "pts_rebs" && rpg > 0) {
    const pBucket = defRating > 0
      ? defRatingBucket(defRating)
      : (ppg >= 122 ? 5 : ppg >= 119 ? 3 : ppg >= 116 ? 1 : ppg >= 113 ? -1 : ppg >= 110 ? -3 : -5);
    const rBucket = rpg >= 47 ? 5 : rpg >= 45 ? 3 : rpg >= 43 ? 1 : rpg >= 41 ? -1 : rpg >= 39 ? -3 : -5;
    defenseScore = Math.round((pBucket + rBucket) / 2);
  } else if (normalizedProp === "double_double" || normalizedProp === "triple_double") {
    defenseScore = 0;
  } else {
    defenseScore = 0;
  }

  if (paceScore !== 0 && pickSide === "under") paceScore = -paceScore;
  if (defenseScore !== 0 && pickSide === "under") defenseScore = -defenseScore;
  return { paceScore, defenseScore };
}

// =============================================================================
// VERDICT LABELING
// =============================================================================

export function getScoreLabel(score: number): string {
  // §15.10 Critical #4 recalibration (CEO May 12, 2026). Three sites must
  // stay in sync: this function (now centralized in _shared/scoring.ts) +
  // analyze-pick:1316 (will import this) + src/lib/confidence (frontend).
  if (score >= 90) return "Elite Pick";
  if (score >= 80) return "Strong Pick";
  if (score >= 70) return "Good Pick";
  if (score >= 60) return "Lean";
  return "Pass";
}

// =============================================================================
// PLAYER INJURY STATUS (takes bdlInjuriesByTeam Map as param — pure given state)
// =============================================================================

export function getPlayerInjuryStatus(
  playerName: string,
  teamName: string,
  bdlInjuriesByTeam: Map<string, BdlInjury[]>,
  asOfDate?: Date,
): { isInjured: boolean; status: string; penalty: number } {
  const key = teamName.toLowerCase();
  const injuries = bdlInjuriesByTeam.get(key) || [];
  const playerLower = playerName.toLowerCase();
  const match = injuries.find(inj => {
    const injLower = inj.playerName.toLowerCase();
    return injLower.includes(playerLower) || playerLower.includes(injLower);
  });
  if (!match) return { isInjured: false, status: "", penalty: 0 };

  const status = match.status.toLowerCase();
  let penalty = -15;
  let isOutForSeason = false;
  let isOutTier = false;
  if (status.includes("out for season")) { penalty = -30; isOutForSeason = true; }
  else if (status === "out")              { penalty = -25; isOutTier = true; }
  else if (status.includes("doubtful"))   { penalty = -20; }
  else if (status.includes("day-to-day")) { penalty = -8; }
  else if (status.includes("questionable")) { penalty = -10; }
  else if (status.includes("probable"))   { penalty = -3; }

  if (match.returnDate && !isOutForSeason) {
    const todayUtc = asOfDate ?? new Date();
    const today = new Date(todayUtc.getFullYear(), todayUtc.getMonth(), todayUtc.getDate());
    const ret = new Date(match.returnDate);
    if (!isNaN(ret.getTime())) {
      const daysUntilReturn = Math.round((ret.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
      if (daysUntilReturn <= 0) {
        penalty = Math.max(penalty, -8);
      } else if (isOutTier && daysUntilReturn >= 30) {
        penalty = Math.round(penalty * 0.5);
      }
    }
  }

  return { isInjured: true, status: match.status, penalty };
}

// =============================================================================
// MINUTE-BOUND PROPS (used by D-137 blowoutRisk + D-139 lineMovement gates)
// =============================================================================

export const MINUTE_BOUND_PROPS = new Set([
  "points", "rebounds", "assists", "pts_rebs", "pts_asts", "rebs_asts", "pts_rebs_asts",
  "player_points", "player_rebounds", "player_assists",
]);

// =============================================================================
// calculateConfidenceScore — base 13 factors + trivial penalty + L1 cap
// =============================================================================

export function calculateConfidenceScore(input: {
  l5HitRate: number; l10HitRate: number; seasonHitRate: number; line: number;
  playerFloor: number; playerCeiling: number; recentAvg: number; seasonAvg: number;
  isHome: boolean; odds: number; pickSide: "over" | "under"; propType: string;
  restDays: number; isBackToBack: boolean; minutesTrendScore: number; paceScore: number; defenseScore: number;
}, weights: ScoringWeights): { score: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};
  let score = 50;

  const l5 = input.l5HitRate >= 100 ? 15 : input.l5HitRate >= 80 ? 12 : input.l5HitRate >= 60 ? 5 : input.l5HitRate >= 40 ? 0 : input.l5HitRate >= 20 ? -8 : -15;
  breakdown.l5HitRate = l5; score += Math.round(l5 * weights.l5);

  const l10 = input.l10HitRate >= 80 ? 10 : input.l10HitRate >= 60 ? 5 : input.l10HitRate >= 40 ? 0 : -8;
  breakdown.l10HitRate = l10; score += Math.round(l10 * weights.l10);

  const season = input.seasonHitRate >= 70 ? 10 : input.seasonHitRate >= 50 ? 3 : input.seasonHitRate >= 40 ? 0 : -8;
  breakdown.seasonHitRate = season; score += Math.round(season * weights.season);

  let floorScore = 0;
  if (input.pickSide === "over") {
    if (input.playerFloor >= input.line) floorScore = 12;
    else if (input.playerFloor >= input.line * 0.8) floorScore = 5;
    else if (input.playerFloor < input.line * 0.5) floorScore = -8;
    else if (input.playerFloor < input.line * 0.7) floorScore = -4;
  } else {
    if (input.playerCeiling <= input.line) floorScore = 12;
    else if (input.playerCeiling <= input.line * 1.2) floorScore = 5;
    else if (input.playerCeiling > input.line * 1.5) floorScore = -8;
    else if (input.playerCeiling > input.line * 1.3) floorScore = -4;
  }
  breakdown.floorCeiling = floorScore; score += Math.round(floorScore * weights.floorCeiling);

  const pctDiff = input.seasonAvg !== 0 ? ((input.recentAvg - input.seasonAvg) / input.seasonAvg) * 100 : 0;
  let form = pctDiff >= 15 ? 10 : pctDiff >= 5 ? 5 : pctDiff <= -15 ? -10 : pctDiff <= -5 ? -5 : 0;
  if (input.pickSide === "under") form = -form;
  breakdown.recentForm = form; score += Math.round(form * weights.recentForm);

  let ha = input.isHome ? 1 : -1;
  if (input.pickSide === "under") ha = -ha;
  breakdown.homeAway = ha; score += Math.round(ha * weights.homeAway);

  // D-173 (May 15, 2026): side-asymmetry fix. Empirical 2628-pick analysis
  // showed score_rest is purely directional: well-rested → over hits more
  // (over-side WR delta +6.49pp when fired). The pre-D-173 symmetric flip
  // (restScore = -restScore for unders) actively hurt under decisions
  // (-1.75pp delta). Fix: drop the flip; restScore contributes only on
  // over-side picks. Hypothesis B per D-163 → D-173 investigation chain.
  let restScore = 0;
  if (!input.isBackToBack && input.restDays !== null && input.restDays > 0) {
    if (input.restDays === 1) restScore = 0;
    else if (input.restDays === 2) restScore = 2;
    else if (input.restDays === 3) restScore = 3;
    else if (input.restDays === 4) restScore = 2;
    else if (input.restDays <= 7) restScore = 0;
    else if (input.restDays <= 14) restScore = -5;
    else restScore = -10;
  }
  // D-173: suppress factor on under-side picks (no side-flip).
  if (input.pickSide === "under") restScore = 0;
  breakdown.restDays = restScore; score += Math.round(restScore * weights.rest);

  // D-170 (May 14, 2026): extend score_b2b to fire on short rest (rest_days
  // <= 1), not just literal back-to-back (rest_days = 0). NBA playoffs have
  // essentially zero literal b2bs — D-163 / D-170 diagnostic measured 0/2795
  // is_b2b=TRUE across the 2026 playoff window. Without this extension, the
  // factor is naturally dormant for ~half the calendar year. Conservative
  // magnitudes (half of literal b2b) mitigate calibration drift while the
  // existing w_b2b weight gets re-tuned in next §1.12 cycle.
  let b2bScore = 0;
  if (input.isBackToBack) b2bScore = input.isHome ? -2 : -5;
  else if (input.restDays === 1) b2bScore = input.isHome ? -1 : -2;
  if (input.pickSide === "under") b2bScore = -b2bScore;
  breakdown.backToBack = b2bScore; score += Math.round(b2bScore * weights.b2b);

  let mtScore = input.minutesTrendScore;
  if (input.pickSide === "under") mtScore = -mtScore;
  breakdown.minutesTrend = mtScore; score += Math.round(mtScore * weights.minutesTrend);
  breakdown.pace = input.paceScore; score += Math.round(input.paceScore * weights.pace);
  breakdown.opponentDefense = input.defenseScore; score += Math.round(input.defenseScore * weights.oppDefense);
  breakdown.oddsValue = 0;

  const normalizedProp = input.propType.replace("player_", "").toLowerCase();
  let propTypePenalty = 0;
  if (normalizedProp === "assists") propTypePenalty = -3;
  else if (normalizedProp === "rebounds") propTypePenalty = -2;
  else if (normalizedProp === "threes") propTypePenalty = -4;
  else if (normalizedProp === "steals" || normalizedProp === "blocks") propTypePenalty = -5;
  else if (normalizedProp === "turnovers") propTypePenalty = -4;
  breakdown.propTypePenalty = propTypePenalty; score += Math.round(propTypePenalty * weights.propType);

  const isTrivialLine = input.line <= 0.5;
  // §15.10 #8 Option C (D-127 May 12, 2026): symmetric trivial penalty
  // for heavy-favorite AND longshot trivials. Math.abs(odds) >= 200 gate.
  const trivialOdds = Math.abs(input.odds) >= 200;
  const trivialPenalty = (isTrivialLine && trivialOdds) ? -15 : isTrivialLine ? -8 : 0;
  score += trivialPenalty;
  breakdown.trivialLinePenalty = trivialPenalty;

  let finalScore = Math.max(0, Math.min(100, score));
  // Layer 1 cap (pre-bonus). D-127 §15.10 #8 Option C.
  let trivialLineCapApplied = false;
  if (isTrivialLine && trivialOdds && finalScore > 65) {
    breakdown.trivialLineCap = 65 - finalScore;
    trivialLineCapApplied = true;
    finalScore = 65;
  }
  breakdown.trivialLineCapApplied = trivialLineCapApplied ? 1 : 0;
  return { score: finalScore, breakdown };
}

// =============================================================================
// scoreOneSide — orchestrates calculateConfidenceScore + 13 post-calc bonuses
// + D-140 Layer-2 cap + D-142 verdict-from-finalScore
// =============================================================================

export async function scoreOneSide(
  playerData: CachedPlayerData,
  prop: ExtractedProp,
  edgeData: { b2b: { isBackToBack: boolean; restDays: number }; oppStats: OpponentStats | null },
  pickSide: "over" | "under",
  weights: ScoringWeights,
  helpers: ScoreOneSideHelpers,
): Promise<PropAnalysisResult | null> {
  const { player, gameLog, minutesTrend } = playerData;
  const hitRates = calcHitRates(gameLog, prop.propType, prop.line, pickSide);
  if (!hitRates.values.length) return null;
  const allValues = hitRates.values;
  if (allValues.length < 5) return null;

  const recentWindow = allValues.slice(0, 10);
  const playerFloor = Math.min(...recentWindow);
  const playerCeiling = Math.max(...recentWindow);
  const seasonAvg = allValues.reduce((a, b) => a + b, 0) / allValues.length;
  const recentValues = allValues.slice(0, 5);
  const recentAvg = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
  const isHome = prop.homeTeam === player.team;
  const absenceInfo = detectRecentAbsence(gameLog);
  const { paceScore, defenseScore } = calculatePaceDefenseScores(edgeData.oppStats, prop.propType, pickSide, player.position);

  const statStdDev = calculateStdDev(allValues.slice(0, 10));
  const perMinRate = calculatePerMinuteRate(gameLog, prop.propType);
  const projMins = projectMinutes(gameLog, edgeData.b2b.isBackToBack);
  const rawProjected = computeProjectedStat(perMinRate, projMins, paceScore);
  const teamInjuriesArr = await helpers.getTeamInjuries(player.team);
  const usageBoostResult = calculateUsageBoost(teamInjuriesArr, projMins);
  const projectedStat = Math.round(rawProjected * (1 + usageBoostResult.boostPct) * 100) / 100;
  const zScore = calculateZScore(projectedStat, prop.line, statStdDev, pickSide);

  const roleChange = detectRoleChange(gameLog);
  const minsFloor = detectMinutesFloor(gameLog);
  const hasSplit = calculateHomeAwaySplit(gameLog, prop.propType, isHome);
  const marketConf = detectMarketConfirmation(hitRates.l5.rate, hitRates.l10.rate);
  const regression = detectRegression(recentAvg, seasonAvg, prop.line, pickSide);
  const usgRate = calculateUSGRate(gameLog);

  // D-133 sideAwareOdds hoist (May 13, 2026).
  const sideAwareOdds = prop.availableBooks?.find(
    (b) => b.bookmaker === prop.bookmaker
        && b.pick_side === pickSide
        && b.line === prop.line
  )?.odds ?? prop.odds;

  const confidenceResult = calculateConfidenceScore({
    l5HitRate: hitRates.l5.rate, l10HitRate: hitRates.l10.rate, seasonHitRate: hitRates.season.rate,
    line: prop.line, playerFloor, playerCeiling, recentAvg, seasonAvg, isHome, odds: sideAwareOdds,
    pickSide, propType: prop.propType, restDays: edgeData.b2b.restDays,
    isBackToBack: edgeData.b2b.isBackToBack, minutesTrendScore: minutesTrend.score, paceScore, defenseScore,
  }, weights);

  let finalScore = confidenceResult.score;

  let zScoreBonus = 0;
  if (zScore >= 1.5) zScoreBonus = 8; else if (zScore >= 1.0) zScoreBonus = 5;
  else if (zScore >= 0.5) zScoreBonus = 2; else if (zScore <= -1.0) zScoreBonus = -8;
  else if (zScore <= -0.5) zScoreBonus = -4;
  finalScore += Math.round(zScoreBonus * weights.zScore);

  let consistencyBonus = 0;
  if (statStdDev > 0) {
    const coeffOfVariation = statStdDev / (projectedStat || 1);
    if (coeffOfVariation <= 0.15) consistencyBonus = 4; else if (coeffOfVariation <= 0.25) consistencyBonus = 2;
    else if (coeffOfVariation >= 0.50) consistencyBonus = -5; else if (coeffOfVariation >= 0.40) consistencyBonus = -3;
  }
  finalScore += Math.round(consistencyBonus * weights.consistency);

  let roleChangeBonus = 0;
  if (roleChange.detected) { roleChangeBonus = roleChange.direction === "promotion" ? 5 : -6; }
  if (pickSide === "under") roleChangeBonus = -roleChangeBonus;
  finalScore += Math.round(roleChangeBonus * weights.roleChange);

  let vigFilterPenalty = 0;
  if (projectedStat > 0 && prop.line > 0) {
    const edgePct = Math.abs(projectedStat - prop.line) / prop.line;
    if (edgePct < 0.05 && Math.abs(zScore) < 0.5) vigFilterPenalty = -6;
  }
  finalScore += Math.round(vigFilterPenalty * weights.vigFilter);

  let usgBonus = 0;
  if (usgRate >= 30) usgBonus = 3; else if (usgRate >= 25) usgBonus = 1;
  else if (usgRate > 0 && usgRate < 15) usgBonus = -3;
  if (pickSide === "under") usgBonus = -usgBonus;
  finalScore += Math.round(usgBonus * weights.usgRate);

  let regressionBonus = 0;
  if (regression.signal === "buy_low") regressionBonus = 4;
  else if (regression.signal === "sell_high") regressionBonus = -4;
  finalScore += Math.round(regressionBonus * weights.regression);

  let marketConfBonus = 0;
  if (marketConf.isOverpriced) marketConfBonus = -4;
  if (marketConf.isColdBuy) marketConfBonus = 3;
  finalScore += Math.round(marketConfBonus * weights.marketConf);

  let homeAwaySplitBonus = 0;
  if (Math.abs(hasSplit.edgePct) >= 15) homeAwaySplitBonus = hasSplit.edgePct > 0 ? 3 : -3;
  else if (Math.abs(hasSplit.edgePct) >= 10) homeAwaySplitBonus = hasSplit.edgePct > 0 ? 2 : -2;
  if (pickSide === "under") homeAwaySplitBonus = -homeAwaySplitBonus;
  finalScore += Math.round(homeAwaySplitBonus * weights.haSplit);

  let minutesVolumeBonus = 0;
  if (minsFloor.minMinutes >= 32) minutesVolumeBonus = 3;
  else if (minsFloor.minMinutes >= 28) minutesVolumeBonus = 2;
  else if (minsFloor.minMinutes >= 22) minutesVolumeBonus = 1;
  else if (minsFloor.minMinutes > 0 && minsFloor.minMinutes < 15) minutesVolumeBonus = -2;
  if (pickSide === "under") minutesVolumeBonus = -minutesVolumeBonus;
  finalScore += Math.round(minutesVolumeBonus * weights.minutesFloor);

  let minutesStabilityBonus = 0;
  if (minsFloor.spread > 0 && minsFloor.spread <= 4) minutesStabilityBonus = 3;
  else if (minsFloor.spread > 0 && minsFloor.spread <= 8) minutesStabilityBonus = 1;
  else if (minsFloor.spread >= 15) minutesStabilityBonus = -3;
  // D-242 (2026-05-19): halve stability application — volume above at line 1027 already
  // consumed full weights.minutesFloor; stability previously consumed it again, producing
  // an unintended ±14pt confidence swing per pick. NOT side-flipped (predictability helps
  // both sides equally), so the double-count was symmetric-additive. Halving here restores
  // stability to a half-weight contributor without touching the optimizer-learned value.
  finalScore += Math.round(minutesStabilityBonus * weights.minutesFloor * 0.5);

  let staleDataPenalty = 0;
  if (gameLog.length > 0 && gameLog[0].date) {
    const lastGameDate = new Date(gameLog[0].date);
    const now = helpers.asOfDate ?? new Date();
    const daysSinceLastGame = Math.floor((now.getTime() - lastGameDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSinceLastGame >= 35) staleDataPenalty = -30;
    else if (daysSinceLastGame >= 21) staleDataPenalty = -20;
    else if (daysSinceLastGame >= 14) staleDataPenalty = -10;
    if (staleDataPenalty === 0 && gameLog.length >= 2 && gameLog[1].date) {
      const prevDate = new Date(gameLog[1].date);
      const topGapDays = Math.floor((lastGameDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
      if (topGapDays >= 14) staleDataPenalty = -10;
    }
  }
  finalScore += Math.round(staleDataPenalty * weights.staleData);

  let playerInjuryPenalty = 0;
  const injuryStatus = helpers.getPlayerInjury(player.displayName, player.team);
  if (injuryStatus.isInjured) playerInjuryPenalty = injuryStatus.penalty;
  if (pickSide === "under") playerInjuryPenalty = -playerInjuryPenalty;
  finalScore += Math.round(playerInjuryPenalty * weights.playerInjury);

  // D-136 score_low_min_risk
  const lowMinRiskAllMins: number[] = [];
  for (const g of gameLog) {
    const m = g.stats["MIN"] ?? g.stats["min"] ?? g.stats["Minutes"];
    if (typeof m === "number" && m > 0) lowMinRiskAllMins.push(m);
  }
  const seasonMinAvg = lowMinRiskAllMins.length > 0
    ? lowMinRiskAllMins.reduce((a, b) => a + b, 0) / lowMinRiskAllMins.length
    : 0;
  const l5MinAvg = minutesTrend.l5Avg;
  let lowMinRiskPenalty = 0;
  if (lowMinRiskAllMins.length >= 10 && seasonMinAvg > 0 && l5MinAvg > 0) {
    const minRatio = l5MinAvg / seasonMinAvg;
    if (minRatio < 0.5)       lowMinRiskPenalty = -15;
    else if (minRatio < 0.65) lowMinRiskPenalty = -10;
    else if (minRatio < 0.75) lowMinRiskPenalty = -6;
  }
  if (pickSide === "under") lowMinRiskPenalty = -lowMinRiskPenalty;
  finalScore += Math.round(lowMinRiskPenalty * weights.lowMinRisk);

  // D-137 score_blowout_risk V0-B
  let blowoutRiskPenalty = 0;
  {
    const blGd = (prop.gameTime || "").length >= 10
      ? (prop.gameTime as string).slice(0, 10)
      : ((prop.gameTime as string) || "");
    const snap = helpers.getGameLine(prop.homeTeam, prop.awayTeam, blGd);
    const absSpread = snap?.spread !== null && snap?.spread !== undefined ? Math.abs(snap.spread) : 0;
    const favoredTeam = snap?.favoredTeam ?? null;
    const playerOnFavoredSide = favoredTeam !== null && favoredTeam === player.team;
    if (favoredTeam && playerOnFavoredSide && MINUTE_BOUND_PROPS.has(prop.propType)) {
      if (absSpread > 16)      blowoutRiskPenalty = -18;
      else if (absSpread > 13) blowoutRiskPenalty = -12;
      else if (absSpread > 10) blowoutRiskPenalty = -6;
    }
  }
  if (pickSide === "under") blowoutRiskPenalty = -blowoutRiskPenalty;
  finalScore += Math.round(blowoutRiskPenalty * weights.blowoutRisk);

  // D-139 score_line_movement V0
  let lineMovementBonus = 0;
  {
    const lmGd = (prop.gameTime || "").length >= 10
      ? (prop.gameTime as string).slice(0, 10)
      : ((prop.gameTime as string) || "");
    const snap = helpers.getGameLine(prop.homeTeam, prop.awayTeam, lmGd);
    const currentSpread = snap?.spread ?? null;
    const spreadT0 = snap?.spreadT0 ?? null;
    const favoredTeam = snap?.favoredTeam ?? null;
    const playerOnFavoredSide = favoredTeam !== null && favoredTeam === player.team;
    if (
      currentSpread !== null &&
      spreadT0 !== null &&
      favoredTeam &&
      playerOnFavoredSide &&
      MINUTE_BOUND_PROPS.has(prop.propType)
    ) {
      const movement = Math.abs(currentSpread) - Math.abs(spreadT0);
      const absMovement = Math.abs(movement);
      let magnitude = 0;
      if (absMovement > 1.5)      magnitude = 10;
      else if (absMovement > 0.75) magnitude = 5;
      else if (absMovement > 0.25) magnitude = 2;
      lineMovementBonus = movement > 0 ? magnitude : -magnitude;
    }
  }
  if (pickSide === "under") lineMovementBonus = -lineMovementBonus;
  finalScore += Math.round(lineMovementBonus * weights.lineMovement);

  finalScore = Math.max(0, Math.min(100, finalScore));

  // D-406: capture pre-cap confidence BEFORE Layer-2 D-140 cap.
  // Caveat: Layer-1 cap (calculateConfidenceScore:911) fires earlier; its effect
  // IS already baked into finalScore. Full Layer-1+Layer-2 cap-free tracking
  // would require parallel-tracking through the bonus chain — deferred to a
  // follow-up D-batch if empirical data shows Layer-1 firing often on NBA picks.
  const confidence_pre_cap = finalScore;

  // D-140 layer-2 cap (May 13, 2026)
  // D-153 (May 13, 2026 late-night): Math.min preserves Layer-1 magnitude
  // when both layers fire. Cosmetic — BOOLEAN DB column unaffected.
  if (prop.line <= 0.5 && Math.abs(sideAwareOdds) >= 200 && finalScore > 65) {
    confidenceResult.breakdown.trivialLineCap = Math.min(
      confidenceResult.breakdown.trivialLineCap ?? 0,
      65 - finalScore,
    );
    confidenceResult.breakdown.trivialLineCapApplied = 1;
    finalScore = 65;
  }

  // D-164 (May 14, 2026): unbettable juice flag. Under-side picks where
  // the side_odds exceed the tier breakeven threshold get flagged so the
  // UI can warn subscribers. Closes D-148 §15.10 #5.
  //
  // Tier → breakeven gate (American odds, more-negative = more juice):
  //   60-69 → -200 (66.7% bk vs 50% required)
  //   70-79 → -250 (71.4% bk vs 53% required)
  //   80-89 → -300 (75.0% bk vs 56% required)
  //   90+   → -350 (77.8% bk vs 60% required)
  let unbettableJuiceFlag = false;
  if (pickSide === "under") {
    if (finalScore >= 90 && sideAwareOdds <= -350)      unbettableJuiceFlag = true;
    else if (finalScore >= 80 && sideAwareOdds <= -300) unbettableJuiceFlag = true;
    else if (finalScore >= 70 && sideAwareOdds <= -250) unbettableJuiceFlag = true;
    else if (finalScore >= 60 && sideAwareOdds <= -200) unbettableJuiceFlag = true;
  }

  // D-166 (May 14, 2026): coin-flip sanity check. If finalScore >= 80 (Elite)
  // but season hit rate is 40–60%, some factor is pumping the score beyond
  // what hit-rate signal supports. Surface in UI for human review.
  // Closes D-148 §15.10 #7.
  const seasonHitPct = hitRates.season.rate; // 0–100 numeric percent
  const coinFlipFlag = finalScore >= 80 && seasonHitPct >= 40 && seasonHitPct <= 60;

  // D-167 (May 14, 2026): negative-factor stacking detection (Failure Mode D).
  // Build the full breakdown once so we can both count negatives AND emit it
  // in the return object below.
  const mergedBreakdown = {
    ...confidenceResult.breakdown,
    zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty,
    usgBonus, usgRate, regressionBonus, marketConfBonus,
    homeAwaySplitBonus, minutesVolumeBonus,
    minutesStabilityBonus, staleDataPenalty, playerInjuryPenalty,
    lowMinRiskPenalty, blowoutRiskPenalty, lineMovementBonus,
    projectedStat, zScore, statStdDev,
  };
  const negativeFactorCount = Object.values(mergedBreakdown)
    .filter((v) => typeof v === "number" && v < 0).length;

  // D-198 — Tier-Aware Scoring pass. Capture finalScore BEFORE tier
  // modifiers as the audit baseline; apply modifiers as a separate
  // delta (identity when helpers.tierModifiers absent or all 1.0 →
  // ZERO behavior change relative to pre-D-198).
  const confidence_pre_tier_aware = finalScore;
  finalScore = applyTierAwareModifiers(finalScore, mergedBreakdown, weights, helpers.tierModifiers);

  const negativeStackingFlag = finalScore >= 80 && negativeFactorCount >= 3;

  return {
    playerName: player.displayName, team: player.team,
    propType: prop.propType.replace("player_", ""), line: prop.line, pickSide, odds: sideAwareOdds,
    // D-142 (May 13, 2026): verdict reads post-everything finalScore.
    confidence: finalScore, verdict: getScoreLabel(finalScore),
    // D-406: pre-cap confidence captured before Layer-2 cap fires.
    confidence_pre_cap,
    // D-198: pre-tier-aware audit; equals confidence on identity modifiers.
    confidence_pre_tier_aware,
    // D-164: unbettable juice flag (under-side + tier breakeven threshold).
    unbettableJuiceFlag,
    // D-166: coin-flip sanity flag (Elite confidence with ~50% season WR).
    coinFlipFlag,
    // D-167: negative-factor stacking (Failure Mode D).
    negativeStackingFlag, negativeFactorCount,
    hitRates: { l5: `${Math.round(hitRates.l5.rate)}%`, l10: `${Math.round(hitRates.l10.rate)}%`, season: `${Math.round(hitRates.season.rate)}%` },
    hitRatesRaw: { l5Hits: hitRates.l5.hits, l10Hits: hitRates.l10.hits, seasonRate: hitRates.season.rate, seasonHits: hitRates.season.hits, seasonTotal: hitRates.season.total },
    gamesPlayed: allValues.length,
    seasonAvg: Math.round(seasonAvg * 100) / 100, recentAvg: Math.round(recentAvg * 100) / 100,
    floor: playerFloor, ceiling: playerCeiling, last5Values: recentValues, isHome,
    isBackToBack: edgeData.b2b.isBackToBack, restDays: edgeData.b2b.restDays, minutesTrend,
    oppStats: edgeData.oppStats,
    breakdown: mergedBreakdown,
    absenceInfo,
    projectionData: { projectedStat, statStdDev, zScore, perMinRate, projectedMinutes: projMins, teammateInjuriesCount: usageBoostResult.injuredCount, usageBoost: usageBoostResult.boostPct },
  };
}
