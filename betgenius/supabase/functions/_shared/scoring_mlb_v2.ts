// _shared/scoring_mlb.ts — D-204 Batch 3 Tasks 3.1-3.4.
//
// MLB market scoring. Implements ALL 7 D-203 markets: pitcher_k (T3.1),
// batter_hits (T3.2), game_side + game_total (T3.3), batter_hr +
// batter_total_bases + batter_rbis (T3.4).
//
// Each market produces a 0-100 confidence + score_* factor magnitudes that
// land in pick_history columns. v1 Beta intentionally SKIPS the tier-aware
// modifier pass (Batch 2 T2.3) because algorithm_weights_tier_modifiers
// has no MLB-calibrated entries yet — applying NBA modifiers would
// produce wrong adjustments. confidence_pre_tier_aware == confidence for
// MLB rows until enough Beta picks resolve to calibrate per-market modifiers
// (CEO §13.2 Beta exit gate: 60% rolling-30d 70+ WR for 14 days + n>=100/200).
//
// Sanity flags ported from NBA scoreOneSide (D-164/166/167): unbettable
// juice, coin-flip, negative-factor stacking.

// ---------------------------------------------------------------------------
// D-737d — Symmetric rounding helper (the systemic fix for the Math.round
// asymmetry bug class found in D-737/D-737c).
//
// JavaScript's `Math.round` rounds halves toward +∞ asymmetrically:
//   Math.round(0.5)  = 1
//   Math.round(-0.5) = 0   ← NOT -1
//   Math.round(1.5)  = 2
//   Math.round(-1.5) = -1  ← NOT -2
//
// A factor scored as `Math.round(bucket * weight)` where the product equals
// exactly ±0.5 fires on OVER picks but is DEAD on UNDER picks. D-737c found
// this bug class affecting 15 STRONG-RISK factors in production, with the
// rest_pitcher signal showing a 41.9pp OVER/UNDER fire-rate gap on real
// pick_history data (79.8% vs 38.0%).
//
// The fix: round-half-away-from-zero — same magnitude on both sides.
//   roundHalfAwayFromZero(0.5)  = 1
//   roundHalfAwayFromZero(-0.5) = -1   ← symmetric
//
// IMPORTANT: This helper is ONLY for factor-scoring rounds (the
// `Math.round(f_<name> * W.<name>)` pattern at score_* declarations). Plain
// integer/display rounding (e.g., `Math.round(projectedK * 100) / 100`,
// confidence percentage conversions) continues to use Math.round directly
// because the asymmetry doesn't manifest there.
//
// D-737e re-tune is MANDATORY after this fix lands: the optimizer has been
// silently fitting weights against zero-on-UNDER cohort data for months.
// ---------------------------------------------------------------------------

function roundHalfAwayFromZero(x: number): number {
  return x >= 0 ? Math.round(x) : -Math.round(-x);
}

// ---------------------------------------------------------------------------
// D-744 STEP 2 — D-743 isotonic calibration for pitcher_strikeouts.
//
// Data-derived empirical curve from PAV (Pool Adjacent Violators) regression
// on the D-742-rescored TRAIN cohort: 663 pitcher_k picks scored 2026-05-18
// → 2026-06-10 with REAL outcomes. Maps raw D-695 winProb×100 confidence
// to the EMPIRICALLY-OBSERVED hit-rate at that score level. Monotone non-
// decreasing (PAV guarantees). Replaces the prior D-695 SHIP 4 hand-tuned
// ×0.4 shrinkage with the actual data.
//
// Empirical ceiling: 71.4% — no historical pick at any score level has
// actually won 80%+ of the time. The curve never produces 80+ confidence
// because there's no training data to support it.
//
// 10 monotonic blocks (see docs/loop/architecture/d743.md):
//   x range    n     P(hit)
//   0-33      120    39.2%
//   34-42     112    39.3%
//   43         12    41.7%
//   44-45      25    44.0%
//   46-57     160    52.5%
//   58-59      40    55.0%
//   60         28    57.1%
//   61-73     153    58.8%
//   74          6    66.7%
//   75-76       7    71.4%  ← empirical ceiling, applied beyond 76
//
// SCOPE: pitcher_strikeouts only. Other markets unchanged (D-744 §19.3 CEO-
// approved scope is pitcher_strikeouts; batter + game markets get their own
// future calibrations after their D-743-equivalent measurements).
// ---------------------------------------------------------------------------
// D-780 — pitcher_outs isotonic calibration. Analog of D-743 for K. PAV-fit
// on the D-778 cohort's TRAIN window (2024 n=278) per D-779. OOS-validated
// on 2025 n=476 (ECE 8.85pp — calibration honestly reveals model
// over-confidence at high tiers, but the DIRECTION is right and the
// mid-range is well-calibrated at -1.5pp gap).
//
// Pre-D-780: pitcher_outs picks showed raw 70-100% confidence on the
// dashboard; OOS hit rate at the same picks was ~55%. D-779 verified the
// inflation. D-780 ships the isotonic remap that fixes the live break.
//
// PAV blocks (from d779_calib.json):
//   raw 55  → 42.7% (n=135)
//   raw 60  → 48.7% (n=135 — pooled)
//   raw 65  → 53.5% (n=60)  ← first block above breakeven 52.4%
//   raw 70  → 58.5% (n=5)
//   raw 75  → 60.2% (n=30)
//   raw 80  → 64.4% (n=9)
//   raw 85+ → 66.7% (n=3-9, sparse high-conf tail)
//
// Below conf=50 the train cohort had only n=1 (a single loser), so we set
// a robust floor (40%) near the next-block hit rate to avoid the 0%
// artifact from a single-pick block. Above conf=82 we use the empirical
// 67% ceiling. D-752-style NaN-safe guard.
function applyD779IsotonicCalibrationPitcherOuts(rawConfidence: number): number {
  if (!Number.isFinite(rawConfidence)) {
    console.error(`[d780-calib] non-finite rawConfidence rejected: ${rawConfidence}`);
    return 0;
  }
  const x = Math.round(rawConfidence);
  if (x <= 50) return 40;  // robust floor — train cohort had only n=1 here
  if (x <= 57) return 43;  // conf 55 block — 42.7% empirical
  if (x <= 62) return 49;  // conf 60 block — 48.7%
  if (x <= 67) return 54;  // conf 65 block — 53.5% (first above breakeven)
  if (x <= 72) return 59;  // conf 70 block — 58.5% (thin n=5)
  if (x <= 77) return 60;  // conf 75 block — 60.2%
  if (x <= 82) return 64;  // conf 80 block — 64.4%
  return 67;               // empirical ceiling — 66.7% on n=3-9 sparse tail
}

// D-784 — batter_runs_scored isotonic calibration. Analog of D-780 for runs.
// D-783 audit found this market's confidence INVERTED at high tiers: picks at
// conf≥85 hit only 41.2% (vs predicted ~88%); conf 80-89 actual 46.4% (gap
// -38.6pp); conf 90-100 actual 41.2% (gap -54.3pp). The model was systematically
// over-confident; high-conf picks losing more than coin-flip.
//
// PAV-fit on a CONSISTENT-MODEL cohort (game_date 2026-06-13 → 2026-06-24,
// before the 2026-06-25T12:20:08Z algorithm_weights change → no straddle).
// Train: 70% chronological (n=1024 under / n=629 over). Val: held-out 30%
// (n=481 under / n=228 over). PER-SIDE fit (D-784 ESCALATION #1): under and
// over calibrate very differently — under WR 64-72% range, over WR 41-47%
// range. A combined calibration would mask the gap.
//
// UNDER PAV blocks (train n=1024 under):
//   raw ≤30: 54% empirical (n=41 pooled — robust floor)
//   raw 30-44: 59% empirical (n=205)
//   raw 45-49: 62% empirical (n=104)
//   raw ≥50: 66% empirical (n=674) ← ceiling
// OOS (val n=481 under):
//   calib 54 actual 48.0% (-6.0pp); calib 59 actual 71.4% (+12.4pp — under-pred);
//   calib 62 actual 68.4% (+6.4pp ✓); calib 66 actual 71.9% (+5.9pp ✓ at n=334).
//
// OVER PAV blocks (train n=629 over):
//   raw ≤40: 38% empirical (n=60 — robust floor)
//   raw 40-54: 41% empirical (n=163)
//   raw 55-69: 43% empirical (n=252)
//   raw 70-79: 47% empirical (n=66)
//   raw ≥80: 57% empirical (n=88) ← ceiling
// OOS (val n=228 over):
//   calib 38 actual 40.0% (+2.0pp ✓); calib 41 actual 30.8% (-10.2pp at n=26 sparse);
//   calib 43 actual 46.2% (+3.2pp ✓); calib 47 actual 54.5% (+7.5pp ✓);
//   calib 57 actual 47.0% (-10.0pp ⚠ — small over-prediction at top tier n=83).
//
// HONEST CEILING: 66 (under), 57 (over). No pick can show above these post-D-784.
// D-752-style NaN-safe guard.
function applyD784IsotonicCalibrationBatterRunsScored(
  rawConfidence: number,
  pickSide: string,
): number {
  if (!Number.isFinite(rawConfidence)) {
    console.error(`[d784-calib] non-finite rawConfidence rejected: ${rawConfidence}`);
    return 0;
  }
  const x = Math.round(rawConfidence);
  if (pickSide === "under") {
    if (x < 30) return 54;   // robust floor
    if (x < 45) return 59;
    if (x < 50) return 62;
    return 66;                // empirical ceiling — 66.0% on n=674
  }
  // OVER side (default for any non-"under" — also handles unexpected values
  // by treating them as over, which is the safer assumption given over picks
  // underperform).
  if (x < 40) return 38;     // robust floor
  if (x < 55) return 41;
  if (x < 70) return 43;
  if (x < 80) return 47;
  return 57;                  // empirical ceiling — 56.8% on n=88
}

// D-789 — batter_total_bases isotonic calibration. Analog of D-784 for TB.
// D-788 audit found this market's confidence badly INVERTED on both sides:
// OVER conf 90-100 hits 35.3% (-60.2pp); UNDER 90-100 hits 66.1% (-29.4pp).
// Worse than runs_scored. PAV per-side fit on consistent-model cohort
// (created_at 2026-06-13 → 2026-06-25T12:20:08Z, before the weight change →
// no straddle). Train: 70% chronological (n=1169 under / n=792 over). Val:
// held-out 30% (n=502 under / n=340 over). PER-SIDE because UNDER (64.1%)
// and OVER (41.4%) differ by ~23pp — a combined fit would mask the gap.
//
// UNDER PAV blocks (train n=1169 under):
//   raw <26: 50% empirical (n=33 floor pool)
//   raw 26-65: 60% empirical (n=581 — large stable band)
//   raw 66-74: 65% empirical (n=217)
//   raw ≥75: 69% empirical (n=305 + small high-conf blocks) ← CEILING
// OOS (val n=502 under):
//   calib 50 actual 50.0% (n=8 sparse); calib 60 actual 64.9% (+4.9pp ✓ n=333);
//   calib 65 actual 64.0% (-1.0pp ✓ n=86); calib 69 actual 68.9% (+0.0pp ✓ n=74).
//   95% CI at calib 69: [0.577, 0.783] — lower bound > 0.5, ceiling honest.
//
// OVER PAV blocks (train n=792 over):
//   raw <13: 33% empirical (n=24 floor pool)
//   raw 13-38: 38% empirical (n=222)
//   raw 39-44: 41% empirical (n=92)
//   raw 45-61: 44% empirical (n=232)
//   raw ≥62: 45% empirical (n=205 + tiny high-conf) ← CEILING
// OOS (val n=340 over):
//   calib 33 actual 14.3% (n=7 sparse); calib 38 actual 45.5% (+7.5pp n=77);
//   calib 41 actual 44.1% (+3.1pp ✓ n=34); calib 44 actual 40.9% (-3.1pp ✓ n=115);
//   calib 45 actual 37.7% (-7.3pp n=106). 95% CI at calib 45: [0.291, 0.472] —
//   upper bound < 0.5, ceiling honest. OVER is structurally below breakeven.
//
// HONEST CEILING: 69 (under), 45 (over). No TB pick can show above these post-D-789.
// D-752-style NaN-safe guard.
function applyD789IsotonicCalibrationBatterTotalBases(
  rawConfidence: number,
  pickSide: string,
): number {
  if (!Number.isFinite(rawConfidence)) {
    console.error(`[d789-calib] non-finite rawConfidence rejected: ${rawConfidence}`);
    return 0;
  }
  const x = Math.round(rawConfidence);
  if (pickSide === "under") {
    if (x < 26) return 50;    // robust floor
    if (x < 66) return 60;    // large stable band
    if (x < 75) return 65;
    return 69;                 // empirical ceiling — 68.9% OOS on n=74
  }
  // OVER side (default for any non-"under" — also handles unexpected values
  // by treating them as over, which is the safer assumption given over picks
  // underperform breakeven).
  if (x < 13) return 33;     // robust floor
  if (x < 39) return 38;
  if (x < 45) return 41;
  if (x < 62) return 44;
  return 45;                  // empirical ceiling — 37.7% OOS (CI upper 0.472 < 0.5)
}

// D-815 — batter_home_runs isotonic calibration. Analog of D-784/D-789 for HR.
// D-811 audit found HR had NO calibration ceiling (stale conf=100 UNDER from
// May 22-26 + conf=96 OVER June 10-20 in pick_history). HR is rare-event AND
// plus-money on OVER side (avg BE 7.3%; vs minus-money UNDER avg BE 92.9%) —
// per-side calibration is essential. PAV fit on full resolved cohort:
//
// COHORT: 9,473 resolved HR picks (is_synthetic=false). OVER n=2,075,
// UNDER n=7,398. Avg breakeven OVER 7.3% (plus-money, +200 to +500 range);
// UNDER 92.9% (heavy minus-money). PAV bins pooled to enforce monotone.
//
// UNDER PAV blocks (n=7,398):
//   raw 0-34:   78.7% empirical (n=493 floor pool)
//   raw 34-41:  80.3% empirical (n=493)
//   raw 41-51:  84.4% empirical (n=986)
//   raw 51-62:  86.4% empirical (n=1,479)
//   raw 62-65:  90.1% empirical (n=493)
//   raw ≥65:    91.2% empirical (n=3,451 — largest stable band) ← CEILING
//
// OVER PAV blocks (n=2,075):
//   raw 0-5:     1.4% empirical (n=138 floor pool)
//   raw 5-10:    2.2% empirical (n=138)
//   raw 10-16:   2.9% empirical (n=138)
//   raw 16-23:   4.3% empirical (n=276)
//   raw 23-33:   4.7% empirical (n=276)
//   raw 33-38:   8.0% empirical (n=138)
//   raw 38-51:  10.5% empirical (n=276)
//   raw 51-61:  11.6% empirical (n=138)
//   raw 61-87:  17.4% empirical (n=138)
//   raw ≥88:    20.0% empirical (n=5 — sparse but monotone) ← CEILING
//
// OOS VALIDATION (70/30 split, seed=42): OVER train MAE 0.103, test MAE 0.097
// (overfit gap -0.007 — generalizes well). UNDER train MAE 0.218, test MAE
// 0.219 (overfit gap +0.001 — stable). PAV is OOS-robust.
//
// HONEST CEILING: 91 (under), 20 (over). No HR pick can show above these
// post-D-815. OVER ceiling (20%) is HONEST vs plus-money: at avg BE 7.3%
// + realized 20% = +12.7pp edge available on top tier; below 38 → -EV by
// large margin. UNDER ceiling (91%) is HONEST vs 97.7% BE at ceiling = -6.5pp
// vig drag (still negative; UNDER side broadly under-edge). D-752 NaN-safe.
function applyD815IsotonicCalibrationBatterHomeRuns(
  rawConfidence: number,
  pickSide: string,
): number {
  if (!Number.isFinite(rawConfidence)) {
    console.error(`[d815-calib] non-finite rawConfidence rejected: ${rawConfidence}`);
    return 0;
  }
  const x = Math.round(rawConfidence);
  if (pickSide === "under") {
    if (x < 34) return 79;     // robust floor (rounded from 78.7%)
    if (x < 41) return 80;
    if (x < 51) return 84;
    if (x < 62) return 86;
    if (x < 65) return 90;
    return 91;                  // empirical ceiling — 91.2% on n=3,451
  }
  // OVER side (default for any non-"under" — also handles unexpected values).
  // HR OVER is plus-money: realistic rates 1-20%. Don't artificially inflate.
  if (x < 5)  return 1;       // robust floor — 1.4% rounded
  if (x < 10) return 2;
  if (x < 16) return 3;       // 2.9% rounded
  if (x < 23) return 4;       // 4.3% rounded
  if (x < 33) return 5;       // 4.7% rounded
  if (x < 38) return 8;
  if (x < 51) return 11;      // 10.5% rounded
  if (x < 61) return 12;      // 11.6% rounded
  if (x < 88) return 17;      // 17.4% rounded
  return 20;                   // empirical ceiling — 20.0% on n=5 sparse
}

// D-823 — batter_hits isotonic calibration. Analog of D-784/D-789/D-815 for hits.
// D-822 audit found hits has CLEAN MONOTONE EDGE PROGRESSION on OVER side
// (-2.65pp at 0-49 → -0.22pp at 65-69 → +2.83pp at 70-74 → +15pp at 80-100 n=13)
// — unique among markets, no inversion. Hits is NEAR-EVEN-MONEY: avg BE 55.8%
// OVER / 51.8% UNDER. PAV per-side on n=9,184 resolved cohort, OOS-validated
// (gap <0.003 MAE on both sides — clean generalization).
//
// COHORT: 9,184 resolved hits picks (n=4,810 OVER / n=4,374 UNDER).
//
// OVER PAV blocks (n=4,810):
//   raw 0-31:   37% empirical (n=320 floor)
//   raw 31-37:  39% (n=320)
//   raw 37-47:  49% (n=960)
//   raw 47-51:  55% (n=640)
//   raw 51-57:  56% (n=960)
//   raw 57-65:  56% (n=960)
//   raw 65-81:  64% empirical (n=640) — the meaningful tier
//   raw ≥81:    70% empirical (n=10 sparse but monotone) ← CEILING
//
// UNDER PAV blocks (n=4,374):
//   raw 0-31:   40% (n=291)
//   raw 31-35:  42% (n=291)
//   raw 35-41:  44% (n=582)
//   raw 41-48:  45% (n=1,164)
//   raw 48-52:  48% (n=582)
//   raw 52-54:  50% (n=291)
//   raw 54-60:  53% (n=582)
//   raw 60-64:  57% (n=291)
//   raw 64-79:  58% (n=291)
//   raw ≥80:    67% empirical (n=9 sparse) ← CEILING
//
// OOS VALIDATION (70/30 random split, seed=42):
//   OVER  train MAE 0.4892 / val MAE 0.4899 (gap +0.0007 — virtually no overfit)
//   UNDER train MAE 0.4950 / val MAE 0.4924 (gap -0.0025 — stable)
//
// HONEST CEILINGS: OVER 70 / UNDER 67. Both honest vs realized rates at
// max-confidence tier. NEAR-EVEN-MONEY: OVER 70% beats avg BE 55.8% by
// +14pp — this is the +EV tier (small n=10 caveat per D-822 escalation #1).
// D-752 NaN-safe guard.
function applyD823IsotonicCalibrationBatterHits(
  rawConfidence: number,
  pickSide: string,
): number {
  if (!Number.isFinite(rawConfidence)) {
    console.error(`[d823-calib] non-finite rawConfidence rejected: ${rawConfidence}`);
    return 0;
  }
  const x = Math.round(rawConfidence);
  if (pickSide === "under") {
    if (x < 31)  return 40;     // robust floor
    if (x < 35)  return 42;
    if (x < 41)  return 44;
    if (x < 48)  return 45;
    if (x < 52)  return 48;
    if (x < 54)  return 50;
    if (x < 60)  return 53;
    if (x < 64)  return 57;
    if (x < 80)  return 58;
    return 67;                   // empirical ceiling — 66.7% on n=9 sparse
  }
  // OVER side (default for any non-"under" — also handles unexpected values).
  // Hits OVER is near-even-money to plus-money (avg BE 55.8%).
  if (x < 31)  return 37;     // robust floor
  if (x < 37)  return 39;
  if (x < 47)  return 49;
  if (x < 51)  return 55;
  if (x < 57)  return 56;
  if (x < 65)  return 56;
  if (x < 81)  return 64;     // meaningful tier — 64% on n=640
  return 70;                   // empirical ceiling — 70% on n=10 sparse
}

function applyD743IsotonicCalibrationPitcherK(rawConfidence: number): number {
  // D-752 NaN-safe guard. Pre-D-752, this function used chained `if (x <= N)`
  // branches. Any comparison with NaN is false, so a NaN input fell through
  // every branch and silently returned 71 (the empirical ceiling). D-751
  // showed how easily an upstream undefined weight (W.pitcherCsw) produced a
  // NaN that masqueraded as a real top-tier confidence on every pick — and
  // the bug went undetected for ~12 hours because the cascade looked
  // mathematically valid downstream.
  //
  // Defense-in-depth: reject non-finite input loudly. We return 0 (not 71,
  // not the calibration floor 39) so a malformed pick (a) never lands in
  // recommendation_shown (>=60 gate), (b) never appears at any tier above 0
  // in the dashboard, and (c) gets logged by the scorer site for telemetry.
  // A logged 0 is recoverable; a silent 71 is not.
  if (!Number.isFinite(rawConfidence)) {
    console.error(`[d752-calib] non-finite rawConfidence rejected: ${rawConfidence}`);
    return 0;
  }
  const x = Math.round(rawConfidence);
  if (x <= 33)  return 39;  // 39.2 rounded
  if (x <= 42)  return 39;  // 39.3
  if (x === 43) return 42;  // 41.7
  if (x <= 45)  return 44;  // 44.0
  if (x <= 57)  return 53;  // 52.5
  if (x <= 59)  return 55;  // 55.0
  if (x === 60) return 57;  // 57.1
  if (x <= 73)  return 59;  // 58.8
  if (x === 74) return 67;  // 66.7
  if (x <= 76)  return 71;  // 71.4
  return 71;  // empirical ceiling — apply to any x > 76
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PitcherSeasonStats {
  gamesPlayed: number;
  inningsPitched: number;
  strikeOuts: number;
  battersFaced: number;       // proxy for plate appearances against
  kPerNine: number;
  era: number;
  pitchesPerStart: number | null;
  throws: "L" | "R" | null;   // pitcher handedness if available
  // D-671 SHIP 1 — REAL walks. Extracted from same MLB Stats API season
  // response body fetchPitcherSeason already parses (zero new HTTP).
  // Replaces D-670 fake formula in score_pitcher_walk_efficiency.
  baseOnBalls: number;
}

export interface PitcherGameLogEntry {
  date: string;
  strikeOuts: number;
  inningsPitched: number;
  opponent: string;
  pitchCount: number | null;
  // D-348 — walks per start for command_trend factor. Null when MLB API gameLog
  // didn't expose baseOnBalls for this start (rare; defensively null-safe).
  walks: number | null;
}

export interface TeamHittingStats {
  gamesPlayed: number;
  strikeOuts: number;
  plateAppearances: number;
  kRate: number;
  kRateVsLHP: number | null;
  kRateVsRHP: number | null;
  // D-668 — opponent-patience / pitch-burden signals from cache_team_batting_stats.
  // Populated by extended fetch-mlb-team-stats writer. Drive pitcher_outs factors:
  //   bbRate → score_opp_walk_rate
  //   obpSeason → score_opp_obp_patience
  //   pitchesPerPA → score_opp_pitch_grind
  // null on cache miss (back-fill rows pre-D-668) → factors gracefully return 0.
  bbRate: number | null;
  obpSeason: number | null;
  pitchesPerPA: number | null;
  // D-669 SHIP 2 — team-aggregate chase rate (oz_swing_percent) from
  // cache_savant_team_chase (Savant /leaderboard/custom + roster aggregate).
  // Drives score_opp_chase_rate_v2 — high chase = pitchers cruise = MORE outs.
  // null on cache miss → factor returns 0.
  ozSwingAvg: number | null;
}

export interface BallparkFactor {
  runsFactor: number;
  hrFactor: number;
  kFactor: number;
  hitsFactor: number;
}

export interface GameWeather {
  tempF: number | null;
  windSpeed: number | null;     // mph
  windDir: string | null;       // compass: "N", "SSW", etc.
  windDirDeg: number | null;    // D-287 SHIP 1 — raw degrees from weather API
  condition: string | null;
}

export interface UmpireStats {
  calledStrikeRate: number | null;
  kZoneSizeIndex: number | null;  // 1.00 = league avg, >1 = pitcher-friendly
}

export interface PitcherKScoringContext {
  pitcher: {
    fullName: string;
    team: string;
    opponentTeam: string;
    isHome: boolean;
    gameTime: string;
  };
  season: PitcherSeasonStats;
  gameLog: PitcherGameLogEntry[];
  opposingHitting: TeamHittingStats | null;
  ballpark: BallparkFactor | null;
  weather: GameWeather | null;
  umpire: UmpireStats | null;
  prop: {
    propType: string;       // "strikeouts"
    line: number;
    odds: number;
    pickSide: "over" | "under";
    bookmaker: string;
  };
  // D-276-FACTORS — optional Statcast enrichment for xERA edge.
  statcast?: { xera: number | null; era_minus_xera_diff: number | null; est_ba: number | null } | null;
  // D-282 SHIP 2 — catcher framing context. Passed by caller when
  // today's starting catcher's framing data is available in cache.
  catcherFraming?: { rv_tot: number | null; pitches: number | null } | null;
  // D-286 SHIP 2 — pitcher arsenal usage from cache_statcast_pitcher_arsenal.
  // breaking_ball_pct = SL + CU + FC + ST + SV. Gated total_pitches.
  arsenal?: { breaking_ball_pct: number | null; offspeed_pct: number | null; total_pitches: number | null; csw_pct?: number | null; total_pitches_csw?: number | null } | null;
  // D-349 — primary fastball avg velocity (max of ff_avg_speed, si_avg_speed)
  // from cache_statcast_pitcher_arsenal. Null when cache miss / not enough pitches.
  velocity?: { primary_fb_velo: number | null } | null;
  // D-354 — position-weighted opposing-lineup K rate (composite of 9 batters'
  // season K rates weighted by lineup slot). Null when lineup or batter data
  // missing for ≥3 of 9 slots.
  lineupKComposition?: { weighted_k_rate: number | null; batters_with_data: number } | null;
  // D-596 — usage-weighted per-pitch-type aggregates from cache_statcast_pitcher_arsenal.
  // Consumed by score_pitch_type_matchup. D-594 measured corr(expected_put_away,
  // K - line) = 0.122 (full corpus) / 0.334 (conf>=70) — book-uncaptured granular
  // pitch-type K conversion. Null when pitcher arsenal cache miss.
  pitchTypeMatchup?: {
    expected_whiff_pct: number | null;
    expected_k_pct: number | null;
    expected_put_away: number | null;
  } | null;
  // D-668 — game-situation signals for scorePitcherOuts (durability market).
  // ownTeamPenIp48h: pitcher's own team relief IP last 48h (cache_mlb_pen_rest).
  //   Gassed pen → manager keeps SP in longer → MORE outs.
  // ownTeamRunsPerGame + oppRunsPerGame: from cache_team_batting_stats.
  //   Big RPG gap → blowout risk → starter pulled early.
  // Null on cache miss → factors gracefully return 0.
  ownTeamPenIp48h?: number | null;
  ownTeamRunsPerGame?: number | null;
  oppRunsPerGame?: number | null;
  // D-669 SHIP 1 — first-inning trouble. From cache_mlb_pitcher_inn1.
  // High first-inning ERA / BB → SP labors early → pulled sooner → fewer outs.
  // Null on cache miss → factor returns 0.
  inn1Era?: number | null;
  inn1Ip?: number | null;
  inn1Walks?: number | null;
  // D-761 — 3rd-time-through-order signal. Same cache_mlb_pitcher_inn1 row,
  // i06_* columns (added D-761 migration). High i06 OPS (>.800) → 3rd time
  // hurts SP → manager pulls before facing it again → UNDER. Null on
  // legacy rows or small i06 sample → factor returns 0.
  thirdTimeOps?: number | null;
  thirdTimeIp?: number | null;
  // D-763 — REAL manager-hook signal from cache_mlb_team_manager_hook. Computed
  // from MLB Stats API starter-only team aggregate (sitCodes=sp). Supersedes
  // D-668's fake volatility_v2 "manager_pull" proxy (which D-671 SHIP 2
  // honestly admitted measured pitcher behavior, not manager). Negative
  // hook_index = quick-hook manager (favor UNDER). League avg = 0.
  // Null on cache miss → factor returns 0.
  ownTeamHookIndex?: number | null;
}

// =====================================================================
// D-668 SHIP 1 — Shared expected-IP helper.
// D-695 — Poisson + implied-probability helpers for the pitcher_strikeouts
// win-probability rebuild. Pilot scope: pitcher_strikeouts ONLY. Other markets
// untouched. Closed-form: λ = projectedStat (factor-adjusted); P(over) =
// 1 - poissonCdf(line_floor, λ); confidence = round(winProb × 100).
//
// Numerically-stable Poisson CDF using forward iteration on log-prob terms.
// For typical pitcher K λ ∈ [3, 12] the direct iteration is exact to ≥1e-12.
export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  // Forward sum: e^-λ × Σ_{i=0}^{k} λ^i / i!
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(sum, 1);
}

// Implied probability from American odds. Matches src/lib/odds.ts:23 (canonical
// frontend helper). Inlined here because edge functions can't import from src/.
export function impliedProbAmerican(odds: number): number {
  if (odds < 0) return -odds / (-odds + 100);
  return 100 / (odds + 100);
}

function americanToDecimal(odds: number): number {
  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

// D-695 — Poisson win-probability for K-over/under at a given line + λ.
// MLB pitcher K lines are typically .5-step (4.5, 5.5, 6.5, 7.5, 8.5).
// "over X.5" means K ≥ ceil(X.5) = X+1, i.e. P(K ≥ X+1) = 1 - P(K ≤ X).
// "under X.5" means K ≤ X. Integer lines (rare, e.g. 5.0) carry a push leg
// which we ignore here — over X.0 = P(K > X), under X.0 = P(K < X). Push
// outcomes refund stake so they don't affect WinProb framing for confidence.
export function winProbPoissonK(lambda: number, line: number, pickSide: "over" | "under"): number {
  const kFloor = Math.floor(line);                    // 4.5 → 4 ; 5.0 → 5
  const pUnderOrEq = poissonCdf(kFloor, lambda);      // P(K ≤ kFloor)
  if (pickSide === "over") {
    // For .5 lines: over wins iff K ≥ kFloor+1 ⇔ K > kFloor
    // For integer lines: over wins iff K > kFloor (push at K=kFloor)
    return 1 - pUnderOrEq;
  } else {
    // under: K ≤ kFloor for .5 lines; K < kFloor for integer lines
    if (Math.floor(line) === line) {
      // integer line — exclude push leg
      const pAtK = pUnderOrEq - poissonCdf(kFloor - 1, lambda);
      return pUnderOrEq - pAtK;
    }
    return pUnderOrEq;
  }
}

/** M6 — harness-only Poisson tuning (null = production defaults). */
let _poissonTuningOverride: {
  market?: string;
  disablePoisson?: boolean;
  lambdaCoeff?: number;
  shrinkFactor?: number;
} | null = null;

/** Harness A/B + λ/shrink sweeps. Defaults unchanged → zero production impact. */
export function setPoissonTuningOverride(
  o: {
    market?: string;
    disablePoisson?: boolean;
    lambdaCoeff?: number;
    shrinkFactor?: number;
  } | null,
): void {
  _poissonTuningOverride = o;
}

function poissonDisabledForHarness(): boolean {
  return _poissonTuningOverride?.disablePoisson === true;
}

function getLambdaCoeff(): number {
  return _poissonTuningOverride?.lambdaCoeff ?? 0.002;
}

function getShrinkFactor(): number {
  return _poissonTuningOverride?.shrinkFactor ?? 0.4;
}

/** Test helper — read active harness Poisson override. */
export function _getPoissonTuningForTest(): typeof _poissonTuningOverride {
  return _poissonTuningOverride;
}

/** M5 — shared Poisson win-prob helpers for batter + pitcher count markets. */
function shrinkPoissonConfidence(rawPct: number): number {
  const shrink = getShrinkFactor();
  const raw = clamp(Math.round(rawPct), 0, 100);
  return clamp(raw > 60 ? Math.round(60 + (raw - 60) * shrink) : raw, 0, 100);
}

function computeEvFromWinProb(
  winProb: number,
  odds: number,
): { edgeVsImplied: number; evPerUnit: number } {
  return {
    edgeVsImplied: Math.round((winProb - impliedProbAmerican(odds)) * 10000) / 10000,
    evPerUnit: Math.round(
      (winProb * americanToDecimal(odds) - (1 - winProb)) * 10000,
    ) / 10000,
  };
}

function isPoissonBatterStat(
  marketStat: string,
): marketStat is "hits" | "totalBases" | "homeRuns" | "rbi" {
  return marketStat === "hits" || marketStat === "totalBases" ||
    marketStat === "homeRuns" || marketStat === "rbi";
}

// Pitcher_k (D-666) and pitcher_outs (D-668) both project expected innings.
// Pre-D-668: pitcher_k had this logic inline at scoring_mlb_v2.ts:240-256;
//            pitcher_outs duplicated weaker math at 982-996. Per D-667 the
//            two scorers had different blend ratios (0.50/0.50 vs 0.55/0.45)
//            and pitcher_outs had no clamp. D-668 extracts ONE function that
//            both call → no drift, no duplication.
// Memory: pure computation, no I/O, ~6 floats per call.
// =====================================================================
export function computeExpectedIP(
  season: PitcherSeasonStats,
  gameLog: PitcherGameLogEntry[],
): { expectedIP: number; seasonIPperStart: number; last5IPperStart: number } {
  const last5 = gameLog.slice(-5);
  const seasonIPperStart = (season.gamesPlayed > 0 && season.inningsPitched > 0)
    ? season.inningsPitched / season.gamesPlayed
    : 5.5;
  const last5IPperStart = last5.length > 0
    ? last5.reduce((a, g) => a + g.inningsPitched, 0) / last5.length
    : seasonIPperStart;
  // 50/50 blend + clamp to sane SP range (3.5-7.5 IP) so a single-relief
  // appearance can't pull blend below the typical opener floor.
  const expectedIP = Math.max(3.5, Math.min(7.5,
    0.5 * last5IPperStart + 0.5 * seasonIPperStart,
  ));
  return { expectedIP, seasonIPperStart, last5IPperStart };
}

export interface PitcherKScoringResult {
  confidence: number;                  // 0-100 final
  confidence_pre_cap: number;          // D-406: confidence BEFORE D-140 trivial-line cap at line 521
  confidence_pre_tier_aware: number;   // == confidence for MLB v1 (no tier mods)
  verdict: string;
  projectedK: number;
  seasonAvg: number;
  recentAvg: number;
  edge: number;
  // 10 factor magnitudes (post-weight, side-flipped) — these land in
  // pick_history.score_* columns. Range typically -15..+15.
  score_pitcher_k_rate: number;
  score_pitcher_form: number;
  score_opposing_lineup_k: number;
  score_handedness_matchup: number;
  score_pitch_count_trend: number;
  score_rest_pitcher: number;
  score_ballpark_factor: number;
  score_weather_wind: number;
  score_weather_temp: number;
  score_umpire_k_zone: number;
  // D-348 — pitcher's own command trend (recent BB/9 vs season BB/9).
  score_pitcher_command_trend: number;
  // D-349 — primary fastball avg velocity vs league avg.
  score_pitcher_velocity_trend: number;
  // D-354 — position-weighted opposing lineup K rate composite.
  score_lineup_k_composition: number;
  // D-596 — pitch-type matchup signal (usage-weighted K conversion rate per
  // pitch type). The decisive book-uncaptured signal per D-594.
  score_pitch_type_matchup: number;
  // D-666 — standalone whiff% factor (the #1 K predictor per public research).
  // Reads expected_whiff_pct from cache_statcast_pitcher_arsenal.
  score_pitcher_whiff_skill_v2: number;
  // D-749 — CSW% (Called Strike + Whiff) factor. Single most predictive K
  // metric per FanGraphs / Baseball Prospectus research. Distinct from
  // whiff_skill_v2: CSW captures BOTH called-strike skill (zone control) and
  // raw swing-and-miss, whereas whiff_skill_v2 reads a derived expected_whiff
  // that has been NULL in cache (factor effectively dead). Source: Baseball
  // Savant custom leaderboard p_called_strike + p_swinging_strike / p_total_pitches.
  // League avg ~26.7% (D-749 backfill mean), elite 35%+.
  score_pitcher_csw: number;
  /** D-695 / M5 — Poisson win-prob EV fields (pitcher_k + pitcher_outs). */
  winProb?: number;
  edgeVsImplied?: number;
  evPerUnit?: number;
  unbettableOverBreakevenFlag?: boolean;
  // Sanity flags (NBA parity)
  unbettableJuiceFlag: boolean;
  coinFlipFlag: boolean;
  negativeStackingFlag: boolean;
  negativeFactorCount: number;
  // Full breakdown for audit / UI display
  breakdown: Record<string, number | string | null | boolean>;
}

// ---------------------------------------------------------------------------
// MLB league-wide constants (2024 reference; refresh annually)
// ---------------------------------------------------------------------------

const LEAGUE_AVG_TEAM_K_RATE = 0.225;     // ~22.5% PA → K across MLB
const LEAGUE_AVG_K_PER_NINE  = 8.6;       // SP league avg ~8.6 K/9
const LEAGUE_AVG_TEMP_F      = 72;        // mild
const STARTER_PITCHES_NORM   = 90;        // typical starter
const STANDARD_REST_DAYS     = 5;         // 5-day rotation

// ---------------------------------------------------------------------------
// Factor weights — default v1, hot-tunable via DB later.
// Magnitudes are pre-clamped to roughly [-12, +12] per factor.
// ---------------------------------------------------------------------------

// D-340 / T6 — weights now mutable + DB-tunable via setMlbWeights().
// Scoring code references W / W_BATTER / W_GAME unchanged; the let-binding
// lets process-games-mlb's loadMlbWeightsFromDB() swap values at runtime
// per cron tick. See _shared/mlb_weights.ts for the loader.
// DEFAULT_W* objects below preserve the pre-D-340 hardcoded values; if DB
// row is missing or unparseable, scoring falls back to these defaults.
const DEFAULT_W = {
  pitcherKRate:        1.5,
  pitcherForm:         1.5,
  opposingLineupK:     1.5,
  handednessMatchup:   0.5,
  pitchCountTrend:     0.5,
  restPitcher:         0.5,
  ballparkFactor:      1.0,
  weatherWind:         0.25,
  weatherTemp:         0.25,
  umpireKZone:         0.75,
  // D-348
  pitcherCommandTrend: 0.5,
  // D-349
  pitcherVelocityTrend: 1.0,
  // D-354
  lineupKComposition: 1.0,
  // D-362 — DB-tunable weights for the 4 pitcher-side factors that previously
  // had hardcoded `* 1.0` literals in scoring_mlb_v2.ts. All default 1.0 to
  // preserve current effective weight; T11 can move them via DB updates.
  pitcherXeraEdge: 1.0,
  pitcherBaa: 1.0,
  catcherFraming: 1.0,
  pitcherPitchMixK: 1.0,
  // D-596 — pitch-type matchup factor. Seeded conservatively at 1.0; D-597
  // will tune via the harness after 14d of populated data. Range matches
  // the other "important" factors (pitcherXeraEdge / pitcherBaa).
  pitchTypeMatchup: 1.0,
  // D-749 — CSW% factor. Seeded at 1.0 (D-747 proved weights are absorbed
  // by the calibration ceiling regardless of magnitude — the value is in
  // adding the SIGNAL, not in tuning the weight). Future re-tune via
  // optimize-weights-mlb.
  pitcherCsw: 1.0,
  // D-760 — pitcher_outs weights moved from LITERALS in scorePitcherOuts body
  // (per D-759 audit) to DB-tunable keys. Seeded at the EXACT same literal
  // values that were hardcoded in the scorer — pure tunability move, NO value
  // change vs the in-prod scoring behavior. Distinct prefix "outs" so they
  // don't collide with pitcher_k weights (which often differ — e.g. pitcher_k
  // ballpark_factor is -0.01 post-D-746 but pitcher_outs uses 1.0). 17 keys
  // for the 15 wired factors + 2 repurposed-shared (restPitcher, weatherTemp)
  // whose pitcher_outs values diverge from pitcher_k's. D-755 build guard
  // catches any unwired loader miss.
  outsPitcherAvgIp:            1.5,
  outsPitcherRecentIpTrend:    1.0,
  outsPitcherVolatilityV2:     0.75,
  outsRestPitcher:             0.75,
  outsPitcherWalkEfficiency:   0.75,
  outsPitcherRecentPitchCount: 1.0,
  outsFirstInningTrouble:      1.0,
  outsBullpenGameOrOpener:     1.5,
  outsOwnPenRest:              1.0,
  outsGameScriptRisk:          1.0,
  outsOppKRate:                1.0,
  outsOppObpPatience:          1.0,
  outsOppWalkRate:             0.75,
  outsOppPitchGrind:           0.75,
  outsOppChaseRate:            1.0,
  outsBallparkFactor:          1.0,
  outsWeatherTemp:             0.5,
  // D-761 — 2 NEW pitcher_outs factors targeting the structural under-side
  // gap (35.9% WR on n=64 per D-760). Both predict EARLY HOOKS. Conservative
  // starting weights at 1.0 each; D-761 backtest tells if signal warrants tuning.
  //
  // outsThirdTimeThrough — score_pitcher_third_time_penalty: OPS allowed on
  //   3rd time through the lineup (sitCode=i06 in cache_mlb_pitcher_inn1).
  //   Research: 80-100 OPS point jump 3rd time. League avg ~.700; >.800 = bad.
  //   Bucket favors UNDER when pitcher gets hit hard 3rd time.
  // outsPitchesPerIp — score_pitcher_pitches_per_ip: efficiency ratio
  //   derived from season.pitchesPerStart / seasonIPperStart (no new ingest).
  //   Research: <15 = deep guy (favor OVER), 17+ = early hook (favor UNDER).
  outsThirdTimeThrough:        1.0,
  outsPitchesPerIp:            1.0,
  // D-763 — REAL manager-hook factor from cache_mlb_team_manager_hook. Closes
  // D-668-FOLLOWUP-PULL-FEED. Seeded at 1.5 (higher than the volatility_v2
  // proxy's 0.75) because this is the genuine signal D-761 proved necessary
  // — research consistently ranks manager hook tendency in the top 3
  // pitcher_outs predictors. NO existing weight changes; the proxy weight
  // (outsPitcherVolatilityV2 = 0.75) stays, but the new factor will dominate
  // when both fire. Future D-764 may demote the proxy.
  outsManagerHook:             1.5,
} as const;
let W: { -readonly [K in keyof typeof DEFAULT_W]: number } = { ...DEFAULT_W };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function getScoreLabel(c: number): string {
  if (c >= 90) return "ELITE";
  if (c >= 80) return "STRONG";
  if (c >= 70) return "GOOD";
  if (c >= 60) return "LEAN";
  return "PASS";
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

export function scorePitcherStrikeouts(ctx: PitcherKScoringContext): PitcherKScoringResult {
  const { season, gameLog, opposingHitting, ballpark, weather, umpire, prop, pitcher } = ctx;
  const sideFlip = prop.pickSide === "under" ? -1 : 1;

  // ====================================================================
  // D-666 — Projection rebuilt on STRIKEOUT SKILL + EXPECTED INNINGS.
  // Pre-D-666: projectedK = (0.6 × last5_K + 0.4 × season_K_per_start)
  //            × opp × park. Uses RAW K COUNT (noisy, no volume input,
  //            same class as HR-off-ERA misuse fixed in D-660).
  // Post-D-666: project K from skill (season K-per-BF) × expected_BF
  //             (from expected_IP × season BF/IP), blend recent form
  //             scaled to expected start length, apply whiff multiplier
  //             when Statcast available, then opp + park.
  // ====================================================================
  const last5 = gameLog.slice(-5);
  const recentAvg = last5.length > 0
    ? last5.reduce((a, g) => a + g.strikeOuts, 0) / last5.length
    : 0;
  const seasonAvgPerStart = season.gamesPlayed > 0
    ? season.strikeOuts / season.gamesPlayed
    : 0;

  // SKILL — season strikeouts per batter faced (stable; primary signal).
  const seasonKperBF = season.battersFaced > 0
    ? season.strikeOuts / season.battersFaced
    : 0;
  // VOLUME — season batters faced per inning (used to convert IP → BF).
  // League typical ~4.3 BF/IP; clamped so a 1-inning relief sample can't
  // skew the conversion for a now-converted starter.
  const seasonBFperIP = (season.battersFaced > 0 && season.inningsPitched > 0)
    ? clamp(season.battersFaced / season.inningsPitched, 3.8, 4.8)
    : 4.3;
  // VOLUME — season innings per start.
  const seasonIPperStart = (season.gamesPlayed > 0 && season.inningsPitched > 0)
    ? season.inningsPitched / season.gamesPlayed
    : 5.5;
  // VOLUME — recent IP/start trend (last 5).
  const last5IPperStart = last5.length > 0
    ? last5.reduce((a, g) => a + g.inningsPitched, 0) / last5.length
    : seasonIPperStart;
  // EXPECTED IP — blend 50/50 recent trend with season (clamped sane range).
  const expectedIP = clamp(0.5 * last5IPperStart + 0.5 * seasonIPperStart, 3.5, 7.5);
  // EXPECTED BF — expected innings × BF/IP ratio.
  const expectedBF = expectedIP * seasonBFperIP;
  // SKILL-BASED PROJECTION (the new core).
  const projectedK_skill = seasonKperBF * expectedBF;

  // RECENT-FORM PROJECTION — scaled to the expected start length so a
  // 4-inning average isn't compared with a 6.5-inning expectation.
  const recentKperStart_scaled = (last5IPperStart > 0 && last5.length > 0)
    ? recentAvg * (expectedIP / last5IPperStart)
    : 0;
  // BLEND — skill 60% / scaled recent form 40%. Skill is more predictive
  // long-run; recent form catches mechanics changes the season number is
  // slow to register.
  const blended = (seasonKperBF > 0 && expectedBF > 0)
    ? (recentKperStart_scaled > 0
        ? 0.60 * projectedK_skill + 0.40 * recentKperStart_scaled
        : projectedK_skill)
    : (recentAvg > 0
        ? 0.6 * recentAvg + 0.4 * seasonAvgPerStart
        : seasonAvgPerStart);  // graceful fallback to v0 blend when season K/BF unavailable

  const oppKRate = opposingHitting?.kRate ?? LEAGUE_AVG_TEAM_K_RATE;
  const oppAdjustment = clamp(oppKRate / LEAGUE_AVG_TEAM_K_RATE, 0.75, 1.30);
  const parkAdj = ballpark ? clamp(ballpark.kFactor, 0.85, 1.20) : 1.0;

  // D-666 — WHIFF MULTIPLIER from Statcast arsenal (when available).
  // Whiff% is the #1 K predictor per public research; folding it into
  // projection (not just a factor signal) catches K-skill the K/BF
  // ratio undersmoothes when sample is small. Coverage gated; gracefully
  // degrades to 1.0 multiplier (no effect) on cache miss.
  const LEAGUE_AVG_WHIFF_PCT = 26.0;  // ~26% MLB league avg (Statcast)
  const arsenalWhiff = ctx.pitchTypeMatchup?.expected_whiff_pct ?? null;
  const whiffMult = (typeof arsenalWhiff === "number" && arsenalWhiff > 0)
    ? clamp(arsenalWhiff / LEAGUE_AVG_WHIFF_PCT, 0.85, 1.20)
    : 1.0;

  const projectedK = blended * oppAdjustment * parkAdj * whiffMult;
  const edge = (projectedK - prop.line) * sideFlip;

  // ---- base confidence: 50 + 6*edge (slightly more conservative than v0's 8x)
  let confidence = 50 + edge * 6;

  // ============================================================
  // FACTOR 1 — score_pitcher_k_rate
  // Season K/9 z-score vs league avg 8.6. >9.5 K/9 = elite, <7.5 = weak.
  // ============================================================
  let f_pitcherKRate = 0;
  if (season.kPerNine > 0) {
    const z = (season.kPerNine - LEAGUE_AVG_K_PER_NINE) / 1.5;  // sigma ~ 1.5
    if (z >= 1.5)      f_pitcherKRate = 10;
    else if (z >= 1.0) f_pitcherKRate = 7;
    else if (z >= 0.5) f_pitcherKRate = 4;
    else if (z <= -1.5) f_pitcherKRate = -10;
    else if (z <= -1.0) f_pitcherKRate = -7;
    else if (z <= -0.5) f_pitcherKRate = -4;
  }
  f_pitcherKRate *= sideFlip;
  const score_pitcher_k_rate = roundHalfAwayFromZero(f_pitcherKRate * W.pitcherKRate);

  // ============================================================
  // FACTOR 2 — score_pitcher_form
  // Last 5 starts K avg delta from season per-start. +1.5/start = hot.
  // ============================================================
  let f_pitcherForm = 0;
  if (last5.length >= 3 && seasonAvgPerStart > 0) {
    const delta = recentAvg - seasonAvgPerStart;
    if (delta >= 2.0)      f_pitcherForm = 8;
    else if (delta >= 1.0) f_pitcherForm = 4;
    else if (delta >= 0.5) f_pitcherForm = 2;
    else if (delta <= -2.0) f_pitcherForm = -8;
    else if (delta <= -1.0) f_pitcherForm = -4;
    else if (delta <= -0.5) f_pitcherForm = -2;
  }
  f_pitcherForm *= sideFlip;
  // D-733 — STATUS: KEEP (D-708 fire 22/50 = 44%; by-design natural neutral zone — many pitchers cluster near season avg; signal real on the firing 44%)
  const score_pitcher_form = roundHalfAwayFromZero(f_pitcherForm * W.pitcherForm);

  // ============================================================
  // FACTOR 3 — score_opposing_lineup_k
  // Opp team K-rate vs league avg 22.5%.
  // ============================================================
  let f_opposingLineupK = 0;
  if (opposingHitting && opposingHitting.plateAppearances > 0) {
    const diff = oppKRate - LEAGUE_AVG_TEAM_K_RATE;
    if (diff >= 0.035)      f_opposingLineupK = 8;
    else if (diff >= 0.020) f_opposingLineupK = 5;
    else if (diff >= 0.010) f_opposingLineupK = 2;
    else if (diff <= -0.035) f_opposingLineupK = -8;
    else if (diff <= -0.020) f_opposingLineupK = -5;
    else if (diff <= -0.010) f_opposingLineupK = -2;
  }
  f_opposingLineupK *= sideFlip;
  const score_opposing_lineup_k = roundHalfAwayFromZero(f_opposingLineupK * W.opposingLineupK);

  // ============================================================
  // FACTOR 4 — score_handedness_matchup
  // Opp K-rate vs this pitcher's hand. Lefties tend to get more K
  // vs lefty-heavy lineups (and vice versa). v1: degraded gracefully
  // when handedness or split data unavailable.
  // ============================================================
  let f_handednessMatchup = 0;
  if (season.throws && opposingHitting) {
    const oppSplit = season.throws === "L"
      ? opposingHitting.kRateVsLHP
      : opposingHitting.kRateVsRHP;
    if (oppSplit !== null) {
      const split = oppSplit - LEAGUE_AVG_TEAM_K_RATE;
      if (split >= 0.030)      f_handednessMatchup = 6;
      else if (split >= 0.015) f_handednessMatchup = 3;
      else if (split <= -0.030) f_handednessMatchup = -6;
      else if (split <= -0.015) f_handednessMatchup = -3;
    }
  }
  f_handednessMatchup *= sideFlip;
  // D-733 — STATUS: FLAG (D-708 fire 16/50 = 32%; mixed cause — data gate + weight×bucket rounding; any fix touches §19.3 weight or gate threshold; CEO decision: keep, retune, or remove)
  const score_handedness_matchup = roundHalfAwayFromZero(f_handednessMatchup * W.handednessMatchup);

  // ============================================================
  // FACTOR 5 — score_pitch_count_trend
  // Last 3 starts avg pitch count vs starter norm (90). Pitcher
  // going deeper = more K opportunity. Limited use when pitch_count
  // is null in the source data.
  // ============================================================
  let f_pitchCountTrend = 0;
  // D-346 SHIP 2 — filter THEN slice. Previously sliced-then-filtered, which dropped the
  // 3rd-most-recent start when the current-day game (no cache row yet) was the gameLog tail
  // and pitchCount was null. Effect: factor stuck at ~17% fire vs designed ~70%+.
  const startsWithPC = gameLog.filter((g) => typeof g.pitchCount === "number" && (g.pitchCount as number) > 0);
  const last3WithPC = startsWithPC.slice(-3);
  if (last3WithPC.length >= 2) {
    const avgPC = last3WithPC.reduce((a, g) => a + (g.pitchCount as number), 0) / last3WithPC.length;
    const delta = avgPC - STARTER_PITCHES_NORM;
    // D-739 SIGN FLIP — buckets inverted from original ("pitcher going deeper = more K").
    // Empirical signal across 4 independent measurements is the OPPOSITE: high recent
    // pitch counts predict UNDER-performance on over picks (labored starts → walks, hits
    // in play, manager-pull risk → fewer K than book line). Confirmed by D-736 (empirical
    // OVER/UNDER fire-rate gap on real picks: positive cohort UNDER-performed by 6.4pp),
    // D-737f+e (Python recompute optimizer: +0.5 DB → -0.19 fit), D-737f-A (real-code
    // recompute on 804 picks: +0.5 → -0.23), D-737f-A-3 (post-fix on 948 picks: +0.5 →
    // -0.16). D-738 Test 4 added a sign-flipped variant to a high-parity-only OOS fit:
    // OOS 43.86% → 48.07% (+4.21pp improvement) with coef +0.15 (meaningful positive
    // after flip). The flip restores the factor's predictive direction; magnitude
    // tuning is a separate (re-optimizer) iteration.
    if (delta >= 15)       f_pitchCountTrend = -4;  // was +4
    else if (delta >= 7)   f_pitchCountTrend = -2;  // was +2
    else if (delta <= -15) f_pitchCountTrend = 4;   // was -4
    else if (delta <= -7)  f_pitchCountTrend = 2;   // was -2
  }
  f_pitchCountTrend *= sideFlip;
  // D-733 — STATUS: FLAG (D-708 fire 22/50 = 44%; persistent pitchCount nulls in early-season game logs + neutral zone ±7 pitches; data backfill could lift fire rate; CEO decision)
  // D-739 — buckets inverted (sign flip applied above; magnitude/weight unchanged)
  const score_pitch_count_trend = roundHalfAwayFromZero(f_pitchCountTrend * W.pitchCountTrend);

  // ============================================================
  // FACTOR 6 — score_rest_pitcher
  // Days since last start. 5-day = norm. 6+ days = potentially
  // strained or recovering; 4 days = short rest.
  // ============================================================
  let f_restPitcher = 0;
  if (gameLog.length > 0 && gameLog[gameLog.length - 1].date) {
    const lastDate = new Date(gameLog[gameLog.length - 1].date);
    const gameDate = new Date(pitcher.gameTime || new Date());
    const days = Math.floor((gameDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    if (days >= 7)       f_restPitcher = -3;   // rusty / injury return
    else if (days === 6) f_restPitcher = 1;    // extra rest, mild +
    else if (days === STANDARD_REST_DAYS) f_restPitcher = 0;
    else if (days === 4) f_restPitcher = -2;   // short rest
    else if (days <= 3 && days > 0) f_restPitcher = -5;
  }
  f_restPitcher *= sideFlip;
  // D-733 — STATUS: KEEP (D-708 fire 19/50 = 38%; by-design — 5-day rest is the most common case and produces 0 by spec; factor only differentiates abnormal rest, which is intentional)
  const score_rest_pitcher = roundHalfAwayFromZero(f_restPitcher * W.restPitcher);

  // ============================================================
  // FACTOR 7 — score_ballpark_factor
  // K-factor: <1.0 = hitter park (fewer K, more hits in play), >1.0
  // = pitcher park (more K). Range typically 0.95-1.03.
  // ============================================================
  let f_ballparkFactor = 0;
  if (ballpark) {
    const k = ballpark.kFactor;
    if (k >= 1.025)       f_ballparkFactor = 6;
    else if (k >= 1.010)  f_ballparkFactor = 3;
    else if (k >= 1.005)  f_ballparkFactor = 1;
    else if (k <= 0.975)  f_ballparkFactor = -6;
    else if (k <= 0.990)  f_ballparkFactor = -3;
    else if (k <= 0.995)  f_ballparkFactor = -1;
  }
  f_ballparkFactor *= sideFlip;
  const score_ballpark_factor = roundHalfAwayFromZero(f_ballparkFactor * W.ballparkFactor);

  // ============================================================
  // D-737 — RESTORE 3 factors D-736 removed. The D-736 "worthless" verdict was
  // measured INSIDE the broken model (circular: a factor that never fires
  // looks worthless even if its signal would be powerful when wired). Per
  // CEO directive: restore the formulas, fix the data wiring so each factor
  // actually fires on real picks when data exists, and defer signal judgment
  // to step 3 clean backtest.
  //
  // Data wiring diagnosis (D-737 SHIP 2):
  //   - weather_wind: data IS available (13/16 today have wind speed). Failure
  //     was rounding-kill: 0.25 × bucket ±1 = 0.25 → Math.round = 0. Fix: widen
  //     bucket magnitudes ×2 so the formula produces non-zero scores at moderate
  //     winds (the cases that hit 99% of MLB games).
  //   - weather_temp: same class. ±1 buckets rounded to 0; ±2 and ±3 did fire.
  //     Fix: widen bucket magnitudes ×2 so mild-temp games (the typical case)
  //     produce non-zero scores.
  //   - umpire_k_zone: NOT a wiring bug. Data source (cache_umpire_stats joined
  //     via scoreboard.umpire_name) exists and works. The 86% 7-day coverage
  //     drops to ~19% pre-game because umpire assignments are announced close
  //     to game time. Picks scored early in the day miss umpire data; that's
  //     game-day timing, not a scoring bug. Formula RESTORED AS-IS. Re-scoring
  //     picks after umpire announcement is a separate pipeline question, NOT
  //     a D-737 scope item.
  //
  // §19.3 math change: bucket magnitudes for weather_wind + weather_temp doubled.
  // This makes the factor produce non-zero scores on more picks (the intent —
  // fix the rounding-kill). Signal direction unchanged. Whether the (now-firing)
  // factor improves WR is the step-3 backtest's job to judge.
  // ============================================================

  // ============================================================
  // D-737 FACTOR 8 — score_weather_wind (RESTORED, buckets widened ×3)
  // Strong wind tends to depress K-rate by changing pitch movement;
  // calm conditions slightly favor K (cleaner ball flight). Indoor → 0.
  //
  // Buckets MUST be ≥ ±3 to fire symmetrically on both sides due to
  // JavaScript Math.round asymmetry: Math.round(0.5) = 1 BUT
  // Math.round(-0.5) = 0. With weight 0.25 × bucket ±2 = ±0.5, only OVER
  // picks would fire (UNDER picks stay 0). At ±3 → weight × bucket = ±0.75,
  // and Math.round(±0.75) = ±1 — symmetric.
  //
  // Buckets vs D-708 originals (±3 extreme / ±1 mild — both rounded-killed
  // on at least one side at weight 0.25): ±6 / ±3 (extreme score ±2, mild ±1).
  // ============================================================
  let f_weatherWind = 0;
  if (weather && weather.condition !== "indoor" && typeof weather.windSpeed === "number") {
    const ws = weather.windSpeed;
    if (ws >= 18)      f_weatherWind = -6;  // D-737: was -3
    else if (ws >= 12) f_weatherWind = -3;  // D-737: was -1, raised to ±3 for symmetric firing
    else if (ws <= 4)  f_weatherWind = 3;   // D-737: was +1, raised to +3 for symmetric firing
  }
  f_weatherWind *= sideFlip;
  const score_weather_wind = roundHalfAwayFromZero(f_weatherWind * W.weatherWind);

  // ============================================================
  // D-737 FACTOR 9 — score_weather_temp (RESTORED, buckets widened)
  // Hot air = ball flies = fewer K. Cool air = denser, more K. Indoor → 0.
  // Mild-temp ±1 buckets bumped to ±3 (so 0.25 × 3 = 0.75 → rounds to ±1
  // symmetrically). Extreme ±3 buckets bumped to ±6 (so ±1.5 → ±2). Mid-tier
  // ±2 bumped to ±4 (±1.0 → ±1).
  // ============================================================
  let f_weatherTemp = 0;
  if (weather && weather.condition !== "indoor" && typeof weather.tempF === "number") {
    const d = weather.tempF - LEAGUE_AVG_TEMP_F;
    if (d >= 15)       f_weatherTemp = -6;  // D-737: was -3
    else if (d >= 8)   f_weatherTemp = -3;  // D-737: was -1
    else if (d >= 4)   f_weatherTemp = -3;  // D-737: was -1 (D-689 widened band)
    else if (d <= -15) f_weatherTemp = 6;   // D-737: was +3
    else if (d <= -8)  f_weatherTemp = 4;   // D-737: was +2 (one tier wider)
    else if (d <= -4)  f_weatherTemp = 3;   // D-737: was +1 (D-689 widened band)
  }
  f_weatherTemp *= sideFlip;
  const score_weather_temp = roundHalfAwayFromZero(f_weatherTemp * W.weatherTemp);

  // ============================================================
  // D-737 FACTOR 10 — score_umpire_k_zone (RESTORED AS-IS)
  // k_zone_size_index >1 = bigger called-strike zone = pitcher friendly.
  // D-737 NOTE: the D-708 "fire rate 4/50 = 8%" finding was real for the
  // sampled cohort but reflects DATA TIMING, not a wiring bug. Pre-game
  // umpire assignment is announced close to game time; picks scored early
  // in the day miss umpire data (factor returns 0 via gate). The cache
  // (cache_umpire_stats) IS populated for assigned umpires (86% over 7-day
  // window in last check). The formula and data source are correct;
  // improving fire rate requires re-scoring picks after umpire assignment,
  // which is a separate pipeline iteration (out of D-737 scope).
  // ============================================================
  let f_umpireKZone = 0;
  if (umpire && typeof umpire.kZoneSizeIndex === "number") {
    const kz = umpire.kZoneSizeIndex;
    if (kz >= 1.06)      f_umpireKZone = 6;
    else if (kz >= 1.03) f_umpireKZone = 3;
    else if (kz >= 1.01) f_umpireKZone = 1;
    else if (kz >= 1.005) f_umpireKZone = 1;  // D-689 mild pitcher-friendly band
    else if (kz <= 0.94) f_umpireKZone = -6;
    else if (kz <= 0.97) f_umpireKZone = -3;
    else if (kz <= 0.99) f_umpireKZone = -1;
    else if (kz <= 0.995) f_umpireKZone = -1; // D-689 mild batter-friendly band
  }
  f_umpireKZone *= sideFlip;
  const score_umpire_k_zone = roundHalfAwayFromZero(f_umpireKZone * W.umpireKZone);

  // ============================================================
  // D-348 FACTOR — score_pitcher_command_trend
  // L3-start BB/9 vs season BB/9. Higher recent walks → command slipping →
  // fewer Ks (walks don't count as Ks AND command issues correlate with
  // missing the zone, fewer swinging strikes). Lower recent walks → command
  // sharper → +K signal.
  //
  // Gate: requires at least 5 season starts (for stable season-BB/9) AND
  // L3 starts have >=10 combined IP (filters partial outings).
  // Magnitude: ±3 max (small factor, recent research suggests modest signal).
  // ============================================================
  let f_commandTrend = 0;
  const startsWithBB = gameLog.filter((g) => typeof g.walks === "number" && g.inningsPitched > 0);
  if (startsWithBB.length >= 5) {
    const last3 = startsWithBB.slice(-3);
    const l3Ip = last3.reduce((a, g) => a + g.inningsPitched, 0);
    if (l3Ip >= 10) {
      const l3Walks = last3.reduce((a, g) => a + (g.walks ?? 0), 0);
      const l3BBper9 = (l3Walks / l3Ip) * 9;
      const totalIp = startsWithBB.reduce((a, g) => a + g.inningsPitched, 0);
      const totalWalks = startsWithBB.reduce((a, g) => a + (g.walks ?? 0), 0);
      const seasonBBper9 = totalIp > 0 ? (totalWalks / totalIp) * 9 : 0;
      const delta = l3BBper9 - seasonBBper9;
      // Higher recent BB/9 = command DOWN = NEGATIVE for pitcher_K (over).
      if (delta >= 1.5)      f_commandTrend = -3;
      else if (delta >= 1.0) f_commandTrend = -2;
      else if (delta >= 0.5) f_commandTrend = -1;
      else if (delta <= -1.5) f_commandTrend = 3;
      else if (delta <= -1.0) f_commandTrend = 2;
      else if (delta <= -0.5) f_commandTrend = 1;
    }
  }
  f_commandTrend *= sideFlip;
  // D-733 — STATUS: FLAG (D-708 fire 17/50 = 34%; data gate startsWithBB≥5 AND l3Ip≥10 excludes early-season pitchers + |delta|<0.5 BB/9 neutral band catches consistent control pitchers; relaxing gate = §19.3 threshold change; CEO decision)
  const score_pitcher_command_trend = roundHalfAwayFromZero(f_commandTrend * W.pitcherCommandTrend);

  // ============================================================
  // D-349 / D-733 FACTOR — score_pitcher_velocity_level
  //
  // HONEST NAME (D-733): score_pitcher_velocity_level.
  // PERSISTED JSON KEY: score_pitcher_velocity_trend (kept for back-compat
  // with factor_scores_mv, optimize-weights-mlb, system-health monitor,
  // and historic pick_history.breakdown rows; a future migration will
  // align the persisted key — see docs/loop/architecture/d733_*.md).
  //
  // FORMULA: primary fastball avg velocity vs fixed league constant 94 mph.
  // This is a STATIC LEVEL signal (current velo vs constant), NOT a TREND
  // (today vs prior snapshot). D-708 evaluator confirmed: same velo + same
  // pick side always produces the same score. The original "_trend" suffix
  // was D-670 class fabrication — name promised temporal signal, formula
  // computes level. No temporal data is read.
  //
  // Higher velo → more swing-and-miss → +K signal. Bucket ±3, weight 1.0
  // default. Gate: non-null primary_fb_velo (cache miss → score 0).
  // ============================================================
  const LEAGUE_AVG_FB_VELO = 94.0;  // 2024 reference
  let f_velocity = 0;
  const primaryVelo = ctx.velocity?.primary_fb_velo ?? null;
  if (typeof primaryVelo === "number" && primaryVelo > 80) {
    const delta = primaryVelo - LEAGUE_AVG_FB_VELO;
    if (delta >= 3.0)      f_velocity = 3;   // 97+ mph FF — elite velo
    else if (delta >= 1.5) f_velocity = 1;
    else if (delta <= -3.0) f_velocity = -3; // <91 mph FF — finesse arm
    else if (delta <= -1.5) f_velocity = -1;
  }
  f_velocity *= sideFlip;
  // D-733 — honest variable name at the formula site
  const score_pitcher_velocity_level = roundHalfAwayFromZero(f_velocity * W.pitcherVelocityTrend);
  // D-733 — back-compat alias: persisted breakdown JSON key stays unchanged
  // so factor_scores_mv, optimizer (w_mlb_pitcher_velocity_trend column),
  // system-health monitor, and historic rows continue to work without churn.
  const score_pitcher_velocity_trend = score_pitcher_velocity_level;

  // ============================================================
  // D-354 FACTOR — score_lineup_k_composition
  // Position-weighted composite of opposing lineup's K rates. Distinct from
  // score_opposing_lineup_k which uses TEAM-aggregate K rate — this version
  // weights by lineup slot (top of order = more PAs = larger contribution to
  // total K count). League avg team K rate ~22.5%.
  // Gate: requires ≥6 of 9 lineup batters with season K-rate data.
  // Buckets:
  //   weighted - league_avg >= +0.035 → +6 (strikeout-heavy lineup)
  //   >= +0.020 → +3
  //   >= +0.010 → +1
  //   <= -0.010 → -1
  //   <= -0.020 → -3
  //   <= -0.035 → -6 (contact-heavy lineup, fewer K opportunities)
  // SideFlip applied.
  // ============================================================
  let f_lineupKComp = 0;
  const lkc = ctx.lineupKComposition ?? null;
  if (lkc && typeof lkc.weighted_k_rate === "number" && lkc.batters_with_data >= 6) {
    const diff = lkc.weighted_k_rate - LEAGUE_AVG_TEAM_K_RATE;
    if (diff >= 0.035)      f_lineupKComp = 6;
    else if (diff >= 0.020) f_lineupKComp = 3;
    else if (diff >= 0.010) f_lineupKComp = 1;
    else if (diff <= -0.035) f_lineupKComp = -6;
    else if (diff <= -0.020) f_lineupKComp = -3;
    else if (diff <= -0.010) f_lineupKComp = -1;
  }
  f_lineupKComp *= sideFlip;
  const score_lineup_k_composition = roundHalfAwayFromZero(f_lineupKComp * W.lineupKComposition);

  // ============================================================
  // D-596 / D-733 FACTOR — score_pitcher_arsenal_quality
  //
  // HONEST NAME (D-733): score_pitcher_arsenal_quality.
  // PERSISTED JSON KEY: score_pitch_type_matchup (kept for back-compat with
  // factor_scores_mv, optimize-weights-mlb (w_mlb_pitch_type_matchup column),
  // system-health monitor (path24h query), and historic pick_history rows;
  // a future coordinated migration will align the persisted key — see
  // docs/loop/architecture/d733_*.md).
  //
  // FORMULA: usage-weighted K-conversion across the PITCHER'S pitch arsenal
  // (cache_statcast_pitcher_arsenal, single-sided lookup at
  // process-games-mlb/index.ts:445 — pitcher_id only, no batter or lineup
  // input). The name "_matchup" was D-670 class fabrication: a true matchup
  // factor requires both sides (pitcher vs batter/lineup), but this one
  // only reads pitcher arsenal quality (expected_put_away + expected_whiff_pct).
  //
  // Uses expected_put_away (corr(this, K-line)=0.122 full / 0.334 conf>=70
  // per D-594 §C.1 / §D.1) with expected_whiff_pct as secondary signal.
  //
  // League-typical (from D-596 backfill §B.1 — n=299):
  //   expected_put_away: mean=19.37, sd=4.76, range ~6%-30%
  //   expected_whiff_pct: mean=24.43, sd=7.12, range ~6%-56%
  //
  // Bucket structure on expected_put_away (the strongest D-594 signal),
  // gated by expected_whiff_pct being meaningfully different from league.
  // Conservative seed weight (W.pitchTypeMatchup defaults to 1.0). Range
  // matches existing factor magnitudes (±5 typical, ±8 extreme).
  // Falls through to 0 when pitch arsenal cache miss (null context).
  // ============================================================
  let f_pitchTypeMatchup = 0;
  const ptm = ctx.pitchTypeMatchup ?? null;
  if (ptm && typeof ptm.expected_put_away === "number" && ptm.expected_put_away > 0) {
    const PA_MEAN = 19.37; const PA_SD = 4.76;
    const z = (ptm.expected_put_away - PA_MEAN) / PA_SD;
    if (z >= 1.5)       f_pitchTypeMatchup = 8;   // top ~7% of arsenals
    else if (z >= 0.75) f_pitchTypeMatchup = 5;   // ~upper quartile
    else if (z >= 0.25) f_pitchTypeMatchup = 2;
    else if (z <= -1.5) f_pitchTypeMatchup = -8;
    else if (z <= -0.75) f_pitchTypeMatchup = -5;
    else if (z <= -0.25) f_pitchTypeMatchup = -2;
  }
  f_pitchTypeMatchup *= sideFlip;
  // D-733 — honest variable name at the formula site
  const score_pitcher_arsenal_quality = roundHalfAwayFromZero(f_pitchTypeMatchup * (W.pitchTypeMatchup ?? 1.0));
  // D-733 — back-compat alias: persisted breakdown JSON key unchanged
  const score_pitch_type_matchup = score_pitcher_arsenal_quality;

  // ============================================================
  // D-666 FACTOR — score_pitcher_whiff_skill_v2
  // Standalone whiff% factor (the #1 K predictor per public research).
  // Distinct from score_pitch_type_matchup (which keys off expected_put_away,
  // a derived metric); this surfaces the raw whiff% signal as a co-equal
  // factor. Reads expected_whiff_pct from cache_statcast_pitcher_arsenal.
  // League avg ~26%; high-whiff (>33%) is elite K skill (Sandy Alcantara/
  // Skubal-class), low (<19%) is contact-prone.
  // Weight LITERAL 1.5 (Claude-set, awaits 2026-06-28 d664-weight-fit
  // optimizer extension to pitcher_k market).
  // ============================================================
  let f_whiffSkillV2 = 0;
  if (typeof arsenalWhiff === "number" && arsenalWhiff > 0) {
    const whiffDelta = arsenalWhiff - LEAGUE_AVG_WHIFF_PCT;
    if (whiffDelta >= 8)       f_whiffSkillV2 = 8;
    else if (whiffDelta >= 4)  f_whiffSkillV2 = 5;
    else if (whiffDelta >= 2)  f_whiffSkillV2 = 2;
    else if (whiffDelta <= -8) f_whiffSkillV2 = -8;
    else if (whiffDelta <= -4) f_whiffSkillV2 = -5;
    else if (whiffDelta <= -2) f_whiffSkillV2 = -2;
  }
  f_whiffSkillV2 *= sideFlip;
  const score_pitcher_whiff_skill_v2 = roundHalfAwayFromZero(f_whiffSkillV2 * 1.5);

  // ============================================================
  // D-695 — PILOT: WIN-PROBABILITY CONFIDENCE (pitcher_strikeouts only)
  // Pre-D-695: confidence = 50 + edge*6 + Σ(factors). Factor sum dominated
  // ~127× per D-690 (Σ ~+30-60 vs edge×6 ~±10 pts), producing 100/ELITE
  // on coin-flip projections. Per CEO §19.3 rebuild:
  //   1. Factors no longer add directly to confidence
  //   2. Factors instead nudge λ (the projected K mean)
  //   3. confidence = round(P(bet wins under Poisson(λ)) × 100)
  //
  // Factor → λ conversion: each factor pt = 0.5% λ adjustment. Clamped to
  // [0.65, 1.40] so even extreme factor sums (±60) can shift λ by ±30%
  // but no more. The sideFlip already encoded in each factor score is
  // undone here so the directional sign aligns with K-count direction
  // (positive = MORE Ks projected, negative = FEWER).
  // ============================================================
  const factorSum_d695_pre = (
    score_pitcher_k_rate + score_pitcher_form + score_opposing_lineup_k
    + score_handedness_matchup + score_pitch_count_trend + score_rest_pitcher
    + score_ballpark_factor + score_weather_wind + score_weather_temp
    + score_umpire_k_zone + score_pitcher_command_trend + score_pitcher_velocity_trend
    + score_lineup_k_composition + score_pitch_type_matchup
    + score_pitcher_whiff_skill_v2
  );
  // D-695 — coef 0.002 chosen via backtest (n=500 resolved pitcher_k): coef
  // sweep over {0, 0.001, 0.002, 0.003, 0.004, 0.005} → 0.002 minimized MAE
  // of (predicted% - actual%) at 17.1%. Higher coefs over-adjusted λ and
  // produced over-confident high-conf picks that didn't materialize.
  // Statcast factors fold in after the second factor block below; final
  // confidence written there.
  let lambdaMultiplier_d695 = clamp(1.0 + (factorSum_d695_pre * sideFlip) * getLambdaCoeff(), 0.65, 1.40);
  let lambdaAdjusted_d695 = projectedK * lambdaMultiplier_d695;
  let winProb_d695 = winProbPoissonK(lambdaAdjusted_d695, prop.line, prop.pickSide as "over"|"under");
  confidence = Math.round(winProb_d695 * 100);
  confidence = clamp(confidence, 0, 100);

  // D-406: track D-140 cap delta so we can reconstruct pre-cap at end of pipeline.
  // For pitcher_k, MORE factors (D-276+D-282+D-286 — xera, baa, framing, pitch_mix)
  // are added AFTER this cap (line ~655), so the pre-cap value must include them.
  // delta = amount the cap subtracted from confidence (0 if cap didn't fire).
  let d140_cap_delta = 0;

  // ============================================================
  // D-140 trivial-line cap — heavy juice on a tiny line shouldn't
  // earn an Elite read just from edge math. Mirrors NBA.
  // ============================================================
  if (prop.line <= 0.5 && Math.abs(prop.odds) >= 200 && confidence > 65) {
    d140_cap_delta = confidence - 65;
    confidence = 65;
  }

  // ============================================================
  // D-479 — longshot OVER trap structural cap.
  // Real-data finding (n=164): GOOD-tier (70-79 conf) OVER picks at
  // +100-or-longer odds run WR 34% vs BE 40% (EDGE -5.9%, ROI -17.1%).
  // The conf formula doesn't penalize the longshot base rate — factor
  // scores pump conf to 70+ tier on picks where the LINE is positioned
  // at the longshot-end of OVER distribution. Cap to 65 (drops to
  // LEAN tier so picks stop surfacing as high-conf buys).
  // Layers WITH D-140 + D-467 (independent gates). Scope: GOOD tier
  // only per §2 NEGATIVE SCOPE. ELITE/STRONG at +100+ also bleed but
  // scoped for separate batch (D-480 candidate).
  // ============================================================
  if (prop.pickSide === "over" && prop.odds >= 100
      && confidence >= 70 && confidence <= 79) {
    confidence = 65;
  }

  // ============================================================
  // D-509 — ELITE/STRONG longshot OVER cap (sibling of D-479).
  // D-505 (post-D-506 backfill) data: conf>=80 OVER at +150+ runs
  // WR 23.36% ROI ~-34% on MLB n=107 (and game_total OVER any odds
  // bleeds at -56u on n=64). D-479 covered GOOD tier only; D-509
  // extends the structural cap to the ELITE/STRONG premium tiers.
  // pitcher_k (this scorer) IS in the bleed cluster — no carve-out.
  // Cap to 75 (drops below ELITE/STRONG bar, stays within GOOD so
  // picks may still be surfaced if Sonnet narrative confirms).
  // ============================================================
  if (prop.pickSide === "over" && confidence >= 80 && prop.odds >= 150) {
    confidence = 75;
  }

  // ============================================================
  // Sanity flags (NBA parity)
  // ============================================================
  let unbettableJuiceFlag = false;
  if (prop.pickSide === "under") {
    if (confidence >= 90 && prop.odds <= -350)      unbettableJuiceFlag = true;
    else if (confidence >= 80 && prop.odds <= -300) unbettableJuiceFlag = true;
    else if (confidence >= 70 && prop.odds <= -250) unbettableJuiceFlag = true;
    else if (confidence >= 60 && prop.odds <= -200) unbettableJuiceFlag = true;
  }

  // Coin-flip: Elite/Strong score but recent form ambiguous.
  // For pitchers we use last5 hit-rate-equivalent: how often did
  // last5 starts clear the prop line in pickSide direction?
  // D-229 Fix 3 — compute last10 + season hit rates for PickCard display.
  function hitRateOver(window: PitcherGameLogEntry[]): number {
    if (window.length === 0) return 0;
    const hits = window.filter((g) =>
      prop.pickSide === "over" ? g.strikeOuts > prop.line : g.strikeOuts < prop.line,
    ).length;
    return (hits / window.length) * 100;
  }
  const last5HitRate = hitRateOver(last5);
  const last10 = gameLog.slice(-10);
  const last10HitRate = hitRateOver(last10);
  const seasonHitRate = hitRateOver(gameLog);
  const coinFlipFlag = confidence >= 80 && last5HitRate >= 40 && last5HitRate <= 60;

  // Negative-factor stacking
  const factorArr = [
    score_pitcher_k_rate, score_pitcher_form, score_opposing_lineup_k,
    score_handedness_matchup, score_pitch_count_trend, score_rest_pitcher,
    score_ballpark_factor, score_weather_wind, score_weather_temp,
    score_umpire_k_zone,
    // D-348
    score_pitcher_command_trend,
    // D-349
    score_pitcher_velocity_trend,
    // D-354
    score_lineup_k_composition,
    // D-596 — pitch-type matchup factor
    score_pitch_type_matchup,
  ];
  const negativeFactorCount = factorArr.filter((v) => v < 0).length;
  const negativeStackingFlag = confidence >= 80 && negativeFactorCount >= 3;

  // ============================================================
  // D-276 / D-733 FACTOR — score_pitcher_xera_bucket
  //
  // HONEST NAME (D-733): score_pitcher_xera_bucket.
  // PERSISTED JSON KEY: score_pitcher_xera_edge (kept for back-compat with
  // factor_scores_mv, optimize-weights-mlb (w_mlb_pitcher_xera_edge column),
  // and historic pick_history.breakdown rows; a future coordinated migration
  // will align the persisted key — see docs/loop/architecture/d733_*.md).
  //
  // FORMULA: pitcher's xERA bucketed into 6 tiers (raw quality buckets).
  // NOT a delta or "edge" computation — no reference quantity is subtracted.
  // The name "_edge" was D-670 class fabrication: it implies a delta vs some
  // baseline (e.g., xERA vs season ERA), but the formula is a direct raw
  // bucket on xERA value alone.
  //
  // Lower xERA = better K-suppressing pitcher (more swing-and-miss profile),
  // higher xERA = worse. Bucket ±10/6/3/0/-3/-8, weight W.pitcherXeraEdge
  // (DB-tunable via w_mlb_pitcher_xera_edge column). Falls through to 0
  // when ctx.statcast.xera is null.
  //
  // D-278 BAA factor (below) is a separate raw-quality bucket — same shape.
  // ============================================================
  let f_pitcherXeraEdge = 0;
  const xera = ctx.statcast?.xera ?? null;
  if (xera !== null) {
    if (xera < 3.0)      f_pitcherXeraEdge = 10;
    else if (xera < 3.5) f_pitcherXeraEdge = 6;
    else if (xera < 4.0) f_pitcherXeraEdge = 3;
    else if (xera < 4.5) f_pitcherXeraEdge = 0;
    else if (xera < 5.0) f_pitcherXeraEdge = -3;
    else                 f_pitcherXeraEdge = -8;
  }
  f_pitcherXeraEdge *= sideFlip;
  // D-733 — honest variable name at the formula site
  const score_pitcher_xera_bucket = roundHalfAwayFromZero(f_pitcherXeraEdge * W.pitcherXeraEdge); // D-362 — DB-tunable via w_mlb_pitcher_xera_edge
  // D-733 — back-compat alias: persisted breakdown JSON key unchanged
  const score_pitcher_xera_edge = score_pitcher_xera_bucket;

  // D-278 Factor: pitcher_baa — BAA-allowed proxied by est_ba. Lower
  // BAA = harder to hit = K friendly. League avg ~0.245.
  let f_pitcherBaa = 0;
  const pitcher_baa = ctx.statcast?.est_ba ?? null;
  if (pitcher_baa !== null) {
    if (pitcher_baa <= 0.210)      f_pitcherBaa = 6;
    else if (pitcher_baa <= 0.230) f_pitcherBaa = 3;
    else if (pitcher_baa <= 0.250) f_pitcherBaa = 1;
    else if (pitcher_baa >= 0.290) f_pitcherBaa = -6;
    else if (pitcher_baa >= 0.270) f_pitcherBaa = -3;
  }
  f_pitcherBaa *= sideFlip;
  const score_pitcher_baa = roundHalfAwayFromZero(f_pitcherBaa * W.pitcherBaa); // D-362 — DB-tunable via w_mlb_pitcher_baa

  const verdict = getScoreLabel(confidence);
  const confidence_pre_tier_aware = confidence;  // v1: no tier-aware pass for MLB

  // ============================================================
  // D-282/D-283 — catcher_framing_factor (per-catcher distribution)
  // Today's starting catcher's framing run-value (Baseball Savant Cat
  // variant). Centered ~0 across 58 MLB catchers; range roughly
  // [-4.5, +4.1] for catchers with ≥500 pitches. Above-zero catcher
  // generates extra called strikes → pitcher K boost. Below-zero
  // costs strikes. Bucket-based ±6, retuned for per-catcher range.
  // Weight: w_mlb_catcher_framing.
  // ============================================================
  let f_catcherFraming = 0;
  const cf = ctx.catcherFraming ?? null;
  if (cf && cf.rv_tot !== null && (cf.pitches ?? 0) >= 500) {
    const rv = cf.rv_tot;
    if (rv >= 3.0)        f_catcherFraming = 6;
    else if (rv >= 1.5)   f_catcherFraming = 3;
    else if (rv >= 0.5)   f_catcherFraming = 1;
    else if (rv <= -3.0)  f_catcherFraming = -6;
    else if (rv <= -1.5)  f_catcherFraming = -3;
    else if (rv <= -0.5)  f_catcherFraming = -1;
  }
  f_catcherFraming *= sideFlip;
  const score_catcher_framing = roundHalfAwayFromZero(f_catcherFraming * W.catcherFraming); // D-362 — DB-tunable via w_mlb_catcher_framing

  // ============================================================
  // D-286 SHIP 2 — pitcher_pitch_mix_k factor
  // Breaking-ball usage (SL + CU + FC + ST + SV) drives strikeout
  // generation. League avg ~30%; high-breaking pitchers (>40%)
  // generate 2-3 more K's per start. Gated total_pitches ≥ 300
  // (Savant only reports pitches with meaningful sample so missing
  // pitch types degrade gracefully). Buckets ±6 around league avg.
  // Weight: w_mlb_pitcher_pitch_mix_k.
  // ============================================================
  let f_pitchMix = 0;
  const ars = ctx.arsenal ?? null;
  if (ars && ars.breaking_ball_pct !== null && (ars.total_pitches ?? 0) >= 300) {
    const bb = ars.breaking_ball_pct;
    if (bb >= 50)       f_pitchMix = 6;
    else if (bb >= 40)  f_pitchMix = 3;
    else if (bb >= 35)  f_pitchMix = 1;
    else if (bb <= 15)  f_pitchMix = -6;
    else if (bb <= 20)  f_pitchMix = -3;
    else if (bb <= 25)  f_pitchMix = -1;
  }
  f_pitchMix *= sideFlip;
  const score_pitcher_pitch_mix_k = roundHalfAwayFromZero(f_pitchMix * W.pitcherPitchMixK);  // D-362 — DB-tunable via w_mlb_pitcher_pitch_mix_k

  // ============================================================
  // D-749 FACTOR — score_pitcher_csw
  //
  // CSW% = (called_strike + swinging_strike) / total_pitches. The #1 K
  // predictor per public research (FanGraphs / Baseball Prospectus).
  //
  // D-749 backfill distribution (n=488 active pitchers, 2026 season):
  //   p10 = 23.5% / p50 = 26.5% / p90 = 30.2% / mean = 26.7%
  //   Elite leaderboard: Mason Miller 38.3% / Misiorowski 34.9%
  //
  // Buckets center on LEAGUE_AVG_CSW_PCT (~27%). Asymmetric range — top
  // tier ≥35% is rare (top ~2%) so reward generously; bottom ≤22% is
  // also rare so penalize. Mid-band 26-28% returns 0 (no signal).
  //
  // DISTINCT FROM whiff_skill_v2 (D-666): that factor reads
  // expected_whiff_pct (modeled), which has been NULL across cache → 0%
  // fire rate per D-748 audit. CSW reads RAW observed totals → fires on
  // every pitcher in the cache. CSW also includes CALLED-STRIKE skill
  // (zone control, framing-leverage) which whiff% misses entirely.
  //
  // Gated total_pitches_csw ≥100 to avoid extreme single-game CSW for
  // bullpen spot starters with <2 IP of sample.
  // ============================================================
  const LEAGUE_AVG_CSW_PCT = 27.0;
  let f_csw = 0;
  const arsenalForCsw = ctx.arsenal ?? null;
  const cswPct = (arsenalForCsw && typeof arsenalForCsw.csw_pct === "number") ? arsenalForCsw.csw_pct : null;
  // Stable-sample gate. CSW backfill stores its own denominator
  // (total_pitches_csw — sum of pitches in the leaderboard CSV) which is
  // independent of arsenal's total_pitches (sometimes NULL on rows that
  // skipped the arsenal columns). Floor 100 keeps single-relief outings out.
  const cswSampleSize = (arsenalForCsw && typeof arsenalForCsw.total_pitches_csw === "number")
    ? arsenalForCsw.total_pitches_csw
    : (arsenalForCsw?.total_pitches ?? 0);
  if (cswPct !== null && cswSampleSize >= 100) {
    const delta = cswPct - LEAGUE_AVG_CSW_PCT;
    if      (delta >= 8.0)  f_csw = 10;   // ≥35% — elite, top ~2% (Mason Miller class)
    else if (delta >= 5.0)  f_csw = 6;    // ≥32% — well above avg
    else if (delta >= 3.0)  f_csw = 3;    // ≥30% — above avg, p90+ territory
    else if (delta >= 1.0)  f_csw = 1;    // 28-30% — modest tilt
    else if (delta <= -8.0) f_csw = -10;  // ≤19% — extreme low (rare)
    else if (delta <= -5.0) f_csw = -6;   // ≤22% — bottom tier
    else if (delta <= -3.0) f_csw = -3;   // ≤24% — below avg
    else if (delta <= -1.0) f_csw = -1;   // 25-26% — modest below
    // else 26-28% → 0 (no signal at median band)
  }
  f_csw *= sideFlip;
  const score_pitcher_csw = roundHalfAwayFromZero(f_csw * W.pitcherCsw);

  // D-695 — Statcast/arsenal factors ALSO feed λ (not confidence). Recompute
  // λ + winProb with the full factor stack (pre-block + Statcast block).
  const factorSum_d695_statcast = (
    score_pitcher_xera_edge + score_pitcher_baa + score_catcher_framing + score_pitcher_pitch_mix_k
    + score_pitcher_csw  // D-749
  );
  const factorSum_d695_total = factorSum_d695_pre + factorSum_d695_statcast;
  lambdaMultiplier_d695 = clamp(1.0 + (factorSum_d695_total * sideFlip) * getLambdaCoeff(), 0.65, 1.40);
  lambdaAdjusted_d695 = projectedK * lambdaMultiplier_d695;
  winProb_d695 = winProbPoissonK(lambdaAdjusted_d695, prop.line, prop.pickSide as "over"|"under");
  // Raw win-prob confidence (before shrinkage).
  const confidence_raw_d695 = clamp(Math.round(winProb_d695 * 100), 0, 100);

  // D-744 STEP 2 — D-743 isotonic calibration REPLACES D-695 SHIP 4 shrinkage.
  //
  // The prior shrinkage (raw → 60 + (raw-60)*0.4) was a hand-tuned band-aid
  // calibration. D-743 produced the data-derived empirical replacement: a
  // PAV-fit monotonic curve mapping raw D-695 winProb×100 to the actually-
  // observed P(hit) at that score level on n=663 train picks. Per D-743
  // evaluator (PASS 8/8, bit-for-bit reproduction), the curve is correct
  // and out-of-sample-validated.
  //
  // Side-effect: confidence > 71 is now structurally impossible (empirical
  // ceiling 71.4%). The D-509 cap at 75 for OVER+conf≥80+odds≥150 is now
  // unreachable (curve never produces 80) — left in place as defense-in-
  // depth in case the curve is later widened.
  confidence = applyD743IsotonicCalibrationPitcherK(confidence_raw_d695);
  confidence = clamp(confidence, 0, 100);

  // D-695 — D-467 edge-sign floor is OBSOLETE under win-prob: a negative-edge
  // pick naturally has winProb < 0.5 → conf < 50 < 69, so the floor never
  // fires on a properly-calibrated win-prob output. Removed for the pilot.
  // If a divergence appears in backtest, can be reinstated.
  const d467_edge_floor_delta = 0;

  // D-406: reconstruct pre-cap confidence by adding back the D-140 cap delta.
  // delta is 0 if cap didn't fire (so pre_cap == confidence); else pre_cap is
  // what confidence WOULD be without the cap firing. Clamped to [0,100].
  // D-467: pre_cap reflects post-edge-floor value; the d467_edge_floor_delta
  // is tracked separately above. Pre_cap still means "before D-140 trivial cap".
  const confidence_pre_cap = clamp(Math.round(confidence + d140_cap_delta), 0, 100);

  const breakdown: Record<string, number | string | null | boolean> = {
    season_k_per_start: Math.round(seasonAvgPerStart * 100) / 100,
    season_k_per_nine: Math.round(season.kPerNine * 100) / 100,
    season_games_played: season.gamesPlayed,
    season_ip: Math.round(season.inningsPitched * 10) / 10,
    last5_k_avg: Math.round(recentAvg * 100) / 100,
    last5_games: last5.length,
    last5_hit_rate_pct: Math.round(last5HitRate),
    last10_hit_rate_pct: Math.round(last10HitRate),
    season_hit_rate_pct: Math.round(seasonHitRate),
    blended_projection: Math.round(blended * 100) / 100,
    opp_k_rate_pct: opposingHitting ? Math.round(oppKRate * 1000) / 10 : 0,
    opp_adjustment_mult: Math.round(oppAdjustment * 1000) / 1000,
    park_k_factor: ballpark ? Math.round(ballpark.kFactor * 1000) / 1000 : 1.000,
    weather_temp_f: weather?.tempF ?? null,
    weather_wind_mph: weather?.windSpeed ?? null,
    umpire_k_zone_idx: umpire?.kZoneSizeIndex ?? null,
    projected_k: Math.round(projectedK * 100) / 100,
    raw_edge: Math.round(edge * 100) / 100,
    score_pitcher_k_rate, score_pitcher_form, score_opposing_lineup_k,
    score_handedness_matchup, score_pitch_count_trend, score_rest_pitcher,
    score_ballpark_factor, score_weather_wind, score_weather_temp,
    score_umpire_k_zone,
    // D-348 — pitcher's recent command (BB/9) vs season
    score_pitcher_command_trend,
    // D-349 — primary fastball velocity vs league avg
    score_pitcher_velocity_trend,
    primary_fb_velo: primaryVelo,
    // D-354 — position-weighted opposing lineup K rate composite
    score_lineup_k_composition,
    lineup_k_weighted_rate: lkc?.weighted_k_rate ?? null,
    lineup_k_batters_with_data: lkc?.batters_with_data ?? null,
    // D-596 — pitch-type matchup factor + raw aggregates for audit.
    // expected_put_away is the strongest residual signal per D-594 §C.1.
    score_pitch_type_matchup,
    pitchtype_expected_whiff_pct: ptm?.expected_whiff_pct ?? null,
    pitchtype_expected_k_pct:     ptm?.expected_k_pct ?? null,
    pitchtype_expected_put_away:  ptm?.expected_put_away ?? null,
    // D-276-FACTORS new factor (Statcast-derived)
    score_pitcher_xera_edge,
    statcast_xera: xera,
    // D-278-FACTORS additional
    score_pitcher_baa,
    statcast_pitcher_baa: pitcher_baa,
    // D-282 SHIP 2 — catcher framing
    score_catcher_framing,
    catcher_framing_rv_tot: cf?.rv_tot ?? null,
    catcher_framing_pitches: cf?.pitches ?? null,
    // D-286 SHIP 2 — pitcher arsenal
    score_pitcher_pitch_mix_k,
    arsenal_breaking_ball_pct: ars?.breaking_ball_pct ?? null,
    arsenal_offspeed_pct: ars?.offspeed_pct ?? null,
    arsenal_total_pitches: ars?.total_pitches ?? null,
    // D-749 — CSW% factor (Called Strike + Whiff). Single most predictive K
    // metric per public research. Backfill mean 26.7%, elite 35%+.
    score_pitcher_csw,
    arsenal_csw_pct: cswPct,
    // D-666 — projection inputs (skill + expected volume) + new whiff factor
    season_k_per_bf: Math.round(seasonKperBF * 10000) / 10000,
    season_bf_per_ip: Math.round(seasonBFperIP * 100) / 100,
    season_ip_per_start: Math.round(seasonIPperStart * 100) / 100,
    last5_ip_per_start: Math.round(last5IPperStart * 100) / 100,
    expected_ip: Math.round(expectedIP * 100) / 100,
    expected_bf: Math.round(expectedBF * 10) / 10,
    projected_k_skill: Math.round(projectedK_skill * 100) / 100,
    whiff_multiplier: Math.round(whiffMult * 1000) / 1000,
    score_pitcher_whiff_skill_v2,
    d666_wired: true,
    pick_side: prop.pickSide,
    pitcher_throws: season.throws ?? "unknown",
    v1_algo: "D-666: skill-based projection (K/BF × expected_BF × whiff_mult) + 10-factor v1 + Statcast 4-factor + whiff_skill_v2 (15 total)",
    // D-695 — win-probability audit fields (PILOT, pitcher_strikeouts only)
    d695_wired: true,
    d695_algo: "D-695: win-prob from Poisson(λ_adjusted) tail at line + shrinkage above 60% (calibration). Factors nudge λ at coef=0.002 (±15% clamp at ±60 factor pts). No longer add to confidence directly.",
    d695_lambda_base: Math.round(projectedK * 1000) / 1000,
    d695_lambda_multiplier: Math.round(lambdaMultiplier_d695 * 1000) / 1000,
    d695_lambda_adjusted: Math.round(lambdaAdjusted_d695 * 1000) / 1000,
    d695_factor_sum_total: factorSum_d695_total,
    d695_win_prob: Math.round(winProb_d695 * 10000) / 10000,
    d695_confidence_raw: confidence_raw_d695,
    d695_implied_prob_book: Math.round(impliedProbAmerican(prop.odds) * 10000) / 10000,
    d695_edge_vs_implied: Math.round((winProb_d695 - impliedProbAmerican(prop.odds)) * 10000) / 10000,
  };

  return {
    confidence,
    confidence_pre_cap,
    confidence_pre_tier_aware,
    verdict,
    projectedK: Math.round(projectedK * 100) / 100,
    seasonAvg: Math.round(seasonAvgPerStart * 100) / 100,
    recentAvg: Math.round(recentAvg * 100) / 100,
    edge: Math.round(edge * 100) / 100,
    score_pitcher_k_rate, score_pitcher_form, score_opposing_lineup_k,
    score_handedness_matchup, score_pitch_count_trend, score_rest_pitcher,
    score_ballpark_factor, score_weather_wind, score_weather_temp,
    score_umpire_k_zone,
    score_pitcher_command_trend,
    score_pitcher_velocity_trend,
    score_lineup_k_composition,
    score_pitch_type_matchup,  // D-596
    score_pitcher_whiff_skill_v2,  // D-666
    score_pitcher_csw,  // D-749
    unbettableJuiceFlag, coinFlipFlag, negativeStackingFlag, negativeFactorCount,
    winProb: winProb_d695,
    ...computeEvFromWinProb(winProb_d695, prop.odds),
    unbettableOverBreakevenFlag: prop.pickSide === "over"
      ? winProb_d695 * 100 <= impliedProbAmerican(prop.odds) * 100
      : false,
    breakdown,
  };
}

// =====================================================================
// D-476 — scorePitcherOuts (Market 3 of D-468 SHIP 4 queue).
//
// Projects per-game pitcher outs recorded (typical line 14.5/15.5/16.5/17.5
// — that's 4.83/5.17/5.5/5.83 IP). Most outs are NOT Ks, so this is its
// own projection chain — do NOT reuse pitcher_k's K-density direction.
//
// REUSED inputs (6 — share PitcherKScoringContext with scorePitcherStrikeouts):
//   - pitcher form (recent ERA z-score)
//   - pitch count trend
//   - opposing lineup quality (K rate as proxy for at-bat duration)
//   - ballpark runs factor (high-run park → starter pulled early)
//   - weather temperature (hot weather → pitcher fatigue)
//   - season rest pattern (pitchesPerStart as proxy)
//
// NEW factors (2):
//   - score_pitcher_avg_ip (NEW): season IP/start z-score vs league avg
//     (~5.3 IP). PRIMARY signal — "how deep does this pitcher typically go".
//   - score_manager_pull_proxy (NEW, B+ APPROXIMATION, conservative w=0.5):
//     Composite from real data that ROUGHLY tracks pull tendency:
//       (a) recent pitch counts trending DOWN (manager pulling earlier)
//       (b) recent walks/start UP (wild → early hook)
//       (c) recent IP variance (volatile = unpredictable pull)
//     ⚠️ NOT real manager-pull data. Real pull-tendency would require
//     play-by-play / team-level relief-usage feeds. This factor is a
//     proxy and is intentionally weighted CONSERVATIVELY (0.5×) so it
//     cannot dominate. Upgrade path: source real pull data later.
//
// Output mirrors PitcherKScoringResult shape: K-specific score fields
// zeroed (or repurposed where semantics align — score_pitcher_form for
// pitcher recency, score_opposing_lineup_k for opp difficulty); outs-
// specific scores live in `breakdown` for audit/UI.
// D-467 edge-sign floor applied. D-140 trivial-line cap applied.
// =====================================================================
export function scorePitcherOuts(ctx: PitcherKScoringContext): PitcherKScoringResult {
  const { season, gameLog, opposingHitting, ballpark, weather, prop, pitcher } = ctx;
  const sideFlip = prop.pickSide === "under" ? -1 : 1;
  const last5 = gameLog.slice(-5);

  // ====================================================================
  // D-668 — Projection rebuilt on DURABILITY + game-script (research-confirmed
  // outs is a pitch-burden market, NOT a pitcher-skill market). Shares the
  // D-666 expected-IP helper so pitcher_k + pitcher_outs cannot drift.
  // Then adjusts for: opponent pitch-burden (patient lineup → fewer innings),
  // game-script blowout risk (talent gap → pulled early), and park.
  // ====================================================================
  const { expectedIP: baseExpectedIP, seasonIPperStart, last5IPperStart } =
    computeExpectedIP(season, gameLog);

  // Opp pitch-burden adjustment: high-OBP + high-pitches/PA lineup grinds
  // out at-bats → fewer SP innings. Combined with the existing oppKRate
  // (high-K = QUICK outs = MORE innings).
  const oppKRate = opposingHitting?.kRate ?? LEAGUE_AVG_TEAM_K_RATE;
  // Tighter clamp than pitcher_k: oppK affects pace, not skill ceiling.
  const oppKAdj = clamp(oppKRate / LEAGUE_AVG_TEAM_K_RATE, 0.92, 1.10);
  // Opp patience drag: above-league pitches/PA → grinding lineup → SHORTER outing.
  // League avg pitches/PA ~3.90. Each 0.10 above → ~1% IP reduction.
  const oppPPA = opposingHitting?.pitchesPerPA ?? null;
  const LEAGUE_PPA = 3.90;
  const oppPaceAdj = (oppPPA !== null)
    ? clamp(LEAGUE_PPA / oppPPA, 0.92, 1.08)
    : 1.0;

  // Park: high-run park → starter pulled earlier (inverse runs factor).
  const parkAdj = ballpark ? clamp(1.0 / ballpark.runsFactor, 0.88, 1.12) : 1.0;

  // GAME-SCRIPT blowout-risk adjustment: when own team RPG significantly
  // OUTPACES opp RPG, our SP often gets pulled in a blowout WIN to save
  // arms (early hook). When own team is much WORSE than opp, SP can get
  // blown off the mound. Symmetric drag.
  const ownRPG = ctx.ownTeamRunsPerGame ?? null;
  const oppRPG = ctx.oppRunsPerGame ?? null;
  let scriptAdj = 1.0;
  if (ownRPG !== null && oppRPG !== null && ownRPG > 0 && oppRPG > 0) {
    const rpgGap = Math.abs(ownRPG - oppRPG);
    // Each full RPG of imbalance trims ~3% expected IP. Cap at -10%.
    scriptAdj = clamp(1.0 - rpgGap * 0.03, 0.90, 1.0);
  }

  const projectedIp = baseExpectedIP * oppKAdj * oppPaceAdj * parkAdj * scriptAdj;
  const projectedStat = projectedIp * 3.0;            // outs = IP × 3
  const edge = (projectedStat - prop.line) * sideFlip;

  // ---- base confidence: 50 + 3× edge (1 IP ≈ 3 outs scale)
  let confidence = 50 + edge * 3;

  // ====================================================================
  // D-668 — 13 wired factors + 4 queued infra-followups.
  // All wired weights LITERAL (Claude-set; pitcher_k optimizer extension
  // on 2026-06-28 d664-weight-fit-weekly will fit these).
  // ====================================================================

  // ===== DURABILITY (6 wired; 1 queued) ===============================

  // (D1) score_pitcher_avg_ip — season IP/start z vs league avg 5.3 (σ 0.7).
  // Primary depth signal. Same as pre-D-668; weight LITERAL 1.5.
  let f_avgIp = 0;
  const leagueAvgIpPerStart = 5.3;
  const sigmaIpPerStart = 0.7;
  if (seasonIPperStart > 0 && season.gamesPlayed >= 5) {
    const z = (seasonIPperStart - leagueAvgIpPerStart) / sigmaIpPerStart;
    if (z >= 1.5)      f_avgIp = 10;
    else if (z >= 1.0) f_avgIp = 6;
    else if (z >= 0.5) f_avgIp = 3;
    else if (z <= -1.5) f_avgIp = -10;
    else if (z <= -1.0) f_avgIp = -6;
    else if (z <= -0.5) f_avgIp = -3;
  }
  f_avgIp *= sideFlip;
  const score_pitcher_avg_ip = roundHalfAwayFromZero(f_avgIp * W.outsPitcherAvgIp);

  // (D2) score_pitcher_recent_ip_trend — last5 IP/start vs season IP/start.
  // Hot recent trend → manager trusts SP to go deep this outing.
  let f_recentIpTrend = 0;
  if (last5IPperStart > 0 && seasonIPperStart > 0 && last5.length >= 3) {
    const delta = last5IPperStart - seasonIPperStart;
    if (delta >= 0.75)      f_recentIpTrend = 5;
    else if (delta >= 0.35) f_recentIpTrend = 2;
    else if (delta <= -0.75) f_recentIpTrend = -5;
    else if (delta <= -0.35) f_recentIpTrend = -2;
  }
  f_recentIpTrend *= sideFlip;
  const score_pitcher_recent_ip_trend = roundHalfAwayFromZero(f_recentIpTrend * W.outsPitcherRecentIpTrend);

  // (D3) score_pitcher_volatility_v2 — HONESTLY RELABELED per D-671 SHIP 2.
  // Pre-D-671: this factor was named `score_manager_pull_v2` and CLAIMED to
  // measure manager pull tendency. Per D-670: the sub-inputs measure PITCHER
  // behavior (recent pitch-count deviation, recent walks/start, recent IP
  // variance), NOT manager behavior. The composite IS a real pitcher-
  // consistency signal — just misnamed. D-671 SHIP 2 renames to reflect what
  // it actually measures. The TRUE manager-pull factor stays queued under
  // D-668-FOLLOWUP-PULL-FEED (real play-by-play / relief-usage feed, ~3-day
  // build) — distinct from this volatility signal.
  //
  // Sub-signals (all real from gameLog):
  //   (a) recent pitchCount delta vs season pitchesPerStart
  //   (b) recent walks/start (high → wild → shorter outings)
  //   (c) recent IP variance (high → unpredictable durability)
  // Direction: HIGH volatility → SHORTER expected outing → -bucket for OVER.
  let f_volatilityV2 = 0;
  const volatilityComponents: Record<string, number | null> = {
    recent_pitch_count_delta: null,
    recent_walk_rate: null,
    recent_ip_variance: null,
  };
  if (last5.length >= 3) {
    const recentPC = last5.filter((g) => g.pitchCount !== null).map((g) => g.pitchCount as number);
    if (recentPC.length >= 3 && season.pitchesPerStart !== null && season.pitchesPerStart > 0) {
      const recentAvgPC = recentPC.reduce((a, n) => a + n, 0) / recentPC.length;
      const delta = recentAvgPC - season.pitchesPerStart;
      volatilityComponents.recent_pitch_count_delta = Math.round(delta);
      if (delta <= -10) f_volatilityV2 -= 3;
      else if (delta <= -5) f_volatilityV2 -= 2;
      else if (delta <= -2) f_volatilityV2 -= 1;
      else if (delta >= 5) f_volatilityV2 += 2;
      else if (delta >= 2) f_volatilityV2 += 1;
    }
    const recentBB = last5.filter((g) => g.walks !== null).map((g) => g.walks as number);
    if (recentBB.length >= 3) {
      const recentAvgBB = recentBB.reduce((a, n) => a + n, 0) / recentBB.length;
      volatilityComponents.recent_walk_rate = Math.round(recentAvgBB * 10) / 10;
      if (recentAvgBB >= 3.5) f_volatilityV2 -= 2;
      else if (recentAvgBB >= 2.5) f_volatilityV2 -= 1;
      else if (recentAvgBB <= 1.0) f_volatilityV2 += 2;
      else if (recentAvgBB <= 1.8) f_volatilityV2 += 1;
    }
    const recentIp = last5.map((g) => g.inningsPitched);
    if (recentIp.length >= 3) {
      const avg = recentIp.reduce((a, n) => a + n, 0) / recentIp.length;
      const variance = recentIp.reduce((a, n) => a + (n - avg) ** 2, 0) / recentIp.length;
      volatilityComponents.recent_ip_variance = Math.round(variance * 100) / 100;
      if (variance >= 3.0) f_volatilityV2 -= 1;
      else if (variance <= 0.5) f_volatilityV2 += 1;
    }
  }
  f_volatilityV2 = clamp(f_volatilityV2, -6, 6);
  f_volatilityV2 *= sideFlip;
  // Weight unchanged (0.75) — sub-signals + bucket logic + clamp identical;
  // only the LABEL changed. The TRUE manager-pull signal stays queued under
  // D-668-FOLLOWUP-PULL-FEED.
  const score_pitcher_volatility_v2 = roundHalfAwayFromZero(f_volatilityV2 * W.outsPitcherVolatilityV2);

  // (D4) score_rest_pitcher — days since last start.
  // 5-day = norm, 6+ = extra rest (mild + for depth), 4 = short.
  let f_rest = 0;
  if (gameLog.length > 0 && gameLog[gameLog.length - 1].date) {
    const lastDate = new Date(gameLog[gameLog.length - 1].date);
    const gameDate = new Date(pitcher.gameTime || new Date());
    const days = Math.floor((gameDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
    if (days >= 7)       f_rest = -2;   // rust risk
    else if (days === 6) f_rest = 1;
    else if (days === 5) f_rest = 0;
    else if (days === 4) f_rest = -1;
    else if (days <= 3 && days > 0) f_rest = -3;
  }
  f_rest *= sideFlip;
  const score_rest_pitcher = roundHalfAwayFromZero(f_rest * W.outsRestPitcher);

  // (D5) score_pitcher_walk_efficiency — season BB/9 (REAL).
  // D-671 SHIP 1 fix — replaced D-670 fake formula (`BF − K − IP × 3` which
  // computed roughly WHIP × 9, NOT BB/9, and sign-inverted on high-K SPs).
  // Now uses real `season.baseOnBalls` extracted from the SAME MLB Stats API
  // season response body fetchPitcherSeason already parses.
  // Direction: LOW BB/9 = clean control = goes deeper = MORE outs → +bucket
  // for OVER. HIGH BB/9 = wild = hooked early = FEWER outs → -bucket.
  let f_walkEff = 0;
  let real_bb_per_9: number | null = null;
  if (season.inningsPitched >= 20 && season.baseOnBalls >= 0) {
    real_bb_per_9 = (season.baseOnBalls * 9) / season.inningsPitched;
    if (real_bb_per_9 <= 1.5)      f_walkEff = 3;   // elite control
    else if (real_bb_per_9 <= 2.5) f_walkEff = 1;
    else if (real_bb_per_9 >= 5.0) f_walkEff = -3;  // very wild
    else if (real_bb_per_9 >= 3.5) f_walkEff = -1;
  }
  f_walkEff *= sideFlip;
  const score_pitcher_walk_efficiency = roundHalfAwayFromZero(f_walkEff * W.outsPitcherWalkEfficiency);

  // (D6) score_pitcher_recent_pitch_count — last5 avg pitch count.
  // Trusted-to-go-deep signal (separate from manager_pull's delta signal).
  let f_recentPC = 0;
  const recentPCFull = last5.filter((g) => g.pitchCount !== null).map((g) => g.pitchCount as number);
  if (recentPCFull.length >= 3) {
    const avgPC = recentPCFull.reduce((a, n) => a + n, 0) / recentPCFull.length;
    if (avgPC >= 100) f_recentPC = 4;
    else if (avgPC >= 92) f_recentPC = 2;
    else if (avgPC <= 70) f_recentPC = -4;
    else if (avgPC <= 80) f_recentPC = -2;
  }
  f_recentPC *= sideFlip;
  const score_pitcher_recent_pitch_count = roundHalfAwayFromZero(f_recentPC * W.outsPitcherRecentPitchCount);

  // (D7) D-669 SHIP 1 — score_first_inning_trouble_v2.
  // First-inning ERA from cache_mlb_pitcher_inn1 (sitCodes=i01). Labors-early
  // SPs get hooked sooner regardless of season talent. League first-inning
  // ERA runs ~5.10 (slightly above season ~4.30 — first-inning leverage).
  // High inn1 ERA (>6.5) → -5 (early hook); low inn1 ERA (<3.5) → +3.
  // Walk-load bonus: high first-inning BB/9 → more outs against, faster pull.
  let f_inn1Trouble = 0;
  const inn1Era = ctx.inn1Era ?? null;
  const inn1Ip = ctx.inn1Ip ?? null;
  const inn1Walks = ctx.inn1Walks ?? null;
  if (typeof inn1Era === "number" && inn1Era > 0
      && typeof inn1Ip === "number" && inn1Ip >= 3.0) {
    if (inn1Era >= 7.0)      f_inn1Trouble = -6;
    else if (inn1Era >= 5.5) f_inn1Trouble = -3;
    else if (inn1Era >= 4.5) f_inn1Trouble = -1;
    else if (inn1Era <= 2.0) f_inn1Trouble = 4;
    else if (inn1Era <= 3.5) f_inn1Trouble = 2;
    // Walk-load modifier (BB/9 in the first inning).
    if (typeof inn1Walks === "number" && inn1Ip > 0) {
      const inn1BBper9 = (inn1Walks / inn1Ip) * 9;
      if (inn1BBper9 >= 5.0) f_inn1Trouble -= 2;
      else if (inn1BBper9 >= 3.5) f_inn1Trouble -= 1;
      else if (inn1BBper9 <= 1.5) f_inn1Trouble += 1;
    }
  }
  f_inn1Trouble = clamp(f_inn1Trouble, -8, 6);
  f_inn1Trouble *= sideFlip;
  const score_first_inning_trouble = roundHalfAwayFromZero(f_inn1Trouble * W.outsFirstInningTrouble);

  // ===== GAME SITUATION (3 wired) =====================================

  // (G1) score_bullpen_game_or_opener — season IP/start signal.
  // D-689 widened. Pre-D-689 = 20.7% fire (extremes only: <4 IP opener OR ≥6.5
  // workhorse). New: continuous bands across 4.0-6.5 normal-SP range so every
  // SP gets a directional signal proportional to their IP/start tendency.
  let f_opener = 0;
  if (seasonIPperStart > 0 && season.gamesPlayed >= 5) {
    if (seasonIPperStart < 3.0)      f_opener = -8;
    else if (seasonIPperStart < 4.0) f_opener = -5;
    else if (seasonIPperStart < 4.5) f_opener = -3;
    else if (seasonIPperStart < 5.0) f_opener = -1;
    else if (seasonIPperStart >= 6.5) f_opener = 3;
    else if (seasonIPperStart >= 6.0) f_opener = 2;
    else if (seasonIPperStart >= 5.5) f_opener = 1;
  }
  f_opener *= sideFlip;
  const score_bullpen_game_or_opener = roundHalfAwayFromZero(f_opener * W.outsBullpenGameOrOpener);

  // (G2) score_own_pen_rest — D-664 cache_mlb_pen_rest of pitcher's OWN team.
  // Gassed pen (>10 IP last 48h) → manager keeps SP in longer → MORE outs.
  // Fresh pen (<4 IP) → manager hooks SP earlier → FEWER outs.
  let f_ownPenRest = 0;
  const ownPen = ctx.ownTeamPenIp48h ?? null;
  if (ownPen !== null) {
    if (ownPen >= 12)      f_ownPenRest = 3;   // pen exhausted → SP stays in
    else if (ownPen >= 9)  f_ownPenRest = 2;
    else if (ownPen <= 3)  f_ownPenRest = -3;  // pen fresh → quicker hook
    else if (ownPen <= 5)  f_ownPenRest = -1;
  }
  f_ownPenRest *= sideFlip;
  const score_own_pen_rest = roundHalfAwayFromZero(f_ownPenRest * W.outsOwnPenRest);

  // (G3) score_game_script_risk — RPG gap → blowout-pull risk (symmetric).
  let f_script = 0;
  if (ownRPG !== null && oppRPG !== null && ownRPG > 0 && oppRPG > 0) {
    const rpgGap = Math.abs(ownRPG - oppRPG);
    if (rpgGap >= 1.5)      f_script = -4;
    else if (rpgGap >= 1.0) f_script = -2;
    else if (rpgGap <= 0.3) f_script = 1;   // close game → both SPs ride
  }
  f_script *= sideFlip;
  const score_game_script_risk = roundHalfAwayFromZero(f_script * W.outsGameScriptRisk);

  // ===== OPPONENT PITCH-BURDEN (4 wired; 1 queued) ====================

  // (O1) score_opp_k_rate — high-K opp = quick outs = MORE IP (kept from v1).
  let f_oppK = 0;
  if (opposingHitting && opposingHitting.plateAppearances > 0) {
    const diff = oppKRate - LEAGUE_AVG_TEAM_K_RATE;
    if (diff >= 0.030)      f_oppK = 6;
    else if (diff >= 0.015) f_oppK = 3;
    else if (diff <= -0.030) f_oppK = -6;
    else if (diff <= -0.015) f_oppK = -3;
  }
  f_oppK *= sideFlip;
  const score_opp_k_rate = roundHalfAwayFromZero(f_oppK * W.outsOppKRate);

  // (O2) score_opp_obp_patience — D-668 cache extension.
  // High-OBP lineups force longer at-bats + earlier pen exposure → FEWER outs.
  // League avg OBP ~0.318. Each .010 above → measurable IP drag.
  let f_oppObp = 0;
  const oppObp = opposingHitting?.obpSeason ?? null;
  if (oppObp !== null && oppObp > 0) {
    const LEAGUE_OBP = 0.318;
    const delta = oppObp - LEAGUE_OBP;
    if (delta >= 0.025)      f_oppObp = -5;
    else if (delta >= 0.012) f_oppObp = -2;
    else if (delta <= -0.025) f_oppObp = 5;
    else if (delta <= -0.012) f_oppObp = 2;
  }
  f_oppObp *= sideFlip;
  const score_opp_obp_patience = roundHalfAwayFromZero(f_oppObp * W.outsOppObpPatience);

  // (O3) score_opp_walk_rate — D-668 cache extension.
  // Walks ARE outs you didn't get. High-BB lineup = pitcher in trouble more =
  // pulled earlier.
  let f_oppBb = 0;
  const oppBB = opposingHitting?.bbRate ?? null;
  if (oppBB !== null && oppBB > 0) {
    const LEAGUE_BB = 0.083;  // ~8.3% MLB league avg
    const delta = oppBB - LEAGUE_BB;
    if (delta >= 0.012)      f_oppBb = -3;
    else if (delta >= 0.006) f_oppBb = -1;
    else if (delta <= -0.012) f_oppBb = 3;
    else if (delta <= -0.006) f_oppBb = 1;
  }
  f_oppBb *= sideFlip;
  const score_opp_walk_rate = roundHalfAwayFromZero(f_oppBb * W.outsOppWalkRate);

  // (O4) score_opp_pitch_grind — D-668 cache extension.
  // High pitches/PA = grinding lineup → SP burns count → earlier hook.
  let f_oppGrind = 0;
  const oppPPAv = opposingHitting?.pitchesPerPA ?? null;
  if (oppPPAv !== null && oppPPAv > 0) {
    const delta = oppPPAv - LEAGUE_PPA;
    if (delta >= 0.12)      f_oppGrind = -3;
    else if (delta >= 0.06) f_oppGrind = -1;
    else if (delta <= -0.12) f_oppGrind = 3;
    else if (delta <= -0.06) f_oppGrind = 1;
  }
  f_oppGrind *= sideFlip;
  const score_opp_pitch_grind = roundHalfAwayFromZero(f_oppGrind * W.outsOppPitchGrind);

  // (O5) D-669 SHIP 2 — score_opp_chase_rate_v2.
  // Team-aggregate oz_swing_percent (chase rate) from cache_savant_team_chase.
  // High chase = pitchers cruise = fewer pitches per PA = MORE outs.
  // Low chase = patient lineup = grinding ABs = FEWER outs.
  // League avg ~30%. Each +2pp chase → measurable IP boost for SP.
  let f_chaseV2 = 0;
  const oppChase = opposingHitting?.ozSwingAvg ?? null;
  if (typeof oppChase === "number" && oppChase > 0) {
    const LEAGUE_CHASE = 30.0;
    const delta = oppChase - LEAGUE_CHASE;
    if (delta >= 4)       f_chaseV2 = 5;    // chase-happy lineup → SP cruises
    else if (delta >= 2)  f_chaseV2 = 2;
    else if (delta <= -4) f_chaseV2 = -5;   // patient lineup → SP grinds
    else if (delta <= -2) f_chaseV2 = -2;
  }
  f_chaseV2 *= sideFlip;
  const score_opp_chase_rate = roundHalfAwayFromZero(f_chaseV2 * W.outsOppChaseRate);

  // ===== CONTEXT (2 wired) ============================================

  // (C1) score_ballpark_factor_outs — uses runsFactor.
  // D-689 widened. Pre-D-689 = 6.9% fire (gate ≥1.05 or ≤0.95). Most parks
  // 0.96-1.04. New: ±0.02 mild band catches modest park effects on starter outs.
  let f_park = 0;
  if (ballpark) {
    if (ballpark.runsFactor >= 1.10) f_park = -4;
    else if (ballpark.runsFactor >= 1.05) f_park = -2;
    else if (ballpark.runsFactor >= 1.02) f_park = -1;
    else if (ballpark.runsFactor <= 0.90) f_park = 4;
    else if (ballpark.runsFactor <= 0.95) f_park = 2;
    else if (ballpark.runsFactor <= 0.98) f_park = 1;
  }
  f_park *= sideFlip;
  const score_ballpark_factor = roundHalfAwayFromZero(f_park * W.outsBallparkFactor);

  // (C2) score_weather_temp_outs — hot weather → SP fatigue.
  // D-689 widened. Pre-D-689 pitcher_outs weather_temp = 0% DEAD on n=29 — gate
  // ≥85°F or ≤55°F missed most games. New: continuous bands from 75°F → 92°F.
  let f_weatherTemp = 0;
  if (weather?.tempF !== null && weather?.tempF !== undefined) {
    if (weather.tempF >= 92) f_weatherTemp = -3;
    else if (weather.tempF >= 85) f_weatherTemp = -2;
    else if (weather.tempF >= 78) f_weatherTemp = -1;
    else if (weather.tempF <= 55) f_weatherTemp = 2;
    else if (weather.tempF <= 62) f_weatherTemp = 1;
  }
  f_weatherTemp *= sideFlip;
  const score_weather_temp = roundHalfAwayFromZero(f_weatherTemp * W.outsWeatherTemp);

  // ===== D-761 NEW EARLY-HOOK FACTORS ================================
  // Both target the structural under-side gap D-760 found (unders 35.9% WR
  // on n=64). Both predict EARLY HOOKS — favoring UNDER.

  // (E1) score_pitcher_third_time_penalty — D-761.
  // Pitcher's OPS allowed on 3rd time through the lineup (sitCode=i06 in
  // cache_mlb_pitcher_inn1). Research-validated ~80-100 OPS jump 3rd time.
  // Managers pull SPs BEFORE the 3rd time through if they know the pitcher
  // can't handle it. Gated i06 IP ≥3.0 so we don't score on micro-samples.
  // League avg 3rd-time-through OPS ~.700.
  let f_thirdTime = 0;
  const thirdOps = ctx.thirdTimeOps ?? null;
  const thirdIp = ctx.thirdTimeIp ?? null;
  if (typeof thirdOps === "number" && thirdOps > 0
      && typeof thirdIp === "number" && thirdIp >= 3.0) {
    if (thirdOps >= 1.000)      f_thirdTime = -8;   // catastrophic (Logan Webb i06 0.408 vs Misiorowski 1.481)
    else if (thirdOps >= 0.900) f_thirdTime = -5;
    else if (thirdOps >= 0.800) f_thirdTime = -3;
    else if (thirdOps >= 0.730) f_thirdTime = -1;
    else if (thirdOps <= 0.500) f_thirdTime = 5;    // elite (Webb-class — go deep)
    else if (thirdOps <= 0.600) f_thirdTime = 3;
    else if (thirdOps <= 0.670) f_thirdTime = 1;
  }
  f_thirdTime *= sideFlip;
  const score_pitcher_third_time_penalty = roundHalfAwayFromZero(f_thirdTime * W.outsThirdTimeThrough);

  // (E2) score_pitcher_pitches_per_ip — D-761.
  // Efficiency ratio. Derived from existing season.pitchesPerStart /
  // seasonIPperStart (no new data needed). Research: <15 = deep guy,
  // 17+ = early hook. League ~16.
  let f_pitchesPerIp = 0;
  const ppi = (season.pitchesPerStart !== null && season.pitchesPerStart > 0
               && seasonIPperStart > 0)
    ? season.pitchesPerStart / seasonIPperStart
    : null;
  if (ppi !== null) {
    if (ppi <= 14.5)      f_pitchesPerIp = 5;   // elite efficiency → goes deep
    else if (ppi <= 15.5) f_pitchesPerIp = 2;
    else if (ppi >= 18.5) f_pitchesPerIp = -6;  // wasteful → early hook
    else if (ppi >= 17.0) f_pitchesPerIp = -3;
    else if (ppi >= 16.0) f_pitchesPerIp = -1;
  }
  f_pitchesPerIp *= sideFlip;
  const score_pitcher_pitches_per_ip = roundHalfAwayFromZero(f_pitchesPerIp * W.outsPitchesPerIp);

  // (E3) score_pitcher_manager_hook — D-763.
  // REAL manager-hook signal from cache_mlb_team_manager_hook (computed
  // from MLB Stats API starter-only team aggregate, sitCodes=sp).
  // hook_index = avg_starter_pitches_per_start − 88 (league avg). NEGATIVE
  // means quick-hook manager (favor UNDER on pitcher_outs). POSITIVE means
  // patient manager (favor OVER).
  //
  // SUPERSEDES the pre-D-763 score_pitcher_volatility_v2 proxy (which D-671
  // SHIP 2 admitted measured pitcher behavior, not manager). volatility_v2
  // stays wired for back-compat / shadow comparison; D-764 may demote it.
  //
  // BUCKETS calibrated from real 2026 data (D-763 backfill):
  //   Washington Nationals -16.3 (quickest hooks) → +8 for UNDER
  //   Tampa Bay Rays       -12.0 (analytics) → +5 for UNDER
  //   League avg                0 → 0
  //   San Francisco Giants  +1.9 (most patient) → +2 for OVER
  // Range is asymmetric — quick-hook end has wider spread than patient end
  // because modern managers cluster around 85-89 pps with a long quick-hook tail.
  //
  // BULLPEN-STATE INTERACTION: research says quick-hook managers extend
  // their starter when bullpen is gassed. We approximate this via the
  // existing score_own_pen_rest factor (G2) which already adds for a
  // taxed bullpen. The two factors fire independently and add naturally
  // in the factor sum — when pen is gassed AND manager is normally
  // quick, the contributions partially cancel (own_pen_rest adds + for
  // OVER while manager_hook adds + for UNDER). This is the correct
  // research-aligned behavior — quick-hook tendency relaxes under bullpen
  // load. Modeling a multiplicative interaction is queued for D-765.
  let f_managerHook = 0;
  const hookIdx = ctx.ownTeamHookIndex ?? null;
  if (typeof hookIdx === "number") {
    if (hookIdx <= -12)      f_managerHook = -8;   // very quick-hook (Nationals, White Sox class)
    else if (hookIdx <= -8)  f_managerHook = -5;   // quick-hook (Rays, Rockies class)
    else if (hookIdx <= -4)  f_managerHook = -3;
    else if (hookIdx <= -2)  f_managerHook = -1;
    else if (hookIdx >= +3)  f_managerHook = 3;    // most patient
    else if (hookIdx >= +1)  f_managerHook = 2;
    // else neutral band (-2 to +1) returns 0
  }
  f_managerHook *= sideFlip;
  const score_pitcher_manager_hook = roundHalfAwayFromZero(f_managerHook * W.outsManagerHook);

  // ===== M5 — Poisson win-prob path (replaces additive confidence + D-780 isotonic) ===
  const factorSum_outs =
    score_pitcher_avg_ip + score_pitcher_recent_ip_trend + score_pitcher_volatility_v2
    + score_rest_pitcher + score_pitcher_walk_efficiency + score_pitcher_recent_pitch_count
    + score_first_inning_trouble
    + score_bullpen_game_or_opener + score_own_pen_rest + score_game_script_risk
    + score_opp_k_rate + score_opp_obp_patience + score_opp_walk_rate + score_opp_pitch_grind
    + score_opp_chase_rate
    + score_ballpark_factor + score_weather_temp
    + score_pitcher_third_time_penalty + score_pitcher_pitches_per_ip
    + score_pitcher_manager_hook;
  const usePoissonOuts = !poissonDisabledForHarness();
  let winProb_outs = 0;
  let confidence_raw_outs = 0;
  let confidence_raw_d780 = 0;

  if (usePoissonOuts) {
    const lambdaMultiplier_outs = clamp(1.0 + (factorSum_outs * sideFlip) * getLambdaCoeff(), 0.65, 1.40);
    const lambdaAdjusted_outs = projectedStat * lambdaMultiplier_outs;
    winProb_outs = winProbPoissonK(
      lambdaAdjusted_outs, prop.line, prop.pickSide as "over" | "under",
    );
    confidence_raw_outs = clamp(Math.round(winProb_outs * 100), 0, 100);
    confidence = shrinkPoissonConfidence(confidence_raw_outs);
    confidence = clamp(confidence, 0, 100);
  } else {
    confidence = 50 + edge * 3 + factorSum_outs;
    confidence = clamp(Math.round(confidence), 0, 100);
  }

  // === D-467 EDGE-SIGN FLOOR — skipped under Poisson win-prob ==========
  let d467_edge_floor_delta = 0;
  if (!usePoissonOuts && edge < 0 && confidence > 69) {
    d467_edge_floor_delta = confidence - 69;
    confidence = 69;
  }

  const confidence_pre_cap = confidence;

  // === D-140 TRIVIAL-LINE CAP (uniform with other markets) ========
  // Note: pitcher_outs typical lines are 14.5+ — the trivial-line cap
  // (line<=0.5) is structurally inactive here, but keep for parity.
  let d140_cap_delta = 0;
  if (prop.line <= 0.5 && Math.abs(prop.odds) >= 200 && confidence > 65) {
    d140_cap_delta = confidence - 65;
    confidence = 65;
  }

  // === D-479 LONGSHOT OVER CAP (uniform structural rule) ===========
  // Sibling of D-140. See scorePitcherStrikeouts header for full
  // mechanism. GOOD-tier OVER picks at +100-or-longer odds → cap 65.
  if (prop.pickSide === "over" && prop.odds >= 100
      && confidence >= 70 && confidence <= 79) {
    confidence = 65;
  }

  // === D-509 ELITE/STRONG LONGSHOT OVER CAP (sibling of D-479) =====
  // pitcher_outs is in the bleed cluster — no carve-out. See
  // scorePitcherStrikeouts header (line 534) for full rationale.
  if (prop.pickSide === "over" && confidence >= 80 && prop.odds >= 150) {
    confidence = 75;
  }

  if (usePoissonOuts) {
    confidence_raw_d780 = confidence_raw_outs;
  } else {
    confidence_raw_d780 = confidence;
    confidence = applyD779IsotonicCalibrationPitcherOuts(confidence_raw_d780);
    confidence = clamp(confidence, 0, 100);
  }

  // === SANITY FLAGS ===============================================
  let unbettableJuiceFlag = false;
  if (prop.pickSide === "under") {
    if (confidence >= 90 && prop.odds <= -350)      unbettableJuiceFlag = true;
    else if (confidence >= 80 && prop.odds <= -300) unbettableJuiceFlag = true;
    else if (confidence >= 70 && prop.odds <= -250) unbettableJuiceFlag = true;
    else if (confidence >= 60 && prop.odds <= -200) unbettableJuiceFlag = true;
  }

  function hitRate(window: PitcherGameLogEntry[]): number {
    if (window.length === 0) return 0;
    const hits = window.filter((g) =>
      prop.pickSide === "over" ? g.inningsPitched * 3 > prop.line : g.inningsPitched * 3 < prop.line,
    ).length;
    return (hits / window.length) * 100;
  }
  const last5HitRate = hitRate(last5);
  const last10HitRate = hitRate(gameLog.slice(-10));
  const seasonHitRate = hitRate(gameLog);
  const coinFlipFlag = confidence >= 80 && last5HitRate >= 40 && last5HitRate <= 60;

  let unbettableOverBreakevenFlag = false;
  if (usePoissonOuts && prop.pickSide === "over") {
    unbettableOverBreakevenFlag =
      winProb_outs * 100 <= impliedProbAmerican(prop.odds) * 100;
  }
  const outsEvFields = usePoissonOuts
    ? computeEvFromWinProb(winProb_outs, prop.odds)
    : {};

  const factorArr = [
    score_pitcher_avg_ip, score_pitcher_recent_ip_trend, score_pitcher_volatility_v2,
    score_rest_pitcher, score_pitcher_walk_efficiency, score_pitcher_recent_pitch_count,
    score_bullpen_game_or_opener, score_own_pen_rest, score_game_script_risk,
    score_opp_k_rate, score_opp_obp_patience, score_opp_walk_rate, score_opp_pitch_grind,
    score_ballpark_factor, score_weather_temp,
    // D-761 — early-hook factors
    score_pitcher_third_time_penalty, score_pitcher_pitches_per_ip,
    // D-763 — REAL manager-hook factor
    score_pitcher_manager_hook,
  ];
  const negativeFactorCount = factorArr.filter((v) => v < 0).length;
  const negativeStackingFlag = confidence >= 80 && negativeFactorCount >= 3;

  const verdict = getScoreLabel(confidence);

  const breakdown: Record<string, number | string | boolean | null> = {
    market_stat: "outs",
    pick_side: prop.pickSide,
    raw_edge: Math.round(edge * 100) / 100,
    projected_outs: Math.round(projectedStat * 100) / 100,
    projected_ip: Math.round(projectedIp * 100) / 100,
    // D-668 — shared computeExpectedIP inputs + projection adjustments persisted.
    expected_ip_base: Math.round(baseExpectedIP * 100) / 100,
    season_ip_per_start: Math.round(seasonIPperStart * 100) / 100,
    last5_ip_per_start: Math.round(last5IPperStart * 100) / 100,
    opp_k_adj: Math.round(oppKAdj * 1000) / 1000,
    opp_pace_adj: Math.round(oppPaceAdj * 1000) / 1000,
    park_adj: Math.round(parkAdj * 1000) / 1000,
    script_adj: Math.round(scriptAdj * 1000) / 1000,
    season_games_played: season.gamesPlayed,
    season_pitches_per_start: season.pitchesPerStart,
    last5_hit_rate_pct: Math.round(last5HitRate),
    last10_hit_rate_pct: Math.round(last10HitRate),
    season_hit_rate_pct: Math.round(seasonHitRate),
    // D-668 — raw inputs persisted for optimizer.
    opp_k_rate: opposingHitting?.kRate ?? null,
    opp_obp_season: opposingHitting?.obpSeason ?? null,
    opp_bb_rate: opposingHitting?.bbRate ?? null,
    opp_pitches_per_pa: opposingHitting?.pitchesPerPA ?? null,
    own_team_pen_ip_48h: ctx.ownTeamPenIp48h ?? null,
    own_team_rpg: ownRPG,
    opp_rpg: oppRPG,
    park_runs_factor: ballpark?.runsFactor ?? null,
    weather_temp_f: weather?.tempF ?? null,
    // D-668 — all 13 wired factor scores.
    score_pitcher_avg_ip,
    score_pitcher_recent_ip_trend,
    score_pitcher_volatility_v2,
    volatility_components: JSON.stringify(volatilityComponents),
    // D-671 — real BB/9 used by score_pitcher_walk_efficiency (was a fabricated formula pre-D-671).
    real_bb_per_9: real_bb_per_9 !== null ? Math.round(real_bb_per_9 * 100) / 100 : null,
    season_walks: season.baseOnBalls,
    d671_walk_eff_fixed: true,
    d671_volatility_relabeled: true,
    score_rest_pitcher,
    score_pitcher_walk_efficiency,
    score_pitcher_recent_pitch_count,
    score_bullpen_game_or_opener,
    score_own_pen_rest,
    score_game_script_risk,
    score_opp_k_rate,
    score_opp_obp_patience,
    score_opp_walk_rate,
    score_opp_pitch_grind,
    score_ballpark_factor,
    score_weather_temp,
    // D-669 SHIP 1 — first-inning trouble WIRED (was D-668 D7 queued).
    score_first_inning_trouble,
    inn1_era: inn1Era,
    inn1_ip: inn1Ip,
    inn1_walks: inn1Walks,
    // D-669 SHIP 2 — opp chase rate WIRED (was D-668 O5 queued).
    score_opp_chase_rate,
    opp_oz_swing_avg: opposingHitting?.ozSwingAvg ?? null,
    // D-761 — early-hook factors (third-time-through + pitches/IP ratio).
    score_pitcher_third_time_penalty,
    third_time_ops: ctx.thirdTimeOps ?? null,
    third_time_ip:  ctx.thirdTimeIp  ?? null,
    score_pitcher_pitches_per_ip,
    pitches_per_ip: ppi !== null ? Math.round(ppi * 100) / 100 : null,
    // D-763 — REAL manager-hook factor (closes D-668-FOLLOWUP-PULL-FEED).
    score_pitcher_manager_hook,
    own_team_hook_index: ctx.ownTeamHookIndex ?? null,
    queued_followups: "D-668-FOLLOWUP-PULL-FEED CLOSED by D-763 (cache_mlb_team_manager_hook from sitCodes=sp). volatility_v2 proxy retained for back-compat — D-764+ may demote.",
    d467_edge_floor_applied: d467_edge_floor_delta > 0,
    d668_wired: true,
    d669_inn1_wired: true,
    d669_chase_wired: true,
    d761_third_time_wired: true,
    d761_pitches_per_ip_wired: true,
    quality_tier: "B+ → A- post-D-668; D-761 targets D-760 under-side gap",
    v1_algo: "D-761 17-factor pitcher_outs + 2 D-761 early-hook (third_time_penalty + pitches_per_ip) targeting D-760 under-side gap (35.9% WR). Existing 15 wired factors + D-761's 2 = 17 total wired.",
  };

  return {
    confidence,
    confidence_pre_cap,
    confidence_pre_tier_aware: confidence,
    verdict,
    // K-specific result fields populated with outs-equivalent values where
    // semantically aligned; otherwise zero.
    projectedK: Math.round(projectedStat * 100) / 100,   // outs (mapped to projectedK slot)
    seasonAvg: Math.round(seasonIPperStart * 3 * 100) / 100,  // season outs/start
    recentAvg: Math.round(last5IPperStart * 3 * 100) / 100,  // recent outs/start
    edge: Math.round(edge * 100) / 100,
    // Pitcher-K-specific score_* fields zeroed; outs scores in breakdown.
    score_pitcher_k_rate: 0,
    score_pitcher_form: 0,
    score_opposing_lineup_k: score_opp_k_rate,            // semantic match
    score_handedness_matchup: 0,
    score_pitch_count_trend: score_pitcher_recent_pitch_count,  // semantic match
    score_rest_pitcher,                                    // semantic match — D-668 now non-zero
    score_ballpark_factor,                                 // semantic match
    score_weather_wind: 0,
    score_weather_temp,                                    // semantic match
    score_umpire_k_zone: 0,
    score_pitcher_command_trend: 0,
    score_pitcher_velocity_trend: 0,
    score_lineup_k_composition: 0,
    score_pitch_type_matchup: 0,
    score_pitcher_whiff_skill_v2: 0,
    score_pitcher_csw: 0,  // D-749
    unbettableJuiceFlag,
    unbettableOverBreakevenFlag,
    coinFlipFlag,
    negativeStackingFlag,
    negativeFactorCount,
    winProb: winProb_outs,
    ...outsEvFields,
    breakdown,
  };
}

// ===========================================================================
// T3.2 — Batter Hits
// ===========================================================================

export interface BatterSeasonStats {
  gamesPlayed: number;
  atBats: number;
  hits: number;
  plateAppearances: number;
  battingAvg: number;          // hits/AB
  babip: number;
  obp: number;
  bats: "L" | "R" | "S" | null;
  // Power-derived (reused in T3.4)
  homeRuns: number;
  totalBases: number;
  rbi: number;
  hrPerPA: number;             // HR/PA
  iso: number;                 // SLG - AVG
  // Splits (NULL when unavailable in v1)
  avgVsLHP: number | null;
  avgVsRHP: number | null;
  // D-474 — batter K stats (used by scoreBatterStrikeouts).
  // Optional with default 0 so existing batter scorers are unaffected
  // (they don't read this field).
  strikeOuts: number;          // season K total (from MLB Stats API s.strikeOuts)
  // D-475 — batter season runs scored (used by scoreBatterRunsScored).
  // Non-breaking; existing scorers don't reference this field.
  runs: number;                // season runs scored (from MLB Stats API s.runs)
}

export interface BatterGameLogEntry {
  date: string;
  atBats: number;
  hits: number;
  homeRuns: number;
  totalBases: number;
  rbi: number;
  plateAppearances: number;
  battingOrderSlot: number | null;  // lineup slot 1-9 if known
  // D-474 — per-game K count (used for last-N K form factor).
  strikeOuts: number;          // game K count (from MLB Stats API st.strikeOuts)
  // D-475 — per-game runs scored (used for last-N R form factor).
  runs: number;                // game runs scored (from MLB Stats API st.runs)
}

export interface OpposingPitcherContext {
  fullName: string;
  throws: "L" | "R" | null;
  era: number;
  whip: number;
  kPerNine: number;
  hrPerNine: number;
  inningsPitched: number;
  // recent form
  last3Era: number | null;
  // D-652 — Statcast pitch-arsenal aggregates from cache_statcast_pitcher_arsenal
  // (24.6% pitcher coverage per D-646 fix). Drives v3 pitching-quality composite.
  // null on cache miss → v3 degrades to ERA-only for that pitcher.
  expectedWhiffPct: number | null;
  expectedKPct: number | null;
  expectedPutAway: number | null;
  // D-661 — Ground-out-to-air-out ratio (GB/FB-equivalent). League avg ~1.10.
  // > 1.30 = strong groundballer (HR suppression); < 0.85 = flyballer (HR boost).
  // Sourced from MLB Stats API season pitching stats — already in the response
  // body that fetchPitcherSeasonAsOpposing parses, so adding this field costs
  // zero new API calls and zero new memory beyond a single number per pitcher.
  groundOutsToAirouts: number | null;
  // D-663 — gamesStarted from the SAME season pitching response body that
  // fetchPitcherSeason parses. Combined with inningsPitched → IP per start.
  // Drives score_sp_ip_depth_v3 on spreads (deep SP avoids bullpen exposure
  // = better margin = covers -1.5 more often). Zero new API calls.
  gamesStarted: number | null;
  // D-664 — last-3-start aggregate ERA. Populated by the new daily cron
  // fetch-mlb-pitcher-pen-extras into cache_mlb_pitcher_last3. null on cache miss
  // → score_sp_last3_form_v3 falls back to 0.
  last3StartEra: number | null;
  // D-803 — closing the D-800 finding: pitcher hard-contact-ALLOWED fields
  // were fetched into _pitcherCache (statcast.ts:109) but dropped at THIS
  // interface boundary. Same loaded-then-dropped pattern as D-796 xwOBA on
  // the batter side. Wiring them lets scoreBatterMarket compute the
  // matchup-side counterpart to D-797's score_batter_hard_hit:
  //   batter hits 95+ mph hard often × pitcher allows 95+ mph hard often
  //   = real TB/HR/RBI power matchup signal that doesn't overlap xwOBA.
  // Populated from cache_statcast_pitchers_exit_velo via the same fetcher
  // (24.6% pitcher coverage today; null on cache miss — factor returns 0).
  oppPitcherEv95Percent: number | null;   // hard-hit % allowed (≥95mph EV)
  oppPitcherBrlPa: number | null;         // barrels allowed per PA
  oppPitcherBrlPercent: number | null;    // barrels allowed % of batted balls
  oppPitcherAvgHitSpeed: number | null;   // avg EV allowed (mph)
}

// D-276-FACTORS — optional Statcast block passed in by caller.
// D-278-FACTORS — added est_ba (for xba factor) + avg_hit_speed (for
// exit velo trend) to BatterStatcastContext; PitcherStatcastContext
// gains nothing new (BAA proxy already covered by est_ba which is
// est_BA-allowed for pitchers).
export interface BatterStatcastContext {
  est_ba: number | null;                   // D-278: batter xBA factor
  est_slg: number | null;
  est_slg_minus_slg_diff: number | null;
  brl_pa: number | null;
  brl_percent: number | null;
  avg_hit_speed: number | null;            // D-278: exit velo trend factor
  // D-797 — closing the D-796 gap: xwOBA + launch / sweet-spot / hard-hit are
  // in the cache (cache_statcast_batters_xstats / _exit_velo) and the loader
  // pulls them, but pre-D-797 the context dropped them at this interface
  // boundary so the scorer never saw the strongest TB predictors.
  est_woba: number | null;                 // xwOBA — THE research-validated single best TB predictor
  est_woba_minus_woba_diff: number | null; // xwOBA regression delta (negative = under-performing)
  ev95percent: number | null;              // hard-hit % (≥95mph EV)
  avg_hit_angle: number | null;            // avg launch angle, degrees (sweet-spot ~12°)
  anglesweetspotpercent: number | null;    // % of batted balls in 8-32° sweet-spot range
}

// D-282 SHIP 1 — batter splits vs LHP/RHP, sourced from
// cache_mlb_batter_splits (populated by fetch-mlb-batter-splits cron).
// Used to compute hand_split factor against today's starting pitcher.
export interface BatterSplitsContext {
  vs_lhp_avg: number | null; vs_lhp_slg: number | null;
  vs_lhp_ops: number | null; vs_lhp_pa: number | null;
  vs_rhp_avg: number | null; vs_rhp_slg: number | null;
  vs_rhp_ops: number | null; vs_rhp_pa: number | null;
}
export interface PitcherStatcastContext {
  xera: number | null;
  est_ba: number | null;                   // pitcher BAA-allowed proxy
  est_ba_minus_ba_diff: number | null;
}

export interface BatterScoringContext {
  batter: {
    fullName: string;
    team: string;
    opponentTeam: string;
    isHome: boolean;
    gameTime: string;
    venue: string | null;
  };
  season: BatterSeasonStats;
  gameLog: BatterGameLogEntry[];
  opposingPitcher: OpposingPitcherContext | null;
  ballpark: BallparkFactor | null;
  weather: GameWeather | null;
  prop: { propType: string; line: number; odds: number; pickSide: "over" | "under"; bookmaker: string };
  // D-276-FACTORS — optional Statcast enrichment. Gracefully degrades
  // to no-op when null (factor scores 0).
  statcast?: BatterStatcastContext | null;
  // D-282 SHIP 1 — optional batter splits vs LHP/RHP.
  splits?: BatterSplitsContext | null;
  // D-283 SHIP 4 — opposing team bullpen aggregates. Higher ERA →
  // weaker bullpen → boost batter projection. Null on cache miss.
  opposingBullpen?: { bullpen_era: number | null; bullpen_whip: number | null; bullpen_ip: number | null } | null;
  // D-287 SHIP 1 — ballpark CF compass bearing + dome flag.
  ballparkOrientation?: { cf_compass_degrees: number; is_dome: boolean } | null;
  // D-347 — 3 new batter-side factors.
  // lineupSpot: tonight's batting order position (1-9). null when pre-game lineup unavailable.
  // dayAfterNight: true when player started a >=19:00 ET game last night AND today's start <=15:00 ET.
  // travelContext: distance + direction since yesterday's venue. null when no prior-day game.
  lineupSpot?: number | null;
  dayAfterNight?: boolean;
  travelContext?: { miles: number; direction: "EW" | "WE" | null } | null;
  // D-349 — opposing pitcher's BAA vs this batter's handedness (from cache_mlb_pitcher_splits).
  // Read by scoreBatterMarket; uses batter's bats + opposing pitcher splits.
  opposingPitcherSplits?: {
    baa_vs_lhb: number | null; pa_vs_lhb: number | null;
    baa_vs_rhb: number | null; pa_vs_rhb: number | null;
  } | null;
  // D-354 — consecutive games started in last N days (from cache_mlb_boxscore_player_stats).
  // Higher = more fatigue signal. Null when cache miss.
  consecutiveStarts?: number | null;
  // D-598 — opposing pitcher_id (always stored when oppPitcher resolved).
  // D-599 could not run a retroactive pitch-type matchup test because the
  // pid was not persisted on batter picks; storing it forward makes future
  // audits / harness joins possible without re-fetching live probables.
  opposingPitcherId?: number | null;
  // D-598 — opposing pitcher's pitch-type matchup aggregates (from
  // cache_statcast_pitcher_arsenal, populated by D-596 bulkLoad). Used by
  // score_opp_pitcher_pitchtype_quality across all batter markets. Null
  // on cache miss; scorers gracefully degrade to 0.
  opposingPitcherArsenal?: {
    expected_put_away: number | null;
    expected_whiff_pct: number | null;
  } | null;
  // D-807 — lineup protection: average OPS of the 2 hitters batting BEHIND
  // this batter (slots +1, +2 on same side, wrapping 9→1). Driven by lineup
  // confirmation + memoized batterSeason. Null = unknown lineup or no data.
  // Runs-only signal (drives in runs vs the batter's own contact ability).
  nextHittersBehindOps?: number | null;
  // D-807 — team offense context (batter's own team OPS_SEASON). Populated
  // by readTeamSeasonContext on the batter's team. Memoized per team. Null
  // on cache miss. Distinct from score_lineup_spot (PA volume signal) — this
  // captures whether the batter plays for a high-scoring offense overall.
  batterTeamContext?: { opsSeason: number | null } | null;
  // D-808 — sprint speed (Baseball Savant running leaderboard, ft/sec).
  // Faster runners take extra bases + score from 1st on doubles. Null when
  // no Statcast running data (rare for established starters; common for
  // rookies / call-ups). League avg ~27, elite ≥29, slow ≤25.
  batterSprintSpeed?: number | null;
  // D-816 — pull rate (Baseball Savant batted-ball direction leaderboard).
  // pull_rate = fraction of batted balls hit to pull side (0.0-1.0).
  // pull_air_rate = fraction of batted balls that are PULLED AIR (pull + fly/LD).
  // Pull-air is THE HR-prediction signal — pull-heavy fly-ball hitters at
  // power-friendly parks are the classic HR profile. League avg pull_rate ~0.36,
  // pull_air_rate ~0.20. Null on cache miss → factor returns 0.
  batterPullRate?: { pull_rate: number; pull_air_rate: number | null } | null;
  // D-824 — batter contact-rate / whiff-rate (hits-specific discriminator).
  // Sourced from Baseball Savant plate-discipline leaderboard. snapshot_date
  // is captured per row so leak-safe AS-OF lookup is possible (D-820 lesson).
  batterContactRate?: {
    whiff_percent: number;
    contact_percent: number | null;
    z_contact_percent: number | null;
    oz_contact_percent: number | null;
  } | null;
  // D-817 — park dimensions (cache_mlb_park_dimensions). Distances in feet.
  // Lefty pulls to RF (uses rf_distance). Righty pulls to LF (uses lf_distance).
  // Switch hitter resolved via opposingPitcher.throws: vs RHP bats lefty,
  // vs LHP bats righty. Null on cache miss or unknown venue.
  parkDimensions?: { lf_distance: number; cf_distance: number; rf_distance: number } | null;
}

export interface BatterMarketResult {
  confidence: number;
  confidence_pre_cap: number;          // D-406: confidence BEFORE D-140 trivial-line cap at line 1544
  confidence_pre_tier_aware: number;
  verdict: string;
  projectedStat: number;
  seasonAvg: number;
  recentAvg: number;
  edge: number;
  // factor magnitudes — slim subset depending on market
  score_batter_hit_rate: number;
  score_batter_form: number;
  score_opposing_pitcher_quality: number;
  score_recent_at_bats: number;
  score_handedness_matchup: number;
  score_ballpark_factor: number;
  score_weather_temp: number;
  score_lineup_consistency: number;
  // Power-only (T3.4) — zero when not power market
  score_batter_power_rate: number;
  score_batter_form_power: number;
  score_pitcher_hr_rate: number;
  score_weather_wind: number;
  // D-347 — 3 new batter factors.
  score_lineup_spot: number;
  score_day_after_night_fatigue: number;
  score_travel_getaway: number;
  // D-349 — opposing pitcher's BAA vs batter's handedness.
  score_pitcher_baa_vs_hand: number;
  // D-354 — consecutive-starts streak fatigue penalty.
  score_hitter_streak_fatigue: number;
  // D-520-APPLY — D-517 v2 line-hit-rate penalty (gates picks where l10 < 60).
  score_batter_line_hit_rate: number;
  // D-598 — opposing pitcher's pitch-type matchup factor (batter-side).
  // Wired across all batter markets; direction differs (contact suppresses
  // over, batter_strikeouts boosts over). 14-day watch then per-market
  // signal-gate + harness verdict before promotion.
  score_opp_pitcher_pitchtype_quality: number;
  // D-785 — 8 factor columns previously persisted ONLY in `breakdown` JSONB.
  // D-783 audit found these 8 NULL on top-level columns for all batter picks
  // (10/12 runs-specific factors invisible to the optimizer reading top-level).
  // Adding to interface contract → batterHistPayload emits at top-level →
  // schema + RPC INSERT list now persist them. Optimizer can now read them
  // as dedicated columns. Defaults to 0 for markets that don't compute them
  // (preserves the "0 = not measured" semantic used elsewhere).
  score_batter_obp: number;                    // runs-only baseline
  score_recent_run_form: number;               // runs-only baseline
  score_bullpen_quality: number;               // runs-only baseline
  score_batter_xba: number;                    // Statcast — multi-market
  score_batter_exit_velo_trend: number;        // Statcast — multi-market
  score_batter_barrel_rate: number;            // Statcast — multi-market
  score_batter_xslg_regression: number;        // Statcast — multi-market
  score_batter_vs_pitcher_hand_split: number;  // Multi-market
  // D-797 — fix babip non-return (was computed + contributing but missing
  // from return; D-794-class). Plus 4 new extra-base factors (TB-primary,
  // also fire on RBI / HR for the angle-based ones).
  score_batter_babip: number;
  score_batter_xwoba: number;                  // xwOBA — primary extra-base predictor
  score_batter_launch_angle: number;           // avg launch angle (2B/3B signal)
  score_batter_sweet_spot: number;             // sweet-spot % (extra-base contact quality)
  score_batter_hard_hit: number;               // ev95% (hard-hit rate)
  // D-803 — pitcher hard-contact-allowed (matchup-side counterpart to hard_hit).
  // The LITERAL matchup signal: batter hard-hit% × pitcher hard-hit-allowed%.
  // Closes D-800 loaded-then-dropped finding on pitcher side.
  score_pitcher_hard_contact_allowed: number;
  // D-807 — lineup protection + team offense (runs-only high-value signals).
  score_batter_lineup_protection: number;
  score_batter_team_offense: number;
  // D-808 — sprint speed (baserunning, runs-only).
  score_batter_sprint_speed: number;
  // D-816 — pull rate (HR-only). The missing HR-specific factor per D-811 audit.
  score_batter_pull_rate: number;
  score_batter_contact_rate: number;
  // D-817 — pull × pull-side fence interaction (HR-only). Amplifier on pull_rate.
  score_batter_pull_x_park_fence: number;
  // sanity
  unbettableJuiceFlag: boolean;
  unbettableOverBreakevenFlag: boolean;
  coinFlipFlag: boolean;
  negativeStackingFlag: boolean;
  negativeFactorCount: number;
  /** D-691 win-probability path (batter_hits only). */
  winProb?: number;
  edgeVsImplied?: number;
  evPerUnit?: number;
  breakdown: Record<string, number | string | null | boolean>;
}

// D-340 / T6 — see W comment above.
const DEFAULT_W_BATTER = {
  hitRate: 1.5,
  form: 1.5,
  pitcherQuality: 1.5,
  recentAB: 1.0,
  handednessMatchup: 0.75,
  ballparkHitsFactor: 1.0,
  weatherTemp: 0.25,
  lineupConsistency: 0.5,
  // Power-specific
  powerRate: 1.5,
  formPower: 1.25,
  pitcherHrRate: 1.5,
  weatherWind: 0.5,
  // D-347
  lineupSpot: 1.0,
  dayAfterNightFatigue: 0.5,
  travelGetaway: 0.5,
  // D-349/D-809 — opposing pitcher BAA vs batter hand. Lowered 1.0 → 0.75 in
  // D-809: overlaps somewhat with vs_pitcher_hand_split which is already at 1.0;
  // "medium" tier seed avoids double-counting the handedness matchup signal.
  opposingPitcherBaaVsHand: 0.75,
  // D-354
  hitterStreakFatigue: 0.5,
  // D-362 — DB-tunable weights for the 9 batter-side factors that previously
  // had hardcoded `* 1.0` literals in scoring_mlb_v2.ts. All default 1.0 to
  // preserve current effective weight; T11 can move them via DB updates.
  xba: 1.0,
  exitVeloTrend: 1.0,
  barrelRate: 1.0,
  xslgRegression: 1.0,
  babip: 1.0,
  vsPitcherHandSplit: 1.0,
  bullpenQuality: 1.0,
  windDirectionHr: 1.0,
  pitcherHrPer9: 1.0,
  // D-520-APPLY — D-517 v2 line-hit-rate penalty factor weight (DB-tunable
  // via w_mlb_batter_line_hit_rate, default 2.0).
  lineHitRate: 2.0,
  // D-598 — opposing pitcher pitch-type matchup factor (batter-side).
  // Conservative seed weight 1.0 mirroring D-596 pitcher_k. 14-day watch
  // collects data; per-market harness verdict gates promotion.
  oppPitcherPitchTypeQuality: 1.0,
  // D-797/D-809 — 4 extra-base factors (TB primary). D-809 educated seeds:
  // xwoba 1.5 (research-validated single best TB predictor); launch_angle +
  // sweet_spot 0.75 ("medium" — situational TB-flavored, lower for runs context);
  // hard_hit 1.0 (research-validated power signal, matchup pair to D-803 pitcher
  // hard-contact-allowed). All DB-tunable via w_mlb_batter_xwoba etc.
  xwoba: 1.5,
  launchAngle: 0.75,
  sweetSpot: 0.75,
  hardHit: 1.0,
  // D-803 — pitcher hard-contact-allowed (matchup counterpart to D-797 hard_hit).
  // Seed 1.0 provisional. The literal matchup signal: batter hard-hit % ×
  // pitcher hard-hit-allowed % distinguishes TB favorability from generic
  // ERA/WHIP. Tunable via w_mlb_pitcher_hard_contact_allowed.
  pitcherHardContactAllowed: 1.0,
  // D-807 — lineup protection: avg OPS of next 2 hitters batting BEHIND
  // this batter. High-value runs-only signal (drives in runs vs the batter's
  // own contact). Seed 1.5 (intermediate, between OBP at 2.0 and contact factors).
  lineupProtection: 1.5,
  // D-807 — team offense: batter's TEAM OPS_SEASON. High-scoring team →
  // more rallies → more chances to score. Seed 1.0. Distinct from lineup_spot
  // and lineup_protection — captures macro team quality not micro slot context.
  teamOffense: 1.0,
  // D-808 — sprint speed: Baseball Savant baserunning. Fast runners score
  // from 1st on doubles + take extra bases. Seed 1.0 — independent runs
  // signal not captured by any other factor. Bucket ±5/±3/±1 around 27 ft/sec.
  sprintSpeed: 1.0,
  // D-816 / D-818 — pull rate: Baseball Savant batted-ball direction. Pull-air
  // rate is THE HR-prediction signal (pull-heavy fly-ball power profile = HR
  // setup). D-818 raised seed 1.0 → 1.25 (CEO-approved §19.3 per brief):
  // strongest direct HR predictor among new factors, deserves higher weight
  // than the amplifier (pull_x_park_fence=1.0) and the xwoba general signal
  // (when not the dominant HR-specific predictor). Bucket ±5/±3/±1 around
  // 0.20 league-avg pull_air_rate.
  pullRate: 1.25,
  contactRate: 1.5,    // D-824 — hits-only contact-rate factor seed
  // D-817 — pull × pull-side fence interaction. Amplifier on D-816 pull_rate:
  // a high-pull lefty at Yankee Stadium (RF=314ft) gets boosted, same lefty
  // at Comerica RF=330 gets less. Seed 1.0 provisional. HR-only factor.
  pullXParkFence: 1.0,
} as const;
let W_BATTER: { -readonly [K in keyof typeof DEFAULT_W_BATTER]: number } = { ...DEFAULT_W_BATTER };

const LEAGUE_AVG_BA       = 0.245;
const LEAGUE_AVG_OBP      = 0.315;
const LEAGUE_AVG_HR_PA    = 0.030;
const LEAGUE_AVG_ISO      = 0.155;
const LEAGUE_AVG_ERA      = 4.20;
const LEAGUE_AVG_HR_PER_9 = 1.15;
const LEAGUE_AVG_WHIP     = 1.27;

function recentBatterAvg(log: BatterGameLogEntry[], stat: "hits" | "totalBases" | "rbi" | "homeRuns"): number {
  if (log.length === 0) return 0;
  const slice = log.slice(-10);
  const total = slice.reduce((a, g) => a + (g[stat] || 0), 0);
  return total / slice.length;
}

function recentHitRate(log: BatterGameLogEntry[], line: number, side: "over" | "under", stat: "hits" | "totalBases" | "rbi" | "homeRuns"): number {
  return hitRateOverWindow(log.slice(-10), line, side, stat);
}

// D-229 Fix 3 — generic hit-rate calculator for any window size.
function hitRateOverWindow(slice: BatterGameLogEntry[], line: number, side: "over" | "under", stat: "hits" | "totalBases" | "rbi" | "homeRuns"): number {
  if (slice.length === 0) return 0;
  const hits = slice.filter((g) => side === "over" ? g[stat] > line : g[stat] < line).length;
  return (hits / slice.length) * 100;
}

function lineupConsistencyScore(log: BatterGameLogEntry[]): number {
  // Count last10 batting-order slots; if 8+ in same slot or ±1 of mode = stable.
  const slots = log.slice(-10).map((g) => g.battingOrderSlot).filter((s): s is number => typeof s === "number");
  if (slots.length < 5) return 0;
  const counts = new Map<number, number>();
  for (const s of slots) counts.set(s, (counts.get(s) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return 0;
  const topPct = top[1] / slots.length;
  if (topPct >= 0.8)      return 4;   // ironclad in same slot
  if (topPct >= 0.6)      return 2;
  if (topPct <= 0.3)      return -3;  // bouncing around
  return 0;
}

export function scoreBatterHits(ctx: BatterScoringContext): BatterMarketResult {
  return scoreBatterMarket(ctx, "hits");
}
export function scoreBatterTotalBases(ctx: BatterScoringContext): BatterMarketResult {
  return scoreBatterMarket(ctx, "totalBases");
}
export function scoreBatterRbis(ctx: BatterScoringContext): BatterMarketResult {
  return scoreBatterMarket(ctx, "rbi");
}
export function scoreBatterHomeRuns(ctx: BatterScoringContext): BatterMarketResult {
  return scoreBatterMarket(ctx, "homeRuns");
}

// =====================================================================
// D-474 — scoreBatterStrikeouts (Market 1 of D-468 SHIP 4 queue).
//
// Projects per-game batter strikeout count (line typically 0.5 or 1.5).
// Structurally ANTI-correlated with contact markets (hits/total_bases):
// a high-K batter projects HIGH on K markets (good for OVER) while
// projecting LOW on contact. We do NOT reuse contact scorers' direction.
//
// REUSED inputs (5 mapped from existing context):
//   - opp pitcher K rate (kPerNine)          → higher = more K projected
//   - umpire K zone factor (via ballpark.kFactor proxy when umpire null)
//   - ballpark K factor                       → higher = more K
//   - opp pitcher handedness vs batter        → use OPS-vs-hand proxy
//   - lineup spot                             → tail-of-order = more K
//
// NEW factors (2):
//   - score_batter_k_rate (season K/PA)      → primary per-batter signal
//   - score_batter_form_k (last-10 K/PA)     → recent form modifier
//
// Output mirrors existing scorers: 0-100 confidence + breakdown JSON +
// raw_edge. D-467 edge-sign floor applied (negative edge → conf ≤69 →
// template fallback below Sonnet gate; calibration consistent with
// other markets per D-466 → D-467 arc).
//
// D-140 trivial-line cap also applies (uses prop.line + odds gate).
// =====================================================================
export function scoreBatterStrikeouts(ctx: BatterScoringContext): BatterMarketResult {
  const { season, gameLog, opposingPitcher, ballpark, prop } = ctx;
  const sideFlip = prop.pickSide === "under" ? -1 : 1;

  // === BASE PROJECTION ============================================
  // Per-PA K rate × projected PAs (~4 PA/game ≈ league avg).
  // Use direct K/game from gameLog when available (more accurate than
  // K/PA × 4 because PA varies with lineup spot + opponent).
  const PROJECTED_PA = 4.0;
  const seasonKPerGame = season.gamesPlayed > 0 ? season.strikeOuts / season.gamesPlayed : 0;
  const seasonKPerPA = season.plateAppearances > 0 ? season.strikeOuts / season.plateAppearances : 0;
  const last10 = gameLog.slice(-10);
  const recentKPerGame = last10.length > 0
    ? last10.reduce((a, g) => a + g.strikeOuts, 0) / last10.length
    : 0;

  // Blended baseline: 55% recent, 45% season (mirrors existing batter scorers).
  const blendedKPerGame = recentKPerGame > 0
    ? 0.55 * recentKPerGame + 0.45 * seasonKPerGame
    : seasonKPerGame;

  // Pitcher K-rate adjustment: K/9 above league avg (~8.6) boosts batter K projection.
  const oppKPerNine = opposingPitcher?.kPerNine ?? LEAGUE_AVG_K_PER_NINE;
  const pitcherKAdj = clamp(oppKPerNine / LEAGUE_AVG_K_PER_NINE, 0.80, 1.30);

  // Ballpark K factor (parks with high K rate boost batter K projection too).
  const parkKAdj = ballpark ? clamp(ballpark.kFactor, 0.85, 1.20) : 1.0;

  const projectedStat = blendedKPerGame * pitcherKAdj * parkKAdj;
  const edge = (projectedStat - prop.line) * sideFlip;

  // === BASE CONFIDENCE ============================================
  // 6× multiplier matches pitcher_strikeouts (line 235 in this file)
  // — comparable per-game K count scale.
  let confidence = 50 + edge * 6;

  // === FACTOR: score_batter_k_rate (NEW) =========================
  // Season K/PA z-score vs league avg ~0.225. Positive (high K) boosts
  // OVER confidence; negative (low K) boosts UNDER confidence.
  let f_batterKRate = 0;
  const leagueAvgKPerPA = 0.225;
  const sigmaKPerPA = 0.05;
  if (seasonKPerPA > 0 && season.plateAppearances >= 100) {
    const z = (seasonKPerPA - leagueAvgKPerPA) / sigmaKPerPA;
    if (z >= 1.5)      f_batterKRate = 10;
    else if (z >= 1.0) f_batterKRate = 6;
    else if (z >= 0.5) f_batterKRate = 3;
    else if (z <= -1.5) f_batterKRate = -10;
    else if (z <= -1.0) f_batterKRate = -6;
    else if (z <= -0.5) f_batterKRate = -3;
  }
  f_batterKRate *= sideFlip;
  // Starting weight 2.0 — primary per-batter signal for K market.
  // Gut-reasoned (CEO preference). DB-tunable later via w_mlb_batter_k_rate.
  const score_batter_k_rate = roundHalfAwayFromZero(f_batterKRate * 2.0);

  // === FACTOR: score_batter_form_k (NEW) ==========================
  // Last-10 K rate vs season K rate. Recent uptick → more K projected.
  let f_batterFormK = 0;
  if (last10.length >= 5 && seasonKPerGame > 0) {
    const diff = recentKPerGame - seasonKPerGame;
    if (diff >= 0.40) f_batterFormK = 6;
    else if (diff >= 0.20) f_batterFormK = 3;
    else if (diff <= -0.40) f_batterFormK = -6;
    else if (diff <= -0.20) f_batterFormK = -3;
  }
  f_batterFormK *= sideFlip;
  const score_batter_form_k = roundHalfAwayFromZero(f_batterFormK * 1.5);

  // === REUSED FACTORS =============================================
  // score_pitcher_k_rate: opposing pitcher K/9 z-score (high → batter K up).
  let f_pitcherK = 0;
  if (opposingPitcher && opposingPitcher.kPerNine > 0) {
    const z = (opposingPitcher.kPerNine - LEAGUE_AVG_K_PER_NINE) / 1.5;
    if (z >= 1.5)      f_pitcherK = 10;
    else if (z >= 1.0) f_pitcherK = 7;
    else if (z >= 0.5) f_pitcherK = 4;
    else if (z <= -1.5) f_pitcherK = -10;
    else if (z <= -1.0) f_pitcherK = -7;
    else if (z <= -0.5) f_pitcherK = -4;
  }
  f_pitcherK *= sideFlip;
  const score_pitcher_k_rate = roundHalfAwayFromZero(f_pitcherK * 1.5);

  // score_ballpark_factor (K factor): parks like Coors (low) vs SF (high).
  let f_park = 0;
  if (ballpark) {
    if (ballpark.kFactor >= 1.10) f_park = 4;
    else if (ballpark.kFactor >= 1.05) f_park = 2;
    else if (ballpark.kFactor <= 0.90) f_park = -4;
    else if (ballpark.kFactor <= 0.95) f_park = -2;
  }
  f_park *= sideFlip;
  const score_ballpark_factor = roundHalfAwayFromZero(f_park * 0.8);

  // score_lineup_spot: tail-of-order batters K more (higher PA gap + worse hitters).
  let f_lineup = 0;
  const lineupSpot = ctx.lineupSpot ?? null;
  if (lineupSpot !== null) {
    if (lineupSpot >= 8) f_lineup = 3;
    else if (lineupSpot >= 6) f_lineup = 1;
    else if (lineupSpot <= 2) f_lineup = -2;
  }
  f_lineup *= sideFlip;
  const score_lineup_spot = roundHalfAwayFromZero(f_lineup * 1.0);

  // score_hand_matchup: hand-split OPS as proxy (lower OPS vs this hand = more K vulnerability).
  let f_hand = 0;
  if (ctx.splits && opposingPitcher?.throws) {
    const ops = opposingPitcher.throws === "L" ? ctx.splits.vs_lhp_ops : ctx.splits.vs_rhp_ops;
    if (ops !== null && ops > 0) {
      // Low OPS vs this hand → batter struggles → more K projected (positive on OVER).
      if (ops <= 0.600) f_hand = 5;
      else if (ops <= 0.700) f_hand = 2;
      else if (ops >= 0.900) f_hand = -3;
      else if (ops >= 0.800) f_hand = -1;
    }
  }
  f_hand *= sideFlip;
  const score_hand_matchup = roundHalfAwayFromZero(f_hand * 1.0);

  // === D-598 FACTOR: score_opp_pitcher_pitchtype_quality (K-framing) ===
  // batter_strikeouts is the ONE batter market where high opp PA HELPS
  // the over (more put-away pitches in the arsenal → more Ks for the
  // batter). Sign matches D-596 pitcher_k directly (NOT inverted like
  // the contact markets below). Same PA_MEAN / PA_SD as D-596.
  let f_oppPitcherPitchTypeQuality = 0;
  const oppArsenal_K = ctx.opposingPitcherArsenal ?? null;
  if (oppArsenal_K && typeof oppArsenal_K.expected_put_away === "number" && oppArsenal_K.expected_put_away > 0) {
    const PA_MEAN = 19.37; const PA_SD = 4.76;
    const z = (oppArsenal_K.expected_put_away - PA_MEAN) / PA_SD;
    if (z >= 1.5)       f_oppPitcherPitchTypeQuality = 8;
    else if (z >= 0.75) f_oppPitcherPitchTypeQuality = 5;
    else if (z >= 0.25) f_oppPitcherPitchTypeQuality = 2;
    else if (z <= -1.5) f_oppPitcherPitchTypeQuality = -8;
    else if (z <= -0.75) f_oppPitcherPitchTypeQuality = -5;
    else if (z <= -0.25) f_oppPitcherPitchTypeQuality = -2;
  }
  f_oppPitcherPitchTypeQuality *= sideFlip;
  const score_opp_pitcher_pitchtype_quality = roundHalfAwayFromZero(f_oppPitcherPitchTypeQuality * W_BATTER.oppPitcherPitchTypeQuality);

  // === AGGREGATE ==================================================
  confidence += score_batter_k_rate + score_batter_form_k + score_pitcher_k_rate
              + score_ballpark_factor + score_lineup_spot + score_hand_matchup
              + score_opp_pitcher_pitchtype_quality;
  confidence = clamp(Math.round(confidence), 0, 100);

  // === D-467 EDGE-SIGN FLOOR ======================================
  // If projection contradicts pick direction (edge<0), cap at 69 so the
  // pick falls below Sonnet gate. Consistent with the calibration fix
  // applied to the other markets in D-467.
  let d467_edge_floor_delta = 0;
  if (edge < 0 && confidence > 69) {
    d467_edge_floor_delta = confidence - 69;
    confidence = 69;
  }

  const confidence_pre_cap = confidence;

  // === D-140 TRIVIAL-LINE CAP (uniform with other batter markets) ==
  if (prop.line <= 0.5 && Math.abs(prop.odds) >= 200 && confidence > 65) {
    confidence = 65;
  }

  // === D-479 LONGSHOT OVER CAP (uniform structural rule) ===========
  // Sibling of D-140. GOOD-tier OVER at +100-or-longer odds → cap 65.
  if (prop.pickSide === "over" && prop.odds >= 100
      && confidence >= 70 && confidence <= 79) {
    confidence = 65;
  }

  // === D-509 ELITE/STRONG LONGSHOT OVER CAP (sibling of D-479) =====
  // batter_strikeouts is in the bleed cluster — no carve-out. See
  // scorePitcherStrikeouts header (line 534) for full rationale.
  if (prop.pickSide === "over" && confidence >= 80 && prop.odds >= 150) {
    confidence = 75;
  }

  // === SANITY FLAGS (mirror existing batter scorers) ===============
  let unbettableJuiceFlag = false;
  if (prop.pickSide === "under") {
    if (confidence >= 90 && prop.odds <= -350)      unbettableJuiceFlag = true;
    else if (confidence >= 80 && prop.odds <= -300) unbettableJuiceFlag = true;
    else if (confidence >= 70 && prop.odds <= -250) unbettableJuiceFlag = true;
    else if (confidence >= 60 && prop.odds <= -200) unbettableJuiceFlag = true;
  }

  // === HIT RATES (per-row display + audit) =========================
  function hitRate(window: BatterGameLogEntry[]): number {
    if (window.length === 0) return 0;
    const hits = window.filter((g) =>
      prop.pickSide === "over" ? g.strikeOuts > prop.line : g.strikeOuts < prop.line,
    ).length;
    return (hits / window.length) * 100;
  }
  const last5HitRate = hitRate(gameLog.slice(-5));
  const last10HitRate = hitRate(last10);
  const seasonHitRate = hitRate(gameLog);
  const coinFlipFlag = confidence >= 80 && last10HitRate >= 40 && last10HitRate <= 60;

  const factorArr = [
    score_batter_k_rate, score_batter_form_k, score_pitcher_k_rate,
    score_ballpark_factor, score_lineup_spot, score_hand_matchup,
    // D-598
    score_opp_pitcher_pitchtype_quality,
  ];
  const negativeFactorCount = factorArr.filter((v) => v < 0).length;
  const negativeStackingFlag = confidence >= 80 && negativeFactorCount >= 3;

  const verdict = getScoreLabel(confidence);

  const breakdown: Record<string, number | string | boolean | null> = {
    market_stat: "strikeouts",
    pick_side: prop.pickSide,
    bats: season.bats,
    raw_edge: Math.round(edge * 100) / 100,
    projected_stat: Math.round(projectedStat * 100) / 100,
    blended_k_per_game: Math.round(blendedKPerGame * 100) / 100,
    season_k_per_game: Math.round(seasonKPerGame * 100) / 100,
    season_k_per_pa: Math.round(seasonKPerPA * 1000) / 1000,
    recent_k_per_game: Math.round(recentKPerGame * 100) / 100,
    season_games: season.gamesPlayed,
    last5_hit_rate_pct: Math.round(last5HitRate),
    last10_hit_rate_pct: Math.round(last10HitRate),
    season_hit_rate_pct: Math.round(seasonHitRate),
    opp_pitcher_k_per_nine: opposingPitcher?.kPerNine ?? null,
    park_k_factor: ballpark?.kFactor ?? null,
    lineup_spot: lineupSpot,
    score_batter_k_rate,
    score_batter_form_k,
    score_pitcher_k_rate,
    score_ballpark_factor,
    score_lineup_spot,
    score_hand_matchup,
    // D-598 — opposing pitcher pitch-type matchup (K-framing: same sign as D-596)
    score_opp_pitcher_pitchtype_quality,
    opp_pitcher_id: ctx.opposingPitcherId ?? null,
    opp_pitcher_expected_put_away: oppArsenal_K?.expected_put_away ?? null,
    opp_pitcher_expected_whiff_pct: oppArsenal_K?.expected_whiff_pct ?? null,
    d467_edge_floor_applied: d467_edge_floor_delta > 0,
    v1_algo: "D-474 6-factor batter strikeouts (season+form K rate + opp pitcher K/9 + park K + lineup + hand) + D-598 opp_pitcher_pitchtype_quality",
  };

  // D-474 — return shape mirrors BatterMarketResult contract: confidence
  // + verdict + projection + edge + score_* fields. Contact-specific scores
  // (hit_rate, power_rate, hr_rate, etc.) are zeroed because they don't
  // apply to K market. K-specific scores live in `breakdown` for audit/UI.
  return {
    confidence,
    confidence_pre_cap,
    confidence_pre_tier_aware: confidence,
    verdict,
    projectedStat: Math.round(projectedStat * 100) / 100,
    seasonAvg: Math.round(seasonKPerGame * 100) / 100,
    recentAvg: Math.round(recentKPerGame * 100) / 100,
    edge: Math.round(edge * 100) / 100,
    // Contact-batter factor scores — N/A for K market; zero per interface
    // contract. The K-specific score_batter_k_rate / score_batter_form_k
    // / score_pitcher_k_rate / etc. are persisted in `breakdown` above.
    score_batter_hit_rate: 0,
    score_batter_form: 0,
    score_opposing_pitcher_quality: 0,
    score_recent_at_bats: 0,
    score_handedness_matchup: score_hand_matchup,  // K-market uses its own hand factor; expose under contact name for parity
    score_ballpark_factor,                          // K-park factor; same field name as contact markets
    score_weather_temp: 0,
    score_lineup_consistency: 0,
    score_batter_power_rate: 0,
    score_batter_form_power: 0,
    score_pitcher_hr_rate: 0,
    score_weather_wind: 0,
    score_lineup_spot,                              // shared with contact markets
    score_day_after_night_fatigue: 0,
    score_travel_getaway: 0,
    score_pitcher_baa_vs_hand: 0,
    score_hitter_streak_fatigue: 0,
    score_batter_line_hit_rate: 0,
    // D-598 — opposing pitcher pitch-type matchup factor (K-side).
    score_opp_pitcher_pitchtype_quality,
    // D-785 — 8 columns previously in breakdown only. K market doesn't compute
    // any of them (the Statcast + bullpen factors are for contact / runs), so 0.
    score_batter_obp: 0,
    score_recent_run_form: 0,
    score_bullpen_quality: 0,
    score_batter_xba: 0,
    score_batter_exit_velo_trend: 0,
    score_batter_barrel_rate: 0,
    score_batter_xslg_regression: 0,
    score_batter_vs_pitcher_hand_split: 0,
    // D-797 — interface-contract zeros (strikeouts market doesn't use these).
    score_batter_babip: 0,
    score_batter_xwoba: 0,
    score_batter_launch_angle: 0,
    score_batter_sweet_spot: 0,
    score_batter_hard_hit: 0,
    // D-803 — interface contract; strikeouts market doesn't use pitcher hard-contact.
    score_pitcher_hard_contact_allowed: 0,
    // D-807 — interface contract; strikeouts market doesn't use runs-specific factors.
    score_batter_lineup_protection: 0,
    score_batter_team_offense: 0,
    // D-808 — interface contract; strikeouts market doesn't use baserunning.
    score_batter_sprint_speed: 0,
    // D-816 — interface contract; strikeouts market doesn't use pull rate (HR-only).
    score_batter_pull_rate: 0,
    score_batter_contact_rate: 0,
    // D-817 — interface contract; strikeouts doesn't use pull × fence (HR-only).
    score_batter_pull_x_park_fence: 0,
    unbettableJuiceFlag,
    unbettableOverBreakevenFlag: false,
    coinFlipFlag,
    negativeStackingFlag,
    negativeFactorCount,
    breakdown,
  };
}

// =====================================================================
// D-475 — scoreBatterRunsScored (Market 2 of D-468 SHIP 4 queue).
//
// Projects per-game runs scored by batter (line typically 0.5 — does
// batter cross home plate this game?). R ≠ RBI: R = batter crosses
// home (via subsequent batters' hits / his own HR); RBI = drives in.
// Different chain so we do NOT reuse the RBI scorer's direction blindly.
//
// REUSED inputs (4 mapped from existing context):
//   - opposing pitcher quality (ERA)         → worse pitcher → more runs
//   - ballpark runs factor                   → hitter-friendly park
//   - lineup spot                            → top-of-order = more PAs +
//                                               more chances to score
//   - opposing bullpen quality                → weak pen → more late-inning R
//
// NEW factors (2 with real data — 3rd deferred):
//   - score_batter_obp (NEW)                 → on-base % is the gate to scoring
//   - score_recent_run_form (NEW)            → last-10 R/game vs season R/game
//   - DEFERRED: team OBP downstream (the batters AFTER this one drive him
//     in). Would need lineup-position-aware team OBP fetch — currently
//     not in cache. Flagged as data-fetch sub-task.
//   - DEFERRED: late-inning offense. Not in cache.
//
// Output mirrors existing scorers: 0-100 confidence + breakdown JSON +
// raw_edge. D-467 edge-sign floor applied (negative edge → conf ≤69).
// D-140 trivial-line cap also applies.
// =====================================================================
export function scoreBatterRunsScored(ctx: BatterScoringContext): BatterMarketResult {
  const { season, gameLog, opposingPitcher, ballpark, prop, weather } = ctx;
  const sideFlip = prop.pickSide === "under" ? -1 : 1;

  // === BASE PROJECTION ============================================
  // Per-game R rate. Direct R/game from gameLog when available
  // (more accurate than R/PA × PA projection).
  const seasonRPerGame = season.gamesPlayed > 0 ? season.runs / season.gamesPlayed : 0;
  const last10 = gameLog.slice(-10);
  const recentRPerGame = last10.length > 0
    ? last10.reduce((a, g) => a + g.runs, 0) / last10.length
    : 0;

  // Blended baseline: 55% recent, 45% season (mirrors batter scorers).
  const blendedRPerGame = recentRPerGame > 0
    ? 0.55 * recentRPerGame + 0.45 * seasonRPerGame
    : seasonRPerGame;

  // Opposing pitcher quality: worse ERA → batter scores more.
  let pitcherAdj = 1.0;
  if (opposingPitcher && opposingPitcher.era > 0) {
    pitcherAdj = clamp(opposingPitcher.era / LEAGUE_AVG_ERA, 0.80, 1.25);
  }

  // Ballpark runs factor: high-run parks (Coors etc.) → more R.
  const parkAdj = ballpark ? clamp(ballpark.runsFactor, 0.85, 1.20) : 1.0;

  const projectedStat = blendedRPerGame * pitcherAdj * parkAdj;
  const edge = (projectedStat - prop.line) * sideFlip;

  // === BASE CONFIDENCE ============================================
  // Use 8× multiplier — R scale is smaller than total_bases but larger
  // than RBI; 8× falls between RBI (6×) and hits (10×).
  let confidence = 50 + edge * 8;

  // === FACTOR: score_batter_obp (NEW — primary on-base signal) ===
  // OBP z-score vs league avg 0.320 (σ=0.025). Top OBP = +10, bottom = -10.
  let f_obp = 0;
  const leagueAvgOBP = 0.320;
  const sigmaOBP = 0.025;
  if (season.obp > 0 && season.plateAppearances >= 100) {
    const z = (season.obp - leagueAvgOBP) / sigmaOBP;
    if (z >= 1.5)      f_obp = 10;
    else if (z >= 1.0) f_obp = 6;
    else if (z >= 0.5) f_obp = 3;
    else if (z <= -1.5) f_obp = -10;
    else if (z <= -1.0) f_obp = -6;
    else if (z <= -0.5) f_obp = -3;
  }
  f_obp *= sideFlip;
  // Starting weight 2.0 — OBP is the gate to scoring (must get on base first).
  // Gut-reasoned per CEO preference. DB-tunable via w_mlb_batter_obp later.
  const score_batter_obp = roundHalfAwayFromZero(f_obp * 2.0);

  // === FACTOR: score_recent_run_form (NEW) =======================
  // Last-10 R/game vs season R/game. Recent uptick → more R projected.
  // D-646 SHIP 3 — gate widened. Pre-D-646 (≥0.15 ±3, ≥0.30 ±6) left
  // 36.4% of picks in the 0.05-0.15 borderline range firing at 0 — half
  // a run per 6-7 games is a meaningful trend in baseball, not noise.
  // Lowered the ±3 threshold to ≥0.10 (one extra run every ~10 games),
  // keeping ±6 at ≥0.30 unchanged. ~16.6% more picks now fire at ±3
  // (post-D-645 dist: 16.6% in 0.10-0.15 band moves from 0 → ±3).
  // Score magnitudes (±3, ±6) unchanged; weight 1.5 unchanged. Pure
  // gate widening per D-646 spec.
  let f_runForm = 0;
  if (last10.length >= 5 && seasonRPerGame > 0) {
    const diff = recentRPerGame - seasonRPerGame;
    if (diff >= 0.30) f_runForm = 6;
    else if (diff >= 0.10) f_runForm = 3;
    else if (diff <= -0.30) f_runForm = -6;
    else if (diff <= -0.10) f_runForm = -3;
  }
  f_runForm *= sideFlip;
  const score_recent_run_form = roundHalfAwayFromZero(f_runForm * 1.5);

  // === REUSED FACTORS =============================================
  // score_opposing_pitcher_quality: ERA z-score (high → batter scores more).
  let f_pitcherQ = 0;
  if (opposingPitcher && opposingPitcher.era > 0) {
    const z = (opposingPitcher.era - LEAGUE_AVG_ERA) / 1.0;
    if (z >= 1.5)      f_pitcherQ = 8;
    else if (z >= 1.0) f_pitcherQ = 5;
    else if (z >= 0.5) f_pitcherQ = 2;
    else if (z <= -1.5) f_pitcherQ = -8;
    else if (z <= -1.0) f_pitcherQ = -5;
    else if (z <= -0.5) f_pitcherQ = -2;
  }
  f_pitcherQ *= sideFlip;
  const score_opposing_pitcher_quality = roundHalfAwayFromZero(f_pitcherQ * 1.5);

  // score_ballpark_factor (runs factor): high-run parks boost.
  // D-646 SHIP 1 — gate widened. Pre-D-646 (1.10/1.05 ↔ 0.90/0.95) put
  // 87% of MLB parks (26 of 30) inside the dead zone 0.95-1.05 — the
  // factor fired on only 8.7% of RS picks per D-645 audit. Live parks'
  // actual runs_factor range is 0.931-1.118 (mean ~1.00, std ~0.04);
  // so a ±5% dead-zone band wipes most of the real signal. Tightening
  // the dead zone to ±2% (0.98-1.02) means the factor now fires on
  // ~77% of parks, including: Globe Life Field (1.047, +2), Yankee
  // Stadium (1.039, +2), Fenway (1.028, +2), Wrigley (1.022, +2), and
  // suppressors Busch (0.994, -2), Comerica (0.993, -2), Target (0.989,
  // -2), and 10 more. Score magnitudes (±2, ±4) unchanged; weight 1.0
  // unchanged. Pure gate widening.
  let f_park = 0;
  if (ballpark) {
    if (ballpark.runsFactor >= 1.05) f_park = 4;
    else if (ballpark.runsFactor >= 1.02) f_park = 2;
    else if (ballpark.runsFactor <= 0.95) f_park = -4;
    else if (ballpark.runsFactor <= 0.98) f_park = -2;
  }
  f_park *= sideFlip;
  const score_ballpark_factor = roundHalfAwayFromZero(f_park * 1.0);

  // score_lineup_spot: top-of-order scores more (more PAs + driven in
  // by middle-of-order power). Mirror the strikeouts lineup factor
  // but INVERTED (tail-of-order = LOWER run probability, not higher).
  let f_lineup = 0;
  const lineupSpot = ctx.lineupSpot ?? null;
  if (lineupSpot !== null) {
    if (lineupSpot <= 2) f_lineup = 4;        // 1-2 hole: lots of PAs + driven in
    else if (lineupSpot <= 4) f_lineup = 2;   // 3-4 hole: middle power
    else if (lineupSpot >= 8) f_lineup = -3;  // 8-9: fewer PAs + weakest hitters in front of them
    else if (lineupSpot >= 6) f_lineup = -1;
  }
  f_lineup *= sideFlip;
  const score_lineup_spot = roundHalfAwayFromZero(f_lineup * 1.0);

  // score_bullpen_quality: weak pen → more late-inning runs (batter can come
  // around again in the 6th-9th). Already used in batter HR scorer.
  let f_bullpen = 0;
  if (ctx.opposingBullpen?.bullpen_era !== null && ctx.opposingBullpen?.bullpen_era !== undefined) {
    const bpEra = ctx.opposingBullpen.bullpen_era;
    if (bpEra >= 5.0) f_bullpen = 4;
    else if (bpEra >= 4.5) f_bullpen = 2;
    else if (bpEra <= 3.0) f_bullpen = -4;
    else if (bpEra <= 3.5) f_bullpen = -2;
  }
  f_bullpen *= sideFlip;
  const score_bullpen_quality = roundHalfAwayFromZero(f_bullpen * 0.75);

  // === D-598 FACTOR: score_opp_pitcher_pitchtype_quality (R-framing) ===
  // batter_runs_scored is offense-positive: tough opp arsenal (high
  // expected_put_away) makes the batter less likely to reach base
  // and come around → SUPPRESS over (negative on OVER). Same sign as
  // contact markets (hits/TB/HR/RBI) — inverse of D-596 pitcher_k.
  let f_oppPitcherPitchTypeQuality = 0;
  const oppArsenal_R = ctx.opposingPitcherArsenal ?? null;
  if (oppArsenal_R && typeof oppArsenal_R.expected_put_away === "number" && oppArsenal_R.expected_put_away > 0) {
    const PA_MEAN = 19.37; const PA_SD = 4.76;
    const z = (oppArsenal_R.expected_put_away - PA_MEAN) / PA_SD;
    if (z >= 1.5)       f_oppPitcherPitchTypeQuality = -8;
    else if (z >= 0.75) f_oppPitcherPitchTypeQuality = -5;
    else if (z >= 0.25) f_oppPitcherPitchTypeQuality = -2;
    else if (z <= -1.5) f_oppPitcherPitchTypeQuality = 8;
    else if (z <= -0.75) f_oppPitcherPitchTypeQuality = 5;
    else if (z <= -0.25) f_oppPitcherPitchTypeQuality = 2;
  }
  f_oppPitcherPitchTypeQuality *= sideFlip;
  const score_opp_pitcher_pitchtype_quality = roundHalfAwayFromZero(f_oppPitcherPitchTypeQuality * W_BATTER.oppPitcherPitchTypeQuality);

  // ════════════════════════════════════════════════════════════════
  // D-658 — wire 11 batter factors that already compute correctly in
  // scoreBatterMarket (hits/HR/TB/RBI) but were never connected to
  // scoreBatterRunsScored. Per D-656 diagnose, runs_scored fired on
  // median 5 factors at ELITE vs 12-15 for broad scorers — this was
  // a wiring gap, not a confidence-math bug. Each factor's bucketing
  // mirrors scoreBatterMarket's identical block (line refs below).
  // Weights pull from algorithm_weights via W_BATTER.* — same as
  // scoreBatterMarket — so the D-682 optimizer can re-tune in place.
  //
  // PROVISIONAL CALIBRATION NOTE: post-D-658 max factor contribution
  // grows from ~60pp (7 factors) to ~130pp (18 factors). Most picks
  // won't max all 18, but the OBP-dominated ELITE risk D-656 named
  // shrinks proportionally — OBP +20 was 33% of max factor sum; now
  // it's 15%. D-682 optimizer pass will recalibrate weights on
  // post-wire pick outcomes.

  // [scoreBatterMarket:2154-2163] hit_rate (season BA vs league .245)
  let f_hitRate_v2 = 0;
  {
    const diff = season.battingAvg - LEAGUE_AVG_BA;
    if (diff >= 0.040)       f_hitRate_v2 = 10;
    else if (diff >= 0.020)  f_hitRate_v2 = 6;
    else if (diff >= 0.010)  f_hitRate_v2 = 3;
    else if (diff <= -0.040) f_hitRate_v2 = -10;
    else if (diff <= -0.020) f_hitRate_v2 = -6;
    else if (diff <= -0.010) f_hitRate_v2 = -3;
  }
  f_hitRate_v2 *= sideFlip;
  const score_batter_hit_rate = roundHalfAwayFromZero(f_hitRate_v2 * W_BATTER.hitRate);

  // [scoreBatterMarket:2176-2188] babip (regression signal)
  let f_babip_v2 = 0;
  if (season.babip > 0) {
    const babipDiff = season.babip - 0.300;
    if (babipDiff >= 0.060)        f_babip_v2 = -5;
    else if (babipDiff >= 0.030)   f_babip_v2 = -3;
    else if (babipDiff >= 0.015)   f_babip_v2 = -1;
    else if (babipDiff <= -0.060)  f_babip_v2 = 5;
    else if (babipDiff <= -0.030)  f_babip_v2 = 3;
    else if (babipDiff <= -0.015)  f_babip_v2 = 1;
  }
  f_babip_v2 *= sideFlip;
  const score_batter_babip = roundHalfAwayFromZero(f_babip_v2 * W_BATTER.babip);

  // [scoreBatterMarket:2196-2207] power_rate (HR/PA, ISO)
  let f_powerRate_v2 = 0;
  {
    const hrPerPA = season.hrPerPA;
    const iso = season.iso;
    let mag = 0;
    if (hrPerPA >= LEAGUE_AVG_HR_PA * 1.6)       mag += 6;
    else if (hrPerPA >= LEAGUE_AVG_HR_PA * 1.3)  mag += 4;
    else if (hrPerPA >= LEAGUE_AVG_HR_PA * 1.1)  mag += 2;
    else if (hrPerPA <= LEAGUE_AVG_HR_PA * 0.5)  mag -= 6;
    else if (hrPerPA <= LEAGUE_AVG_HR_PA * 0.75) mag -= 3;
    if (iso >= LEAGUE_AVG_ISO * 1.5)             mag += 2;
    else if (iso <= LEAGUE_AVG_ISO * 0.6)        mag -= 2;
    f_powerRate_v2 = clamp(mag, -10, 10);
  }
  f_powerRate_v2 *= sideFlip;
  const score_batter_power_rate = roundHalfAwayFromZero(f_powerRate_v2 * W_BATTER.powerRate);

  // [scoreBatterMarket:2215-2228] form + form_power (last10 game avg vs season)
  let f_form_v2 = 0;
  const seasonAvgPerGame_runs = season.gamesPlayed > 0 ? season.runs / season.gamesPlayed : 0;
  if (gameLog.length >= 5 && seasonAvgPerGame_runs > 0) {
    const delta = recentRPerGame - seasonAvgPerGame_runs;
    const scale = 0.5;
    // D-689 widened: added 0.25*scale band (=±0.125 runs/game L10 vs season).
    // Pre-D-689 ~16% fire (rbis form_power 23.8%); new mild bucket catches the
    // normal-trend zone. Extremes (8/-8) preserved.
    if (delta >= 2 * scale)       f_form_v2 = 8;
    else if (delta >= 1 * scale)  f_form_v2 = 4;
    else if (delta >= 0.5 * scale) f_form_v2 = 2;
    else if (delta >= 0.25 * scale) f_form_v2 = 1;
    else if (delta <= -2 * scale) f_form_v2 = -8;
    else if (delta <= -1 * scale) f_form_v2 = -4;
    else if (delta <= -0.5 * scale) f_form_v2 = -2;
    else if (delta <= -0.25 * scale) f_form_v2 = -1;
  }
  f_form_v2 *= sideFlip;
  const score_batter_form = roundHalfAwayFromZero(f_form_v2 * W_BATTER.form);
  // form_power = same magnitude × W_BATTER.formPower (parallel to scoreBatterMarket:2228)
  const score_batter_form_power = roundHalfAwayFromZero(f_form_v2 * W_BATTER.formPower);

  // [scoreBatterMarket:2275-2282] recent_at_bats (PA volume trend)
  let f_recentAB_v2 = 0;
  if (gameLog.length >= 5) {
    const last5PA = gameLog.slice(-5).reduce((a, g) => a + (g.plateAppearances || g.atBats || 0), 0) / 5;
    if (last5PA >= 4.5)      f_recentAB_v2 = 3;
    else if (last5PA >= 4.0) f_recentAB_v2 = 1;
    else if (last5PA <= 2.5) f_recentAB_v2 = -3;
    else if (last5PA <= 3.0) f_recentAB_v2 = -1;
  }
  f_recentAB_v2 *= sideFlip;
  const score_batter_recent_at_bats = roundHalfAwayFromZero(f_recentAB_v2 * W_BATTER.recentAB);

  // [scoreBatterMarket:2524-2551] Statcast xBA + exit_velo_trend
  const sc_v2 = ctx.statcast ?? null;
  let score_batter_xba = 0;
  let score_batter_exit_velo_trend = 0;
  let score_batter_barrel_rate = 0;
  let score_batter_xslg_regression = 0;
  if (sc_v2) {
    if (sc_v2.est_ba !== null) {
      let f_xba = 0;
      const xba_diff = sc_v2.est_ba - LEAGUE_AVG_BA;
      if (xba_diff >= 0.040)        f_xba = 6;
      else if (xba_diff >= 0.020)   f_xba = 3;
      else if (xba_diff >= 0.010)   f_xba = 1;
      else if (xba_diff <= -0.040)  f_xba = -6;
      else if (xba_diff <= -0.020)  f_xba = -3;
      else if (xba_diff <= -0.010)  f_xba = -1;
      score_batter_xba = roundHalfAwayFromZero(f_xba * sideFlip * W_BATTER.xba);
    }
    if (sc_v2.avg_hit_speed !== null) {
      let f_evt = 0;
      const avgHit = sc_v2.avg_hit_speed;
      if (avgHit >= 93)      f_evt = 6;
      else if (avgHit >= 91) f_evt = 3;
      else if (avgHit >= 89) f_evt = 0;
      else if (avgHit >= 87) f_evt = -2;
      else                   f_evt = -5;
      score_batter_exit_velo_trend = roundHalfAwayFromZero(f_evt * sideFlip * W_BATTER.exitVeloTrend);
    }
    // Barrel + xSLG: per scoreBatterMarket these are isPowerMarket-gated.
    // For runs_scored: extra-base hits → runs (HR = auto run). Apply.
    if (sc_v2.brl_pa !== null) {
      let f_barrel = 0;
      const brlPa = sc_v2.brl_pa;
      if (brlPa >= 12)      f_barrel = 8;
      else if (brlPa >= 9)  f_barrel = 5;
      else if (brlPa >= 6)  f_barrel = 2;
      else if (brlPa >= 3)  f_barrel = -2;
      else                  f_barrel = -5;
      score_batter_barrel_rate = roundHalfAwayFromZero(f_barrel * sideFlip * W_BATTER.barrelRate);
    }
    if (sc_v2.est_slg_minus_slg_diff !== null) {
      let f_xslg = 0;
      const diff = sc_v2.est_slg_minus_slg_diff;
      if (diff >= 0.030)        f_xslg = 4;
      else if (diff >= 0.015)   f_xslg = 2;
      else if (diff <= -0.030)  f_xslg = -4;
      else if (diff <= -0.015)  f_xslg = -2;
      score_batter_xslg_regression = roundHalfAwayFromZero(f_xslg * sideFlip * W_BATTER.xslgRegression);
    }
  }

  // [scoreBatterMarket:2592-2632] batter_vs_pitcher_hand_split.
  // For runs_scored we follow the "hits" branch (BA-based comparison) —
  // runs_scored is contact-flavored: batter has to reach base before
  // anything scores. Power-side split would over-emphasize HR-scoring.
  let f_handSplit_v2 = 0;
  const splits_v2 = ctx.splits ?? null;
  const pitcherHand_v2 = opposingPitcher?.throws ?? null;
  if (splits_v2 && pitcherHand_v2 && season.gamesPlayed > 0) {
    let splitStat: number | null = null;
    let splitPa: number | null = null;
    const overallStat = season.battingAvg;
    if (pitcherHand_v2 === "L") {
      splitPa = splits_v2.vs_lhp_pa;
      splitStat = splits_v2.vs_lhp_avg;
    } else if (pitcherHand_v2 === "R") {
      splitPa = splits_v2.vs_rhp_pa;
      splitStat = splits_v2.vs_rhp_avg;
    }
    if (splitStat !== null && overallStat > 0 && (splitPa ?? 0) >= 30) {
      const delta = splitStat - overallStat;
      if (delta >= 0.080)        f_handSplit_v2 = 6;
      else if (delta >= 0.040)   f_handSplit_v2 = 3;
      else if (delta >= 0.020)   f_handSplit_v2 = 1;
      else if (delta <= -0.080)  f_handSplit_v2 = -6;
      else if (delta <= -0.040)  f_handSplit_v2 = -3;
      else if (delta <= -0.020)  f_handSplit_v2 = -1;
    }
  }
  f_handSplit_v2 *= sideFlip;
  const score_batter_vs_pitcher_hand_split = roundHalfAwayFromZero(f_handSplit_v2 * W_BATTER.vsPitcherHandSplit);

  // ============================================================
  // D-806 — Cross-apply 5 high-value factors from scoreBatterMarket into
  // scoreBatterRunsScored. The D-803 audit found these were hardcoded 0
  // in the runs_scored return statement despite being relevant: xwoba is
  // the primary offense predictor; hard_hit + pitcher_hard_contact_allowed
  // are the matchup-side power signals (HRs auto-score 1 run); pitcher_gb_fb
  // is XBH/HR-suppressing for groundballers; weather_temp is environmental
  // (warm air → offense → runs). Same bucket logic as scoreBatterMarket;
  // weights reuse W_BATTER.* (no new weights needed). sideFlip applied.
  // Lower-priority unwired factors (launch_angle, sweet_spot, line_hit_rate,
  // pitcher_baa_vs_hand, hitter_streak_fatigue, lineup_consistency,
  // day_after_night, travel_getaway, handedness_matchup) deferred to D-807.
  // ============================================================
  const sc_r = ctx.statcast ?? null;

  // D-806.1 — score_batter_xwoba (gated runs_scored is offense-flavored).
  let f_xwoba_r = 0;
  if (sc_r && sc_r.est_woba !== null) {
    const xwoba_diff_r = sc_r.est_woba - 0.320;
    if (xwoba_diff_r >= 0.060)       f_xwoba_r = 8;
    else if (xwoba_diff_r >= 0.030)  f_xwoba_r = 4;
    else if (xwoba_diff_r >= 0.010)  f_xwoba_r = 1;
    else if (xwoba_diff_r <= -0.060) f_xwoba_r = -8;
    else if (xwoba_diff_r <= -0.030) f_xwoba_r = -4;
    else if (xwoba_diff_r <= -0.010) f_xwoba_r = -1;
  }
  f_xwoba_r *= sideFlip;
  const score_batter_xwoba = roundHalfAwayFromZero(f_xwoba_r * W_BATTER.xwoba);

  // D-806.2 — score_batter_hard_hit (ev95% — hard contact creates XBH + HR).
  let f_hardHit_r = 0;
  if (sc_r && sc_r.ev95percent !== null) {
    const hh_r = sc_r.ev95percent;
    if (hh_r >= 52)      f_hardHit_r = 5;
    else if (hh_r >= 45) f_hardHit_r = 3;
    else if (hh_r >= 40) f_hardHit_r = 1;
    else if (hh_r <= 28) f_hardHit_r = -5;
    else if (hh_r <= 33) f_hardHit_r = -3;
    else if (hh_r <= 37) f_hardHit_r = -1;
  }
  f_hardHit_r *= sideFlip;
  const score_batter_hard_hit = roundHalfAwayFromZero(f_hardHit_r * W_BATTER.hardHit);

  // D-806.3 — score_pitcher_hard_contact_allowed (matchup counterpart).
  let f_pHCA_r = 0;
  if (opposingPitcher && opposingPitcher.inningsPitched >= 20
      && opposingPitcher.oppPitcherEv95Percent !== null) {
    const ev95_r = opposingPitcher.oppPitcherEv95Percent;
    if (ev95_r >= 50)      f_pHCA_r = 5;
    else if (ev95_r >= 43) f_pHCA_r = 3;
    else if (ev95_r >= 40) f_pHCA_r = 1;
    else if (ev95_r <= 28) f_pHCA_r = -5;
    else if (ev95_r <= 33) f_pHCA_r = -3;
    else if (ev95_r <= 37) f_pHCA_r = -1;
  }
  f_pHCA_r *= sideFlip;
  const score_pitcher_hard_contact_allowed = roundHalfAwayFromZero(f_pHCA_r * W_BATTER.pitcherHardContactAllowed);

  // D-806.4 — score_pitcher_gb_fb_rate (D-803 ungated for runs too —
  // flyballer allows MORE XBH/HR → more runs scored by the batter).
  let f_pGbFb_r = 0;
  if (opposingPitcher && opposingPitcher.inningsPitched >= 20
      && opposingPitcher.groundOutsToAirouts !== null) {
    const gbfb_r = opposingPitcher.groundOutsToAirouts;
    if (gbfb_r >= 1.50)       f_pGbFb_r = -5;
    else if (gbfb_r >= 1.30)  f_pGbFb_r = -3;
    else if (gbfb_r >= 1.15)  f_pGbFb_r = -1;
    else if (gbfb_r <= 0.70)  f_pGbFb_r = 5;
    else if (gbfb_r <= 0.85)  f_pGbFb_r = 3;
    else if (gbfb_r <= 1.00)  f_pGbFb_r = 1;
  }
  f_pGbFb_r *= sideFlip;
  const score_pitcher_gb_fb_rate = roundHalfAwayFromZero(f_pGbFb_r * 1.0);

  // D-806.5 — score_weather_temp (warm air → offense; not just TB-specific).
  let f_temp_r = 0;
  if (weather && weather.condition !== "indoor" && typeof weather.tempF === "number") {
    const dT = weather.tempF - LEAGUE_AVG_TEMP_F;
    if (dT >= 15)       f_temp_r = 3;
    else if (dT >= 8)   f_temp_r = 2;
    else if (dT >= 4)   f_temp_r = 1;
    else if (dT <= -15) f_temp_r = -3;
    else if (dT <= -8)  f_temp_r = -2;
    else if (dT <= -4)  f_temp_r = -1;
  }
  f_temp_r *= sideFlip;
  const score_weather_temp = roundHalfAwayFromZero(f_temp_r * W_BATTER.weatherTemp);

  // ============================================================
  // D-807 — Lineup protection + team offense (HIGH-VALUE runs-only signals).
  // D-806 PART 1 audit found both MISSING; D-807 builds them.
  // ============================================================

  // D-807.1 — score_batter_lineup_protection
  // The 2 hitters BATTING BEHIND this batter (slots +1, +2 on same side,
  // wrap 9→1) drive him in. Their OPS is the protection signal. Strong
  // hitters behind → favor OVER (batter scores more). Bucket vs ~0.720
  // league avg OPS, ±5 magnitudes. Gated on having lineup data.
  let f_lineupProt = 0;
  if (ctx.nextHittersBehindOps !== null && ctx.nextHittersBehindOps !== undefined) {
    const ops_behind = ctx.nextHittersBehindOps;
    const ops_diff = ops_behind - 0.720;
    if (ops_diff >= 0.080)       f_lineupProt = 5;
    else if (ops_diff >= 0.050)  f_lineupProt = 3;
    else if (ops_diff >= 0.020)  f_lineupProt = 1;
    else if (ops_diff <= -0.080) f_lineupProt = -5;
    else if (ops_diff <= -0.050) f_lineupProt = -3;
    else if (ops_diff <= -0.020) f_lineupProt = -1;
  }
  f_lineupProt *= sideFlip;
  const score_batter_lineup_protection = roundHalfAwayFromZero(f_lineupProt * W_BATTER.lineupProtection);

  // D-807.2 — score_batter_team_offense
  // Batter's TEAM season OPS. High-scoring team → more baserunners + rallies
  // → more chances for this batter to score. Distinct from lineup_spot
  // (PA volume) and lineup_protection (specific hitters behind). Bucket
  // vs ~0.720 league avg, ±4 magnitudes.
  let f_teamOff = 0;
  if (ctx.batterTeamContext?.opsSeason !== null
      && ctx.batterTeamContext?.opsSeason !== undefined) {
    const team_ops = ctx.batterTeamContext.opsSeason;
    const team_diff = team_ops - 0.720;
    if (team_diff >= 0.060)       f_teamOff = 4;
    else if (team_diff >= 0.030)  f_teamOff = 2;
    else if (team_diff >= 0.010)  f_teamOff = 1;
    else if (team_diff <= -0.060) f_teamOff = -4;
    else if (team_diff <= -0.030) f_teamOff = -2;
    else if (team_diff <= -0.010) f_teamOff = -1;
  }
  f_teamOff *= sideFlip;
  const score_batter_team_offense = roundHalfAwayFromZero(f_teamOff * W_BATTER.teamOffense);

  // ============================================================
  // D-808 PART 1 — Wire the 8 deferred D-806 factors into runs_scored.
  // All 8 verified runs-relevant: launch_angle/sweet_spot (quality contact →
  // hits → on base → score); line_hit_rate (recent contact penalty);
  // pitcher_baa_vs_hand (matchup → reach base); hitter_streak_fatigue +
  // day_after_night + travel (fatigue depresses all offensive output);
  // lineup_consistency (stable role boosts runs). Bucket logic mirrors
  // scoreBatterMarket EXCEPT day_after_night uses non-power (runs ≠ HR).
  // All use existing W_BATTER weights (no new keys).
  // ============================================================

  // D-808.1 — launch_angle (line-drive zone for runs context)
  let f_launchAngle_r = 0;
  if (sc_r && sc_r.avg_hit_angle !== null) {
    const la_r = sc_r.avg_hit_angle;
    if (la_r >= 10 && la_r <= 22)     f_launchAngle_r = 4;
    else if (la_r >= 8 && la_r <= 28) f_launchAngle_r = 2;
    else if (la_r < 3)                f_launchAngle_r = -5;
    else if (la_r > 35)               f_launchAngle_r = -3;
  }
  f_launchAngle_r *= sideFlip;
  const score_batter_launch_angle = roundHalfAwayFromZero(f_launchAngle_r * W_BATTER.launchAngle);

  // D-808.2 — sweet_spot (consistency of optimal launch)
  let f_sweetSpot_r = 0;
  if (sc_r && sc_r.anglesweetspotpercent !== null) {
    const ss_r = sc_r.anglesweetspotpercent;
    if (ss_r >= 42)      f_sweetSpot_r = 5;
    else if (ss_r >= 37) f_sweetSpot_r = 3;
    else if (ss_r >= 34) f_sweetSpot_r = 1;
    else if (ss_r <= 26) f_sweetSpot_r = -5;
    else if (ss_r <= 30) f_sweetSpot_r = -3;
    else if (ss_r <= 32) f_sweetSpot_r = -1;
  }
  f_sweetSpot_r *= sideFlip;
  const score_batter_sweet_spot = roundHalfAwayFromZero(f_sweetSpot_r * W_BATTER.sweetSpot);

  // D-808.3 — line_hit_rate (D-517 v2 penalty — recent l10 line failures).
  // recentHitRate already incorporates pick side; no sideFlip.
  const l10Pct_runs = gameLog.length >= 5
    ? Math.round(recentHitRate(gameLog, prop.line, prop.pickSide, "runs_scored"))
    : -1;
  let f_lineHitRate_r = 0;
  if (l10Pct_runs >= 0) {
    if      (l10Pct_runs >= 60) f_lineHitRate_r = 0;
    else if (l10Pct_runs >= 50) f_lineHitRate_r = -3;
    else if (l10Pct_runs >= 40) f_lineHitRate_r = -6;
    else if (l10Pct_runs >= 30) f_lineHitRate_r = -10;
    else                        f_lineHitRate_r = -15;
  }
  const score_batter_line_hit_rate = roundHalfAwayFromZero(f_lineHitRate_r * W_BATTER.lineHitRate);

  // D-808.4 — pitcher_baa_vs_hand (handedness matchup)
  let f_pBaaHand_r = 0;
  const ops_r = ctx.opposingPitcherSplits ?? null;
  if (ops_r && season.bats) {
    let baaThisHand: number | null = null;
    let paThisHand: number | null = null;
    const bats = season.bats;
    if (bats === "L") { baaThisHand = ops_r.baa_vs_lhb; paThisHand = ops_r.pa_vs_lhb; }
    else if (bats === "R") { baaThisHand = ops_r.baa_vs_rhb; paThisHand = ops_r.pa_vs_rhb; }
    else if (bats === "S") {
      const lhb = ops_r.baa_vs_lhb, rhb = ops_r.baa_vs_rhb;
      if (lhb !== null && rhb !== null) {
        baaThisHand = Math.max(lhb, rhb);
        paThisHand = Math.max(ops_r.pa_vs_lhb ?? 0, ops_r.pa_vs_rhb ?? 0);
      } else if (lhb !== null) { baaThisHand = lhb; paThisHand = ops_r.pa_vs_lhb; }
      else if (rhb !== null) { baaThisHand = rhb; paThisHand = ops_r.pa_vs_rhb; }
    }
    if (typeof baaThisHand === "number" && typeof paThisHand === "number" && paThisHand >= 30) {
      const delta = baaThisHand - LEAGUE_AVG_BA;
      if (delta <= -0.045)      f_pBaaHand_r = -3;
      else if (delta <= -0.020) f_pBaaHand_r = -1;
      else if (delta >=  0.045) f_pBaaHand_r = 3;
      else if (delta >=  0.020) f_pBaaHand_r = 1;
    }
  }
  f_pBaaHand_r *= sideFlip;
  const score_pitcher_baa_vs_hand = roundHalfAwayFromZero(f_pBaaHand_r * W_BATTER.opposingPitcherBaaVsHand);

  // D-808.5 — hitter_streak_fatigue (consecutive starts)
  let f_streakFatigue_r = 0;
  const cs_r = ctx.consecutiveStarts ?? null;
  if (typeof cs_r === "number") {
    if (cs_r >= 12) f_streakFatigue_r = -2;
    else if (cs_r >= 8) f_streakFatigue_r = -1;
  }
  f_streakFatigue_r *= sideFlip;
  const score_hitter_streak_fatigue = roundHalfAwayFromZero(f_streakFatigue_r * W_BATTER.hitterStreakFatigue);

  // D-808.6 — lineup_consistency (stable role boosts runs)
  const lcMag_r = lineupConsistencyScore(gameLog);
  const score_lineup_consistency = roundHalfAwayFromZero(lcMag_r * W_BATTER.lineupConsistency * sideFlip);

  // D-808.7 — day_after_night_fatigue (runs uses non-power bucket: -2 / -1)
  let f_danf_r = 0;
  if (ctx.dayAfterNight === true) {
    f_danf_r = -2;
  } else if (gameLog.length > 0) {
    const last = gameLog[gameLog.length - 1];
    const lastDate = (last as { gameDate?: string; date?: string })?.gameDate ?? (last as { date?: string })?.date;
    if (lastDate) {
      const hoursSince = (Date.now() - new Date(lastDate).getTime()) / 36e5;
      if (hoursSince >= 18 && hoursSince <= 30) f_danf_r = -1;
    }
  }
  f_danf_r *= sideFlip;
  const score_day_after_night_fatigue = roundHalfAwayFromZero(f_danf_r * W_BATTER.dayAfterNightFatigue);

  // D-808.8 — travel_getaway (long EW flights depress offense)
  let f_travel_r = 0;
  const tc_r = ctx.travelContext ?? null;
  if (tc_r && tc_r.miles >= 1000) {
    if (tc_r.miles >= 1500 && tc_r.direction === "EW")      f_travel_r = -3;
    else if (tc_r.miles >= 1000 && tc_r.direction === "EW") f_travel_r = -2;
    else if (tc_r.miles >= 1500 && tc_r.direction === "WE") f_travel_r = -1;
  }
  f_travel_r *= sideFlip;
  const score_travel_getaway = roundHalfAwayFromZero(f_travel_r * W_BATTER.travelGetaway);

  // ============================================================
  // D-808 PART 2 — Sprint speed (Baseball Savant running leaderboard).
  // Faster runners take extra bases + score from 1st on doubles.
  // League avg ~27 ft/sec, elite >29, slow <25.
  // ============================================================
  let f_sprint = 0;
  if (ctx.batterSprintSpeed !== null && ctx.batterSprintSpeed !== undefined) {
    const spd = ctx.batterSprintSpeed;
    if (spd >= 30.0)      f_sprint = 5;
    else if (spd >= 28.5) f_sprint = 3;
    else if (spd >= 27.5) f_sprint = 1;
    else if (spd <= 24.5) f_sprint = -5;
    else if (spd <= 25.5) f_sprint = -3;
    else if (spd <= 26.5) f_sprint = -1;
  }
  f_sprint *= sideFlip;
  const score_batter_sprint_speed = roundHalfAwayFromZero(f_sprint * W_BATTER.sprintSpeed);

  // === M5 — Poisson win-prob path (replaces additive confidence + D-784 isotonic) ===
  const factorSum_rs =
    score_batter_obp + score_recent_run_form + score_opposing_pitcher_quality
    + score_ballpark_factor + score_lineup_spot + score_bullpen_quality
    + score_opp_pitcher_pitchtype_quality
    + score_batter_hit_rate + score_batter_form + score_batter_babip
    + score_batter_xba + score_batter_barrel_rate + score_batter_exit_velo_trend
    + score_batter_xslg_regression + score_batter_vs_pitcher_hand_split
    + score_batter_recent_at_bats + score_batter_power_rate + score_batter_form_power
    + score_batter_xwoba + score_batter_hard_hit
    + score_pitcher_hard_contact_allowed + score_pitcher_gb_fb_rate
    + score_weather_temp
    + score_batter_lineup_protection + score_batter_team_offense
    + score_batter_launch_angle + score_batter_sweet_spot
    + score_batter_line_hit_rate + score_pitcher_baa_vs_hand
    + score_hitter_streak_fatigue + score_lineup_consistency
    + score_day_after_night_fatigue + score_travel_getaway
    + score_batter_sprint_speed;
  const usePoissonRs = !poissonDisabledForHarness();
  let winProb_rs = 0;
  let confidence_raw_rs = 0;

  if (usePoissonRs) {
    const lambdaMultiplier_rs = clamp(1.0 + (factorSum_rs * sideFlip) * getLambdaCoeff(), 0.65, 1.40);
    const lambdaAdjusted_rs = projectedStat * lambdaMultiplier_rs;
    winProb_rs = winProbPoissonK(
      lambdaAdjusted_rs, prop.line, prop.pickSide as "over" | "under",
    );
    confidence_raw_rs = clamp(Math.round(winProb_rs * 100), 0, 100);
    confidence = shrinkPoissonConfidence(confidence_raw_rs);
    confidence = clamp(confidence, 0, 100);
  } else {
    confidence = 50 + edge * 8 + factorSum_rs;
    confidence = clamp(Math.round(confidence), 0, 100);
  }

  // === D-467 EDGE-SIGN FLOOR — skipped under Poisson win-prob ==========
  let d467_edge_floor_delta = 0;
  if (!usePoissonRs && edge < 0 && confidence > 69) {
    d467_edge_floor_delta = confidence - 69;
    confidence = 69;
  }

  const confidence_pre_cap = confidence;

  // === D-140 TRIVIAL-LINE CAP =====================================
  if (prop.line <= 0.5 && Math.abs(prop.odds) >= 200 && confidence > 65) {
    confidence = 65;
  }

  // === D-479 LONGSHOT OVER CAP (uniform structural rule) ===========
  if (prop.pickSide === "over" && prop.odds >= 100
      && confidence >= 70 && confidence <= 79) {
    confidence = 65;
  }

  // === D-509 ELITE/STRONG LONGSHOT OVER CAP (sibling of D-479) =====
  // batter_runs_scored is in the bleed cluster — no carve-out. See
  // scorePitcherStrikeouts header (line 534) for full rationale.
  if (prop.pickSide === "over" && confidence >= 80 && prop.odds >= 150) {
    confidence = 75;
  }

  if (!usePoissonRs) {
    confidence = applyD784IsotonicCalibrationBatterRunsScored(
      confidence,
      prop.pickSide,
    );
    confidence = clamp(confidence, 0, 100);
  }

  // === SANITY FLAGS ===============================================
  let unbettableJuiceFlag = false;
  if (prop.pickSide === "under") {
    if (confidence >= 90 && prop.odds <= -350)      unbettableJuiceFlag = true;
    else if (confidence >= 80 && prop.odds <= -300) unbettableJuiceFlag = true;
    else if (confidence >= 70 && prop.odds <= -250) unbettableJuiceFlag = true;
    else if (confidence >= 60 && prop.odds <= -200) unbettableJuiceFlag = true;
  }

  // === HIT RATES (per-row display + audit) =========================
  function hitRate(window: BatterGameLogEntry[]): number {
    if (window.length === 0) return 0;
    const hits = window.filter((g) =>
      prop.pickSide === "over" ? g.runs > prop.line : g.runs < prop.line,
    ).length;
    return (hits / window.length) * 100;
  }
  const last5HitRate = hitRate(gameLog.slice(-5));
  const last10HitRate = hitRate(last10);
  const seasonHitRate = hitRate(gameLog);
  const coinFlipFlag = confidence >= 80 && last10HitRate >= 40 && last10HitRate <= 60;

  let unbettableOverBreakevenFlag = false;
  if (usePoissonRs && prop.pickSide === "over") {
    unbettableOverBreakevenFlag =
      winProb_rs * 100 <= impliedProbAmerican(prop.odds) * 100;
  }
  const rsEvFields = usePoissonRs
    ? computeEvFromWinProb(winProb_rs, prop.odds)
    : {};

  const factorArr = [
    score_batter_obp, score_recent_run_form, score_opposing_pitcher_quality,
    score_ballpark_factor, score_lineup_spot, score_bullpen_quality,
    // D-598
    score_opp_pitcher_pitchtype_quality,
    // D-658 — 11 newly wired from scoreBatterMarket
    score_batter_hit_rate, score_batter_form, score_batter_babip,
    score_batter_xba, score_batter_barrel_rate, score_batter_exit_velo_trend,
    score_batter_xslg_regression, score_batter_vs_pitcher_hand_split,
    score_batter_recent_at_bats, score_batter_power_rate, score_batter_form_power,
  ];
  const negativeFactorCount = factorArr.filter((v) => v < 0).length;
  const negativeStackingFlag = confidence >= 80 && negativeFactorCount >= 3;

  const verdict = getScoreLabel(confidence);

  const breakdown: Record<string, number | string | boolean | null> = {
    market_stat: "runs_scored",
    pick_side: prop.pickSide,
    bats: season.bats,
    raw_edge: Math.round(edge * 100) / 100,
    projected_stat: Math.round(projectedStat * 100) / 100,
    blended_r_per_game: Math.round(blendedRPerGame * 100) / 100,
    season_r_per_game: Math.round(seasonRPerGame * 100) / 100,
    recent_r_per_game: Math.round(recentRPerGame * 100) / 100,
    season_obp: season.obp,
    season_games: season.gamesPlayed,
    last5_hit_rate_pct: Math.round(last5HitRate),
    last10_hit_rate_pct: Math.round(last10HitRate),
    season_hit_rate_pct: Math.round(seasonHitRate),
    opp_pitcher_era: opposingPitcher?.era ?? null,
    opp_bullpen_era: ctx.opposingBullpen?.bullpen_era ?? null,
    park_runs_factor: ballpark?.runsFactor ?? null,
    lineup_spot: lineupSpot,
    score_batter_obp,
    score_recent_run_form,
    score_opposing_pitcher_quality,
    score_ballpark_factor,
    score_lineup_spot,
    score_bullpen_quality,
    // D-658 — 11 newly wired batter factors (mirror scoreBatterMarket logic).
    score_batter_hit_rate,
    score_batter_form,
    score_batter_form_power,
    score_batter_power_rate,
    score_batter_babip,
    score_batter_xba,
    score_batter_barrel_rate,
    score_batter_exit_velo_trend,
    score_batter_xslg_regression,
    score_batter_vs_pitcher_hand_split,
    score_batter_recent_at_bats,
    // D-658 — provenance of the wire (so post-D-658 picks can be
    // distinguished in audits from pre-D-658 runs_scored picks).
    d658_factors_wired: true,
    // D-598 — opposing pitcher pitch-type matchup (R-framing: suppression)
    score_opp_pitcher_pitchtype_quality,
    opp_pitcher_id: ctx.opposingPitcherId ?? null,
    opp_pitcher_expected_put_away: oppArsenal_R?.expected_put_away ?? null,
    opp_pitcher_expected_whiff_pct: oppArsenal_R?.expected_whiff_pct ?? null,
    d467_edge_floor_applied: d467_edge_floor_delta > 0,
    // D-806 — 5 cross-applied factors. Provenance flag distinguishes post-D-806
    // picks from pre-D-806 in audits + per-OOS-tune cohort splits.
    score_batter_xwoba,
    score_batter_hard_hit,
    score_pitcher_hard_contact_allowed,
    score_pitcher_gb_fb_rate,
    score_weather_temp,
    statcast_xwoba: sc_r?.est_woba ?? null,
    statcast_hard_hit_pct: sc_r?.ev95percent ?? null,
    statcast_opp_pitcher_ev95_pct: opposingPitcher?.oppPitcherEv95Percent ?? null,
    opp_pitcher_ground_outs_to_airouts: opposingPitcher?.groundOutsToAirouts ?? null,
    weather_temp_f: weather?.tempF ?? null,
    d806_runs_factors_wired: true,
    // D-807 — lineup protection + team offense (runs-only signals).
    score_batter_lineup_protection,
    score_batter_team_offense,
    next_hitters_behind_ops: ctx.nextHittersBehindOps ?? null,
    batter_team_ops_season: ctx.batterTeamContext?.opsSeason ?? null,
    d807_runs_factors_wired: true,
    // D-808 — full-stack completion: 8 deferred factors + sprint speed.
    score_batter_launch_angle,
    score_batter_sweet_spot,
    score_batter_line_hit_rate,
    score_pitcher_baa_vs_hand,
    score_hitter_streak_fatigue,
    score_lineup_consistency,
    score_day_after_night_fatigue,
    score_travel_getaway,
    score_batter_sprint_speed,
    batter_sprint_speed_ft_sec: ctx.batterSprintSpeed ?? null,
    d808_runs_factors_wired: true,
    // D-813 — clean-cohort provenance flag. True on every pick scored after
    // the D-812 weather + D-812 lineup_spot + D-813 permanent weather inline
    // + D-813 nextHittersBehindOps projected fallback fixes are deployed.
    // Forward retunes (D-810 runs_scored, D-820 HR) MUST filter on this flag
    // to exclude pre-fix contaminated picks (null weather, null lineup_spot,
    // null lineup_protection on early-day picks).
    d813_clean_cohort: true,
    v1_algo: "D-475 6-factor batter runs scored + D-598 opp_pitchtype + D-806 5-factor (xwoba, hard_hit, pitcher_hard_contact, pitcher_gb_fb, weather_temp) + D-807 lineup_protection + team_offense + D-808 (8 deferred + sprint_speed: launch_angle, sweet_spot, line_hit_rate, pitcher_baa_vs_hand, hitter_streak_fatigue, lineup_consistency, day_after_night, travel_getaway, sprint_speed)",
  };

  return {
    confidence,
    confidence_pre_cap,
    confidence_pre_tier_aware: confidence,
    verdict,
    projectedStat: Math.round(projectedStat * 100) / 100,
    seasonAvg: Math.round(seasonRPerGame * 100) / 100,
    recentAvg: Math.round(recentRPerGame * 100) / 100,
    edge: Math.round(edge * 100) / 100,
    // D-794 PART 2 — Expose 5 D-658-wired factors at top-level. They were
    // computed + contributing to confidence (lines 3334-3341 above) but the
    // pre-D-794 return hard-coded them to 0 — invisible to the optimizer
    // reading dedicated columns. Confidence math UNCHANGED; only the API
    // return is fixed. Maps the canonical computed variable to the interface
    // field name (recent_at_bats has a `batter_` prefix on the local variable
    // but no prefix on the interface field).
    score_batter_hit_rate,
    score_batter_form,
    score_opposing_pitcher_quality,                  // R-market uses ERA factor
    score_recent_at_bats: score_batter_recent_at_bats, // local var has batter_ prefix
    score_handedness_matchup: 0,                     // D-809 wire candidate (overlaps vs_hand_split already wired)
    score_ballpark_factor,                            // R-park factor
    score_weather_temp,                                // D-806 — wired
    score_lineup_consistency,                         // D-808 — wired
    score_batter_power_rate,
    score_batter_form_power,
    score_pitcher_hr_rate: 0,                        // dead-by-design (HR-only)
    score_weather_wind: 0,                            // dead-by-design (HR-only)
    score_lineup_spot,                                // R-market lineup signal (inverted from K)
    score_day_after_night_fatigue,                    // D-808 — wired
    score_travel_getaway,                             // D-808 — wired
    score_pitcher_baa_vs_hand,                        // D-808 — wired
    score_hitter_streak_fatigue,                      // D-808 — wired
    score_batter_line_hit_rate,                       // D-808 — wired
    // D-598 — opposing pitcher pitch-type matchup factor (R-side, suppression)
    score_opp_pitcher_pitchtype_quality,
    // D-785 — 8 columns previously in breakdown only. Now persisted at top-level
    // so the optimizer reading dedicated columns sees real values (was NULL).
    score_batter_obp,
    score_recent_run_form,
    score_bullpen_quality,
    score_batter_xba,
    score_batter_exit_velo_trend,
    score_batter_barrel_rate,
    score_batter_xslg_regression,
    score_batter_vs_pitcher_hand_split,
    // D-797 — interface contract. Babip is computed in scoreBatterRunsScored
    // at line 3196 — expose at top-level. xwoba is WIRED via D-806;
    // launch_angle + sweet_spot now WIRED via D-808 (line-drive zone helps
    // runs by improving on-base rate, distinct from hard_hit's HR signal).
    score_batter_babip,
    score_batter_xwoba,                              // D-806 — wired
    score_batter_launch_angle,                        // D-808 — wired
    score_batter_sweet_spot,                          // D-808 — wired
    score_batter_hard_hit,                            // D-806 — wired
    // D-803/D-806 — wired pitcher hard-contact-allowed for runs_scored too.
    // Flyball-allowing pitcher → more XBH+HR → more runs scored by the batter.
    score_pitcher_hard_contact_allowed,
    // D-807 — new runs-only high-value factors.
    score_batter_lineup_protection,
    score_batter_team_offense,
    // D-808 — baserunning factor (sprint speed).
    score_batter_sprint_speed,
    // D-816 — runs_scored doesn't use pull rate (HR-only factor); zero-default.
    score_batter_pull_rate: 0,
    score_batter_contact_rate: 0,
    // D-817 — runs_scored doesn't use pull × fence (HR-only); zero-default.
    score_batter_pull_x_park_fence: 0,
    unbettableJuiceFlag,
    unbettableOverBreakevenFlag,
    coinFlipFlag,
    negativeStackingFlag,
    negativeFactorCount,
    winProb: winProb_rs,
    ...rsEvFields,
    breakdown,
  };
}

function scoreBatterMarket(ctx: BatterScoringContext, marketStat: "hits" | "totalBases" | "rbi" | "homeRuns"): BatterMarketResult {
  const { season, gameLog, opposingPitcher, ballpark, weather, prop, batter } = ctx;
  const sideFlip = prop.pickSide === "under" ? -1 : 1;
  const isPowerMarket = marketStat === "homeRuns" || marketStat === "totalBases" || marketStat === "rbi";

  const recentAvg = recentBatterAvg(gameLog, marketStat);
  const seasonAvgPerGame = season.gamesPlayed > 0
    ? marketStat === "hits"      ? season.hits / season.gamesPlayed
    : marketStat === "totalBases" ? season.totalBases / season.gamesPlayed
    : marketStat === "rbi"        ? season.rbi / season.gamesPlayed
    : season.homeRuns / season.gamesPlayed
    : 0;

  // D-660 SHIP 2 — projection core fix. ERA measures runs, not homers.
  // For HR market: use opposingPitcher.hrPerNine vs LEAGUE_AVG_HR_PER_9 (1.18).
  // For other markets: keep ERA-based (ERA correlates with hits / TB / RBI
  // because all of those flow from balls-in-play + base traffic).
  // D-661 — blend with groundOutsToAirouts (GB/FB equivalent) when available.
  // A heavy-GB pitcher with fluky-high HR/9 should still be suppressed because
  // the underlying batted-ball profile says HRs are rare on this arm. Mix:
  //   adj = 0.7 × hr9_adj + 0.3 × gb_fb_adj   (when GB/FB present)
  // gb_fb_adj: high goToAo → suppress (adj < 1.0); low goToAo → boost.
  let pitcherAdj = 1.0;
  if (opposingPitcher) {
    if (marketStat === "homeRuns" && opposingPitcher.hrPerNine > 0 && opposingPitcher.inningsPitched >= 20) {
      const hr9Adj = clamp(opposingPitcher.hrPerNine / LEAGUE_AVG_HR_PER_9, 0.80, 1.25);
      if (opposingPitcher.groundOutsToAirouts !== null && opposingPitcher.groundOutsToAirouts > 0) {
        // League avg goToAo ~1.10. Above 1.30 = groundballer. Below 0.85 = flyballer.
        // Inverse mapping: high goToAo → low pitcherAdj for HR (suppresses projection).
        const LEAGUE_AVG_GO_AO = 1.10;
        const gbFbAdj = clamp(LEAGUE_AVG_GO_AO / opposingPitcher.groundOutsToAirouts, 0.80, 1.25);
        pitcherAdj = 0.7 * hr9Adj + 0.3 * gbFbAdj;
      } else {
        pitcherAdj = hr9Adj;
      }
    } else if (opposingPitcher.era > 0) {
      pitcherAdj = clamp(opposingPitcher.era / LEAGUE_AVG_ERA, 0.80, 1.25);
    }
  }

  // Ballpark hits factor
  const parkAdj = ballpark
    ? clamp(marketStat === "homeRuns" ? ballpark.hrFactor : ballpark.hitsFactor, 0.85, 1.20)
    : 1.0;

  const blended = recentAvg > 0
    ? 0.55 * recentAvg + 0.45 * seasonAvgPerGame
    : seasonAvgPerGame;
  const projectedStat = blended * pitcherAdj * parkAdj;
  const edge = (projectedStat - prop.line) * sideFlip;

  let confidence = marketStat === "hits"
    ? 0
    : 50 + edge * (marketStat === "homeRuns" ? 25 : 6);

  // ============================================================
  // FACTOR — score_batter_hit_rate (season BA / power rate)
  // ============================================================
  let f_hitRate = 0;
  if (!isPowerMarket) {
    const diff = season.battingAvg - LEAGUE_AVG_BA;
    if (diff >= 0.040)      f_hitRate = 10;
    else if (diff >= 0.020) f_hitRate = 6;
    else if (diff >= 0.010) f_hitRate = 3;
    else if (diff <= -0.040) f_hitRate = -10;
    else if (diff <= -0.020) f_hitRate = -6;
    else if (diff <= -0.010) f_hitRate = -3;
  }
  f_hitRate *= sideFlip;

  // ============================================================
  // D-281 SHIP 2 — score_batter_babip
  // BABIP regression signal. League avg ~.300.
  //   High BABIP (>.330) = lucky, expect regression DOWN
  //   Low BABIP (<.270) = unlucky, expect regression UP
  // Applies to hits/TB/RBI markets. Not HR (BABIP excludes HR by def).
  // Data source: season.babip already populated by D-204 batter stats
  // accessor (interface line 528).
  // Bucket-based ±5. Weight 1.0 from algorithm_weights.w_mlb_batter_babip.
  // ============================================================
  let f_babip = 0;
  if (season.babip > 0 && marketStat !== "homeRuns") {
    const babipDiff = season.babip - 0.300;  // league avg
    // D-689 widened ±0.015 → ±0.008. CEO §19.3. Pre-D-689 fire ~21% (4 markets);
    // new ±0.008 threshold catches the modest-luck/unlucky bucket; bands rescaled
    // so extreme regression magnitude stays at ±5 but normal-band fires non-zero.
    if (babipDiff >= 0.060)      f_babip = -5;
    else if (babipDiff >= 0.030) f_babip = -3;
    else if (babipDiff >= 0.015) f_babip = -2;
    else if (babipDiff >= 0.008) f_babip = -1;
    else if (babipDiff <= -0.060) f_babip = 5;
    else if (babipDiff <= -0.030) f_babip = 3;
    else if (babipDiff <= -0.015) f_babip = 2;
    else if (babipDiff <= -0.008) f_babip = 1;
  }
  f_babip *= sideFlip;
  const score_batter_hit_rate = isPowerMarket ? 0 : roundHalfAwayFromZero(f_hitRate * W_BATTER.hitRate);

  // ============================================================
  // FACTOR — score_batter_power_rate (HR/PA, ISO) — T3.4 only
  // ============================================================
  let f_powerRate = 0;
  if (isPowerMarket) {
    const hrPerPA = season.hrPerPA;
    const iso = season.iso;
    let mag = 0;
    if (hrPerPA >= LEAGUE_AVG_HR_PA * 1.6)       mag += 6;
    else if (hrPerPA >= LEAGUE_AVG_HR_PA * 1.3)  mag += 4;
    else if (hrPerPA >= LEAGUE_AVG_HR_PA * 1.1)  mag += 2;
    else if (hrPerPA <= LEAGUE_AVG_HR_PA * 0.5)  mag -= 6;
    else if (hrPerPA <= LEAGUE_AVG_HR_PA * 0.75) mag -= 3;
    if (iso >= LEAGUE_AVG_ISO * 1.5)             mag += 2;
    else if (iso <= LEAGUE_AVG_ISO * 0.6)        mag -= 2;
    f_powerRate = clamp(mag, -10, 10);
  }
  f_powerRate *= sideFlip;
  const score_batter_power_rate = isPowerMarket ? roundHalfAwayFromZero(f_powerRate * W_BATTER.powerRate) : 0;

  // ============================================================
  // FACTOR — score_batter_form (last 10 game avg vs season)
  // ============================================================
  let f_form = 0;
  if (gameLog.length >= 5 && seasonAvgPerGame > 0) {
    const delta = recentAvg - seasonAvgPerGame;
    const scale = marketStat === "homeRuns" ? 0.3 : marketStat === "hits" ? 0.8 : 0.5;
    // D-689 widened: added 0.25*scale band. Pre-D-689 batter_hits.form was 6.8%
    // (stricter 0.8 scale). New mild bucket catches normal-trend zone.
    if (delta >= 2 * scale)      f_form = 8;
    else if (delta >= 1 * scale) f_form = 4;
    else if (delta >= 0.5 * scale) f_form = 2;
    else if (delta >= 0.25 * scale) f_form = 1;
    else if (delta <= -2 * scale) f_form = -8;
    else if (delta <= -1 * scale) f_form = -4;
    else if (delta <= -0.5 * scale) f_form = -2;
    else if (delta <= -0.25 * scale) f_form = -1;
  }
  f_form *= sideFlip;
  const score_batter_form = isPowerMarket ? 0 : roundHalfAwayFromZero(f_form * W_BATTER.form);
  const score_batter_form_power = isPowerMarket ? roundHalfAwayFromZero(f_form * W_BATTER.formPower) : 0;

  // ============================================================
  // FACTOR — score_opposing_pitcher_quality (ERA / WHIP / K/9)
  // ============================================================
  let f_pitcherQ = 0;
  if (opposingPitcher && opposingPitcher.inningsPitched > 0) {
    const eraDiff = LEAGUE_AVG_ERA - opposingPitcher.era;       // positive = worse pitcher = batter advantage
    const whipDiff = LEAGUE_AVG_WHIP - opposingPitcher.whip;
    let mag = 0;
    if (eraDiff >= 1.2)      mag += 4;
    else if (eraDiff >= 0.6) mag += 2;
    else if (eraDiff <= -1.2) mag -= 4;
    else if (eraDiff <= -0.6) mag -= 2;
    if (whipDiff >= 0.20)    mag += 3;
    else if (whipDiff >= 0.10) mag += 1;
    else if (whipDiff <= -0.20) mag -= 3;
    else if (whipDiff <= -0.10) mag -= 1;
    // K/9: higher K pitcher means fewer balls in play → fewer hits
    if (!isPowerMarket) {
      if (opposingPitcher.kPerNine >= 10.5)      mag -= 2;
      else if (opposingPitcher.kPerNine >= 9.5)  mag -= 1;
      else if (opposingPitcher.kPerNine <= 6.5)  mag += 2;
    }
    f_pitcherQ = clamp(mag, -10, 10);
  }
  f_pitcherQ *= sideFlip;
  const score_opposing_pitcher_quality = roundHalfAwayFromZero(f_pitcherQ * W_BATTER.pitcherQuality);

  // ============================================================
  // FACTOR — score_pitcher_hr_rate (HR/9 allowed) — T3.4 only
  // ============================================================
  let f_pitcherHr = 0;
  if (isPowerMarket && opposingPitcher && opposingPitcher.inningsPitched > 0) {
    const hr9 = opposingPitcher.hrPerNine;
    if (hr9 >= LEAGUE_AVG_HR_PER_9 * 1.5)        f_pitcherHr = 6;
    else if (hr9 >= LEAGUE_AVG_HR_PER_9 * 1.25)  f_pitcherHr = 3;
    else if (hr9 <= LEAGUE_AVG_HR_PER_9 * 0.5)   f_pitcherHr = -6;
    else if (hr9 <= LEAGUE_AVG_HR_PER_9 * 0.75)  f_pitcherHr = -3;
  }
  f_pitcherHr *= sideFlip;
  const score_pitcher_hr_rate = isPowerMarket ? roundHalfAwayFromZero(f_pitcherHr * W_BATTER.pitcherHrRate) : 0;

  // ============================================================
  // FACTOR — score_recent_at_bats (PA volume trend / lineup health)
  // ============================================================
  let f_recentAB = 0;
  if (gameLog.length >= 5) {
    const last5PA = gameLog.slice(-5).reduce((a, g) => a + (g.plateAppearances || g.atBats || 0), 0) / 5;
    if (last5PA >= 4.5)      f_recentAB = 3;
    else if (last5PA >= 4.0) f_recentAB = 1;
    else if (last5PA <= 2.5) f_recentAB = -3;
    else if (last5PA <= 3.0) f_recentAB = -1;
  }
  f_recentAB *= sideFlip;
  const score_recent_at_bats = roundHalfAwayFromZero(f_recentAB * W_BATTER.recentAB);

  // ============================================================
  // FACTOR — score_handedness_matchup (batter AVG vs opp pitcher hand)
  // ============================================================
  let f_handMatchup = 0;
  if (opposingPitcher?.throws && (season.avgVsLHP !== null || season.avgVsRHP !== null)) {
    const split = opposingPitcher.throws === "L" ? season.avgVsLHP : season.avgVsRHP;
    if (split !== null) {
      const d = split - LEAGUE_AVG_BA;
      if (d >= 0.040)      f_handMatchup = 6;
      else if (d >= 0.020) f_handMatchup = 3;
      else if (d <= -0.040) f_handMatchup = -6;
      else if (d <= -0.020) f_handMatchup = -3;
    }
  }
  // Switch-hitter advantage (modest baseline + handedness data NULL fallback)
  if (season.bats === "S" && f_handMatchup === 0) f_handMatchup = 1;
  f_handMatchup *= sideFlip;
  const score_handedness_matchup = roundHalfAwayFromZero(f_handMatchup * W_BATTER.handednessMatchup);

  // ============================================================
  // FACTOR — score_ballpark_factor (hits or hr depending on market)
  // ============================================================
  let f_park = 0;
  if (ballpark) {
    const factor = marketStat === "homeRuns" ? ballpark.hrFactor : ballpark.hitsFactor;
    if (factor >= 1.05)       f_park = 6;
    else if (factor >= 1.02)  f_park = 3;
    else if (factor >= 1.01)  f_park = 1;
    else if (factor <= 0.95)  f_park = -6;
    else if (factor <= 0.98)  f_park = -3;
    else if (factor <= 0.99)  f_park = -1;
  }
  f_park *= sideFlip;
  const score_ballpark_factor = roundHalfAwayFromZero(f_park * W_BATTER.ballparkHitsFactor);

  // ============================================================
  // FACTOR — score_weather_temp (warm air → more offense)
  // ============================================================
  let f_temp = 0;
  if (weather && weather.condition !== "indoor" && typeof weather.tempF === "number") {
    const d = weather.tempF - LEAGUE_AVG_TEMP_F;
    // D-689 widened ±8°F → ±4°F. Pre-D-689 batter weather_temp gated to ±8°F
    // delta = ~15% fire (rare). New ±4°F band catches modest-weather games.
    if (d >= 15)       f_temp = 3;
    else if (d >= 8)   f_temp = 2;
    else if (d >= 4)   f_temp = 1;
    else if (d <= -15) f_temp = -3;
    else if (d <= -8)  f_temp = -2;
    else if (d <= -4)  f_temp = -1;
  }
  f_temp *= sideFlip;
  const score_weather_temp = roundHalfAwayFromZero(f_temp * W_BATTER.weatherTemp);

  // ============================================================
  // FACTOR — score_weather_wind (HR markets only — tailwind boosts)
  // ============================================================
  let f_wind = 0;
  if (isPowerMarket && weather && weather.condition !== "indoor" && typeof weather.windSpeed === "number") {
    const ws = weather.windSpeed;
    // D-689 widened wind gate. Pre-D-689: ws≥14/≥8/≤3 = ~13% fire on batter
    // power markets. New: ws≥5 catches normal-breezy games; ws≤4 captures still
    // conditions. Extremes (≥14) preserved.
    if (ws >= 14)       f_wind = 3;
    else if (ws >= 8)   f_wind = 2;
    else if (ws >= 5)   f_wind = 1;
    else if (ws <= 2)   f_wind = -2;
    else if (ws <= 4)   f_wind = -1;
  }
  f_wind *= sideFlip;
  const score_weather_wind = isPowerMarket ? roundHalfAwayFromZero(f_wind * W_BATTER.weatherWind) : 0;

  // ============================================================
  // FACTOR — score_lineup_consistency
  // ============================================================
  const lcMag = lineupConsistencyScore(gameLog);
  const score_lineup_consistency = roundHalfAwayFromZero(lcMag * W_BATTER.lineupConsistency * sideFlip);

  // ============================================================
  // D-347 FACTOR — score_lineup_spot
  // Top-of-order = more PAs per game. Bottom of order = fewer PAs.
  // For OVER picks: slot 1-2 = boost; slot 8-9 = penalty.
  // Applies to all 4 batter markets (hits/TB/RBI/HR — though HR less PA-sensitive,
  // the mechanical link still holds).
  // ============================================================
  let f_lineupSpot = 0;
  const slot = ctx.lineupSpot ?? null;
  if (typeof slot === "number" && slot >= 1 && slot <= 9) {
    if (slot === 1) f_lineupSpot = 3;
    else if (slot === 2) f_lineupSpot = 2;
    else if (slot === 3 || slot === 4) f_lineupSpot = 1;
    else if (slot === 5) f_lineupSpot = 0;
    else if (slot === 6 || slot === 7) f_lineupSpot = -1;
    else if (slot === 8) f_lineupSpot = -2;
    else if (slot === 9) f_lineupSpot = -3;
  }
  f_lineupSpot *= sideFlip;
  const score_lineup_spot = roundHalfAwayFromZero(f_lineupSpot * W_BATTER.lineupSpot);

  // ============================================================
  // D-347 FACTOR — score_day_after_night_fatigue
  // D-689 widened. Pre-D-689 = 5% fire (only exact DAN scenario). New: also
  // includes b2b games (yesterday played → mild fatigue), and travel context
  // proxied via different team yesterday. The exact DAN keeps stronger penalty.
  // ============================================================
  let f_danf = 0;
  if (ctx.dayAfterNight === true) {
    f_danf = -2;
    if (isPowerMarket) f_danf = -3;
  } else if (gameLog.length > 0) {
    // D-689 widened: mild fatigue if player had a game in last 18-30h.
    const last = gameLog[gameLog.length - 1];
    const lastDate = (last as { gameDate?: string; date?: string })?.gameDate ?? (last as { date?: string })?.date;
    if (lastDate) {
      const hoursSince = (Date.now() - new Date(lastDate).getTime()) / 36e5;
      if (hoursSince >= 18 && hoursSince <= 30) {
        f_danf = isPowerMarket ? -2 : -1;
      }
    }
  }
  f_danf *= sideFlip;
  const score_day_after_night_fatigue = roundHalfAwayFromZero(f_danf * W_BATTER.dayAfterNightFatigue);

  // ============================================================
  // D-347 FACTOR — score_travel_getaway
  // Long flights between yesterday's venue and today's venue depress
  // offense, especially east-to-west (circadian phase delay larger).
  // Trigger: distance >= 1000mi from yesterday's venue.
  // ============================================================
  let f_travel = 0;
  const tc = ctx.travelContext ?? null;
  if (tc && tc.miles >= 1000) {
    if (tc.miles >= 1500 && tc.direction === "EW") f_travel = -3;
    else if (tc.miles >= 1000 && tc.direction === "EW") f_travel = -2;
    else if (tc.miles >= 1500 && tc.direction === "WE") f_travel = -1;
    // Short trip or N/S movement: no signal
  }
  f_travel *= sideFlip;
  const score_travel_getaway = roundHalfAwayFromZero(f_travel * W_BATTER.travelGetaway);

  // ============================================================
  // D-349 FACTOR — score_pitcher_baa_vs_hand
  // Opposing pitcher's BAA vs THIS batter's handedness. League avg BAA ~.245.
  //   Pitcher with LOW BAA vs this hand → suppresses batter → -signal for over
  //   Pitcher with HIGH BAA vs this hand → batter advantage → +signal for over
  // Gate: ≥30 batters faced vs that hand (sample-size floor).
  // Switch-hitters (bats=S): use pitcher's WORSE side (higher BAA) since the
  // batter chooses the more-favorable matchup.
  // ============================================================
  let f_pitcherBaaVsHand = 0;
  const ops = ctx.opposingPitcherSplits ?? null;
  if (ops && season.bats) {
    let baaThisHand: number | null = null;
    let paThisHand: number | null = null;
    const bats = season.bats;
    if (bats === "L") {
      baaThisHand = ops.baa_vs_lhb;
      paThisHand = ops.pa_vs_lhb;
    } else if (bats === "R") {
      baaThisHand = ops.baa_vs_rhb;
      paThisHand = ops.pa_vs_rhb;
    } else if (bats === "S") {
      // Switch-hitter — pick the WORSE side for the pitcher (higher BAA).
      const lhb = ops.baa_vs_lhb;
      const rhb = ops.baa_vs_rhb;
      if (lhb !== null && rhb !== null) {
        baaThisHand = Math.max(lhb, rhb);
        paThisHand = Math.max(ops.pa_vs_lhb ?? 0, ops.pa_vs_rhb ?? 0);
      } else if (lhb !== null) { baaThisHand = lhb; paThisHand = ops.pa_vs_lhb; }
      else if (rhb !== null) { baaThisHand = rhb; paThisHand = ops.pa_vs_rhb; }
    }
    if (typeof baaThisHand === "number" && typeof paThisHand === "number" && paThisHand >= 30) {
      const delta = baaThisHand - LEAGUE_AVG_BA;  // 0.245
      if (delta <= -0.045)      f_pitcherBaaVsHand = -3;  // elite suppression
      else if (delta <= -0.020) f_pitcherBaaVsHand = -1;
      else if (delta >=  0.045) f_pitcherBaaVsHand = 3;   // very hittable for this hand
      else if (delta >=  0.020) f_pitcherBaaVsHand = 1;
    }
  }
  f_pitcherBaaVsHand *= sideFlip;
  const score_pitcher_baa_vs_hand = roundHalfAwayFromZero(f_pitcherBaaVsHand * W_BATTER.opposingPitcherBaaVsHand);

  // ============================================================
  // D-354 FACTOR — score_hitter_streak_fatigue
  // Long consecutive-starts streak reduces offensive output (research
  // suggests ~3-5% performance decline after 8+ straight starts).
  // Trigger: consecutive starts >= 8.
  // Buckets:
  //   >= 12 consecutive: -2 (heavy fatigue)
  //   >= 8 consecutive: -1 (moderate fatigue)
  //   < 8: 0 (no signal)
  // Applies to all 4 batter markets. SideFlip applied.
  // ============================================================
  let f_streakFatigue = 0;
  const cs = ctx.consecutiveStarts ?? null;
  if (typeof cs === "number") {
    if (cs >= 12) f_streakFatigue = -2;
    else if (cs >= 8) f_streakFatigue = -1;
  }
  f_streakFatigue *= sideFlip;
  const score_hitter_streak_fatigue = roundHalfAwayFromZero(f_streakFatigue * W_BATTER.hitterStreakFatigue);

  // ============================================================
  // D-598 FACTOR — score_opp_pitcher_pitchtype_quality (batter-side)
  //
  // Mirrors D-596 score_pitch_type_matchup (pitcher_k side) but BATTER-
  // FRAMED. For contact/power markets (hits/TB/HR/RBI), a tough opposing
  // arsenal (high expected_put_away — many K-finishing pitches in the
  // arsenal) SUPPRESSES the batter's offensive output, so a HIGH opp PA
  // pushes the score NEGATIVE on OVER picks (and positive on UNDER via
  // sideFlip). This is the INVERSE of pitcher_k where high opp PA boosts
  // over (more Ks for the pitcher). Buckets mirror D-596 z-score thresholds.
  // PA_MEAN / PA_SD identical to D-596 (same cache, same population).
  // D-598 14-day watch: seed weight 1.0; per-market harness verdict gates
  // promotion.
  // ============================================================
  let f_oppPitcherPitchTypeQuality = 0;
  const oppArsenal = ctx.opposingPitcherArsenal ?? null;
  if (oppArsenal && typeof oppArsenal.expected_put_away === "number" && oppArsenal.expected_put_away > 0) {
    const PA_MEAN = 19.37; const PA_SD = 4.76;
    const z = (oppArsenal.expected_put_away - PA_MEAN) / PA_SD;
    // Contact framing: high opp PA → batter suppression (negative on OVER).
    if (z >= 1.5)       f_oppPitcherPitchTypeQuality = -8;
    else if (z >= 0.75) f_oppPitcherPitchTypeQuality = -5;
    else if (z >= 0.25) f_oppPitcherPitchTypeQuality = -2;
    else if (z <= -1.5) f_oppPitcherPitchTypeQuality = 8;
    else if (z <= -0.75) f_oppPitcherPitchTypeQuality = 5;
    else if (z <= -0.25) f_oppPitcherPitchTypeQuality = 2;
  }
  f_oppPitcherPitchTypeQuality *= sideFlip;
  const score_opp_pitcher_pitchtype_quality = roundHalfAwayFromZero(f_oppPitcherPitchTypeQuality * W_BATTER.oppPitcherPitchTypeQuality);

  // ---- aggregate (legacy confidence path — skipped for hits win-prob rebuild)
  if (marketStat !== "hits") {
    confidence +=
      score_batter_hit_rate + score_batter_form + score_opposing_pitcher_quality +
      score_recent_at_bats + score_handedness_matchup + score_ballpark_factor +
      score_weather_temp + score_lineup_consistency +
      score_batter_power_rate + score_batter_form_power + score_pitcher_hr_rate +
      score_weather_wind +
      score_lineup_spot + score_day_after_night_fatigue + score_travel_getaway +
      score_pitcher_baa_vs_hand +
      score_hitter_streak_fatigue +
      score_opp_pitcher_pitchtype_quality;
  }

  // ============================================================
  // D-276-FACTORS — Statcast batter factors (graceful degrade).
  // Factor #2: barrel%/PA (power signal — primary for HR/TB markets)
  // Factor #3: xSLG regression delta (over/under-performing actual)
  // Both apply only to power markets (HR, total_bases). Hits market
  // unaffected — Statcast batter signal is power-flavored.
  // D-278-FACTORS — wire 2 additional batter Statcast factors:
  // Factor #5: xBA (expected batting average) — primarily hits market
  // Factor #6: exit_velo_trend — applies to power markets (HR/TB)
  // ============================================================
  let score_batter_barrel_rate = 0;
  let score_batter_xslg_regression = 0;
  let score_batter_xba = 0;
  let score_batter_exit_velo_trend = 0;
  const sc = ctx.statcast ?? null;
  if (sc) {
    // D-278 Factor #5: xBA — expected batting average vs LEAGUE_AVG_BA (~0.245)
    // Applies primarily to hits market; weakly to TB/RBI; not HR.
    const xba = sc.est_ba;
    if (xba !== null && (marketStat === "hits" || marketStat === "totalBases" || marketStat === "rbi")) {
      const xba_diff = xba - LEAGUE_AVG_BA;  // typical xBA range 0.180-0.310
      let f_xba = 0;
      if (xba_diff >= 0.040) f_xba = 6;
      else if (xba_diff >= 0.020) f_xba = 3;
      else if (xba_diff >= 0.010) f_xba = 1;
      else if (xba_diff <= -0.040) f_xba = -6;
      else if (xba_diff <= -0.020) f_xba = -3;
      else if (xba_diff <= -0.010) f_xba = -1;
      score_batter_xba = roundHalfAwayFromZero(f_xba * sideFlip * W_BATTER.xba);  // D-362 — DB-tunable via w_mlb_batter_xba
    }
    // D-278 Factor #6: exit_velo_trend — avg_hit_speed mph (league avg ~89 mph)
    // Power signal; applies to HR + TB + RBI markets.
    const avgHit = sc.avg_hit_speed;
    if (avgHit !== null && (marketStat === "homeRuns" || marketStat === "totalBases" || marketStat === "rbi")) {
      let f_evt = 0;
      if (avgHit >= 93)      f_evt = 6;
      else if (avgHit >= 91) f_evt = 3;
      else if (avgHit >= 89) f_evt = 0;
      else if (avgHit >= 87) f_evt = -2;
      else                   f_evt = -5;
      score_batter_exit_velo_trend = roundHalfAwayFromZero(f_evt * sideFlip * W_BATTER.exitVeloTrend);  // D-362 — DB-tunable via w_mlb_batter_exit_velo_trend
    }
  }
  if (sc && isPowerMarket) {
    // Barrel% per PA: league avg ~6%. ±8 max.
    const brlPa = sc.brl_pa;
    if (brlPa !== null) {
      let f_barrel = 0;
      if (brlPa >= 12)      f_barrel = 8;
      else if (brlPa >= 9)  f_barrel = 5;
      else if (brlPa >= 6)  f_barrel = 2;
      else if (brlPa >= 3)  f_barrel = -2;
      else                  f_barrel = -5;
      score_batter_barrel_rate = roundHalfAwayFromZero(f_barrel * sideFlip * W_BATTER.barrelRate);  // D-362 — DB-tunable via w_mlb_batter_barrel_rate
    }
    // xSLG regression: actual SLG vs expected SLG. positive diff = actual
    // under-performing = upside lift. ±4 max.
    const diff = sc.est_slg_minus_slg_diff;
    if (diff !== null) {
      let f_xslg = 0;
      if (diff >= 0.030)  f_xslg = 4;   // actual under-performing → upside
      else if (diff >= 0.015) f_xslg = 2;
      else if (diff <= -0.030) f_xslg = -4;
      else if (diff <= -0.015) f_xslg = -2;
      score_batter_xslg_regression = roundHalfAwayFromZero(f_xslg * sideFlip * W_BATTER.xslgRegression);  // D-362 — DB-tunable via w_mlb_batter_xslg_regression
    }
  }
  // D-281 SHIP 2: BABIP factor scoring.
  // D-362 — DB-tunable via w_mlb_batter_babip (default 1.0 preserves prior literal).
  const score_batter_babip = roundHalfAwayFromZero(f_babip * W_BATTER.babip);

  // ============================================================
  // D-282 SHIP 1 — batter_vs_pitcher_hand_split
  // Compare batter's split vs today's starting pitcher's hand to
  // batter's overall season average. Positive delta = favorable matchup.
  // Source: ctx.splits (cache_mlb_batter_splits via fetch-mlb-batter-splits)
  // + ctx.opposingPitcher.throws ('L'/'R').
  // Gated: only fires when both data sources present AND split sample
  // size ≥ 30 PA (statistical significance floor).
  // Applies to all 4 batter markets. Bucket-based ±6.
  // ============================================================
  let f_handSplit = 0;
  const splits = ctx.splits ?? null;
  const pitcherHand = ctx.opposingPitcher?.throws ?? null;
  if (splits && pitcherHand && season.gamesPlayed > 0) {
    // Pick the appropriate split + comparison stat per market
    let splitStat: number | null = null;
    let overallStat: number | null = null;
    let splitPa: number | null = null;
    // D-282 SHIP 1 fix (2026-05-21): RBI market was setting overallStat=null
    // which made the gating `overallStat !== null` always false → f_handSplit
    // stuck at 0. Verified via Matt Olson + Austin Riley both rbis with
    // hs=0 despite real platoon splits in cache. Fix: use SLG comparison
    // for RBI too (RBI is power-driven, SLG correlates correctly).
    const seasonSlg = season.atBats > 0 ? season.totalBases / season.atBats : null;
    if (pitcherHand === "L") {
      splitPa = splits.vs_lhp_pa;
      if (marketStat === "hits")            { splitStat = splits.vs_lhp_avg; overallStat = season.battingAvg; }
      else if (marketStat === "totalBases") { splitStat = splits.vs_lhp_slg; overallStat = seasonSlg; }
      else if (marketStat === "homeRuns")   { splitStat = splits.vs_lhp_slg; overallStat = seasonSlg; }
      else if (marketStat === "rbi")        { splitStat = splits.vs_lhp_slg; overallStat = seasonSlg; }
    } else if (pitcherHand === "R") {
      splitPa = splits.vs_rhp_pa;
      if (marketStat === "hits")            { splitStat = splits.vs_rhp_avg; overallStat = season.battingAvg; }
      else if (marketStat === "totalBases") { splitStat = splits.vs_rhp_slg; overallStat = seasonSlg; }
      else if (marketStat === "homeRuns")   { splitStat = splits.vs_rhp_slg; overallStat = seasonSlg; }
      else if (marketStat === "rbi")        { splitStat = splits.vs_rhp_slg; overallStat = seasonSlg; }
    }
    // Require minimum 30 PA of split sample for signal reliability
    if (splitStat !== null && overallStat !== null && overallStat > 0 && (splitPa ?? 0) >= 30) {
      const delta = splitStat - overallStat;
      // Positive delta = favorable matchup. Buckets calibrated to typical
      // platoon split magnitudes (.020-.060 typical, .080+ extreme).
      if (delta >= 0.080)      f_handSplit = 6;
      else if (delta >= 0.040) f_handSplit = 3;
      else if (delta >= 0.020) f_handSplit = 1;
      else if (delta <= -0.080) f_handSplit = -6;
      else if (delta <= -0.040) f_handSplit = -3;
      else if (delta <= -0.020) f_handSplit = -1;
    }
  }
  f_handSplit *= sideFlip;
  const score_batter_vs_pitcher_hand_split = roundHalfAwayFromZero(f_handSplit * W_BATTER.vsPitcherHandSplit);  // D-362 — DB-tunable via w_mlb_batter_vs_pitcher_hand_split

  // ============================================================
  // D-283 SHIP 4 — bullpen_quality factor
  // Late-AB context: starters typically exit by inning 6, batters
  // see 1-3 ABs against opposing bullpen. Bullpen ERA drives the
  // remaining offensive expectation. League avg bullpen ERA ~4.00.
  // Bucket-based ±6 on opposing-team bullpen ERA. Gated ≥30 IP.
  // Higher ERA = weaker bullpen = boost batter (over stronger).
  // Applies to all 4 batter markets. Weight: w_mlb_bullpen_quality.
  // ============================================================
  let f_bullpenQuality = 0;
  const oppBp = ctx.opposingBullpen ?? null;
  if (oppBp && oppBp.bullpen_era !== null && (oppBp.bullpen_ip ?? 0) >= 30) {
    const era = oppBp.bullpen_era;
    if (era >= 5.50)      f_bullpenQuality = 6;
    else if (era >= 4.75) f_bullpenQuality = 3;
    else if (era >= 4.25) f_bullpenQuality = 1;
    else if (era <= 2.50) f_bullpenQuality = -6;
    else if (era <= 3.25) f_bullpenQuality = -3;
    else if (era <= 3.75) f_bullpenQuality = -1;
  }
  f_bullpenQuality *= sideFlip;
  const score_bullpen_quality = roundHalfAwayFromZero(f_bullpenQuality * W_BATTER.bullpenQuality);  // D-362 — DB-tunable via w_mlb_bullpen_quality

  // ============================================================
  // D-284 SHIP 2 — pitcher_hr_per_9 (HR-MARKET-ONLY deep signal)
  // Existing score_pitcher_hr_rate fires across all power markets
  // (HR+TB+RBI) using ratio buckets vs LEAGUE_AVG_HR_PER_9. This new
  // factor is HR-market-only with sharper absolute-value buckets,
  // gated ≥30 IP. Complementary signal (not duplicate). Tunable via
  // algorithm_weights.w_mlb_pitcher_hr_per_9.
  // ============================================================
  // ============================================================
  // D-287 SHIP 1 — wind_direction_hr factor (HR-MARKET-ONLY)
  // Combines today's wind direction (degrees, FROM-convention) with
  // ballpark CF compass bearing to determine "out", "in", or
  // "crosswind" effect on HR rate. cos(delta) signed effect; magnitude
  // scaled by wind speed (5/15 mph thresholds). Domed/closed-roof
  // parks return 0 (no wind effect). Buckets ±6, gated wind ≥5 mph.
  // ============================================================
  let f_windDirHr = 0;
  const bo = ctx.ballparkOrientation ?? null;
  const ws = (weather?.windSpeed ?? 0);
  const wd = weather?.windDirDeg ?? null;
  const isIndoor = weather?.condition === "indoor" || (bo?.is_dome ?? false);
  // D-689 widened. Pre-D-689 = 5.9% fire (ws≥5 + outdoor + CF-alignment). Lowered
  // ws floor to ≥3 and added 0.08 mild band so even crosswinds nudge the score.
  if (marketStat === "homeRuns" && bo && !isIndoor && wd !== null && ws >= 3) {
    const windTo = (wd + 180) % 360;
    let delta = Math.abs(windTo - bo.cf_compass_degrees) % 360;
    if (delta > 180) delta = 360 - delta;
    const dirEffect = Math.cos((delta * Math.PI) / 180);
    const speedMult = ws >= 15 ? 1.0 : ws >= 10 ? 0.6 : ws >= 5 ? 0.4 : 0.2;
    const score = dirEffect * speedMult;
    if (score >= 0.6)       f_windDirHr = 6;
    else if (score >= 0.3)  f_windDirHr = 3;
    else if (score >= 0.15) f_windDirHr = 1;
    else if (score >= 0.08) f_windDirHr = 1;  // D-689 mild crosswind-but-tailwind-ish
    else if (score <= -0.6) f_windDirHr = -6;
    else if (score <= -0.3) f_windDirHr = -3;
    else if (score <= -0.15) f_windDirHr = -1;
    else if (score <= -0.08) f_windDirHr = -1; // D-689 mild crosswind-but-headwind-ish
  }
  f_windDirHr *= sideFlip;
  const score_wind_direction_hr = roundHalfAwayFromZero(f_windDirHr * W_BATTER.windDirectionHr);  // D-362 — DB-tunable via w_mlb_wind_direction_hr

  let f_pitcherHrPer9 = 0;
  // Gate: ≥20 IP signal floor (mid-season starters typically ≥30 IP after
  // 5+ starts; relief or recent-callup pitchers can be lower).
  if (marketStat === "homeRuns" && opposingPitcher && opposingPitcher.inningsPitched >= 20) {
    const hr9 = opposingPitcher.hrPerNine;
    if (hr9 >= 1.8)       f_pitcherHrPer9 = 6;
    else if (hr9 >= 1.4)  f_pitcherHrPer9 = 3;
    else if (hr9 >= 1.1)  f_pitcherHrPer9 = 1;
    else if (hr9 <= 0.6)  f_pitcherHrPer9 = -6;
    else if (hr9 <= 0.9)  f_pitcherHrPer9 = -3;
    else if (hr9 <= 1.0)  f_pitcherHrPer9 = -1;
  }
  f_pitcherHrPer9 *= sideFlip;
  const score_pitcher_hr_per_9 = roundHalfAwayFromZero(f_pitcherHrPer9 * W_BATTER.pitcherHrPer9);  // D-362 — DB-tunable via w_mlb_pitcher_hr_per_9

  // ============================================================
  // D-661 FACTOR — score_pitcher_gb_fb_rate
  // D-803 UNGATE — was HR-only pre-D-803. D-800 audit identified this as
  // a "MARKET-GATE-MISTAKE" — the factor was fully implemented + the data
  // was in OpposingPitcherContext.groundOutsToAirouts, but the gate at
  // line 4231 (pre-D-803) blocked TB and RBI from seeing it. A flyball-
  // prone pitcher allows MORE extra-base hits, not just HRs — the same
  // physics that drives HR-OVER on flyballers drives TB-OVER (and RBI-
  // OVER) on the same matchup. D-803 widens the gate to {homeRuns,
  // totalBases, rbi}.
  //
  // BUCKET MAGNITUDE NOTE (D-803): the HR buckets ±5 may overshoot for
  // TB/RBI which have broader outcome distributions. Conservative seed:
  // KEEP the current buckets, accept the marginal over-contribution on
  // TB/RBI (max ±5 → ±5pp confidence shift). The D-789 PAV ceiling
  // (UNDER 69 / OVER 45) caps anything inflated. If the D-803 retune
  // (D-798 forward-data successor) shows the magnitudes overshoot, the
  // §19.3 follow-up can introduce per-market buckets. Silently halving
  // here would be a tune-without-approval — flagged in d803.md instead.
  //
  // groundOutsToAirouts ratio from MLB Stats API season pitching stats.
  // League avg ~1.10. Groundballers (high ratio) don't allow homers
  // regardless of ERA. Bucket-based ±5, gated ≥20 IP signal floor.
  // SUPPRESSES over (negative on OVER) when high.
  //
  // Weight LITERAL 1.0 (provisional; no w_mlb_pitcher_gb_fb_rate column
  // yet — D-682 optimizer will fit + add column per D-498 8-column-gap
  // pattern). PROVENANCE flag d661_gb_fb_factor_wired=true on breakdown
  // so post-D-661 picks are distinguishable in audits.
  // ============================================================
  let f_pitcherGbFb = 0;
  if ((marketStat === "homeRuns" || marketStat === "totalBases" || marketStat === "rbi")
      && opposingPitcher
      && opposingPitcher.inningsPitched >= 20
      && opposingPitcher.groundOutsToAirouts !== null) {
    const gbfb = opposingPitcher.groundOutsToAirouts;
    // High ratio → groundballer → suppress XBH (negative on OVER).
    if (gbfb >= 1.50)       f_pitcherGbFb = -5;   // elite GB suppression
    else if (gbfb >= 1.30)  f_pitcherGbFb = -3;
    else if (gbfb >= 1.15)  f_pitcherGbFb = -1;
    else if (gbfb <= 0.70)  f_pitcherGbFb = 5;    // extreme flyballer → XBH boost
    else if (gbfb <= 0.85)  f_pitcherGbFb = 3;
    else if (gbfb <= 1.00)  f_pitcherGbFb = 1;
  }
  f_pitcherGbFb *= sideFlip;
  // Literal weight 1.0 — provisional, awaits optimizer fit + column add.
  const score_pitcher_gb_fb_rate = roundHalfAwayFromZero(f_pitcherGbFb * 1.0);

  // ============================================================
  // D-803 FACTOR — score_pitcher_hard_contact_allowed
  // Closes the D-800 LOADED-THEN-DROPPED finding: pitcher's hard-hit %
  // allowed (ev95percent from cache_statcast_pitchers_exit_velo) was being
  // fetched into _pitcherCache but dropped at OpposingPitcherContext.
  // D-803 wires it through.
  //
  // This is the MATCHUP-SIDE COUNTERPART to D-797's score_batter_hard_hit.
  // The literal TB matchup: batter hard-hit % × pitcher hard-hit-allowed %
  // distinguishes a real power matchup from a generic batter vs avg pitcher.
  //
  // League-avg pitcher allows ~38% hard-hit %, elite suppresses < 33%,
  // worst allows > 45%. Symmetric ±5 buckets. Gated TB / HR / RBI markets
  // (power-flavored). Requires opposingPitcher.inningsPitched ≥ 20 sample
  // floor (same as D-661 gb_fb_rate).
  //
  // Sign convention: pitcher who allows MORE hard contact → batter
  // advantage → positive on OVER. f_hardContactAllowed *= sideFlip applied
  // after bucket assignment.
  // ============================================================
  let f_pitcherHardContactAllowed = 0;
  // D-823 PART 1 — UNGATE for hits. Pitchers who allow more hard contact
  // allow more hits, not just XBH. Same one-line ungate as hard_hit above.
  if ((marketStat === "totalBases" || marketStat === "homeRuns" || marketStat === "rbi" || marketStat === "hits")
      && opposingPitcher
      && opposingPitcher.inningsPitched >= 20
      && opposingPitcher.oppPitcherEv95Percent !== null) {
    const ev95 = opposingPitcher.oppPitcherEv95Percent;
    if (ev95 >= 50)      f_pitcherHardContactAllowed = 5;   // worst allowance — big boost
    else if (ev95 >= 43) f_pitcherHardContactAllowed = 3;
    else if (ev95 >= 40) f_pitcherHardContactAllowed = 1;
    else if (ev95 <= 28) f_pitcherHardContactAllowed = -5;  // elite suppression — big damp
    else if (ev95 <= 33) f_pitcherHardContactAllowed = -3;
    else if (ev95 <= 37) f_pitcherHardContactAllowed = -1;
  }
  f_pitcherHardContactAllowed *= sideFlip;
  const score_pitcher_hard_contact_allowed = roundHalfAwayFromZero(f_pitcherHardContactAllowed * W_BATTER.pitcherHardContactAllowed);

  // ============================================================
  // D-816 — score_batter_pull_rate (HR-MARKET-ONLY missing-factor closure).
  // D-811 audit found pull_rate / spray_angle entirely absent — pull-heavy
  // fly-ball hitters at power-friendly parks are the classic HR profile.
  // Built via Baseball Savant batted-ball direction leaderboard.
  // PRIMARY SIGNAL: pull_air_rate (fraction of batted balls that are PULLED
  // AIR = pull + fly/LD). League avg ~20%, elite (Stanton/Schwarber tier)
  // ≥28%, pull-rare (slap hitters) ≤14%. Buckets ±5/±3/±1 around 0.20.
  // Falls back to pull_rate alone when pull_air_rate is null.
  // ============================================================
  let f_pullRate = 0;
  if (marketStat === "homeRuns" && ctx.batterPullRate) {
    const par = ctx.batterPullRate.pull_air_rate ?? ctx.batterPullRate.pull_rate * 0.5;
    if (par >= 0.28)        f_pullRate = 5;
    else if (par >= 0.24)   f_pullRate = 3;
    else if (par >= 0.22)   f_pullRate = 1;
    else if (par <= 0.12)   f_pullRate = -5;
    else if (par <= 0.16)   f_pullRate = -3;
    else if (par <= 0.18)   f_pullRate = -1;
  }
  f_pullRate *= sideFlip;
  const score_batter_pull_rate = roundHalfAwayFromZero(f_pullRate * W_BATTER.pullRate);

  // ============================================================
  // D-824 — score_batter_contact_rate (HITS-MARKET-ONLY missing-factor closure).
  // D-822 audit flagged contact-rate / whiff-rate as the hits-specific
  // discriminator (the "pull_rate equivalent" for hits). High contact + low
  // whiff → more balls in play → more hits (the OVER side). Source: Baseball
  // Savant plate-discipline leaderboard, min=100 PA gate.
  //
  // PRIMARY SIGNAL: whiff_percent (INVERSE relationship to hits — high whiff
  // means fewer balls in play, lower hit rate). League avg ~24-25%, elite
  // contact (Arraez/Steer tier) ≤15%, high-whiff (Gallo tier) ≥32%.
  //
  // Buckets ±5/±3/±1 around league-avg ~24%. Symmetric on each side. Sign
  // convention: high contact (low whiff) → POSITIVE = favor OVER.
  // ============================================================
  let f_contactRate = 0;
  if (marketStat === "hits" && ctx.batterContactRate) {
    const whiff = ctx.batterContactRate.whiff_percent;
    if      (whiff <= 15)  f_contactRate = 5;    // elite contact → strong OVER
    else if (whiff <= 18)  f_contactRate = 3;
    else if (whiff <= 21)  f_contactRate = 1;
    else if (whiff >= 32)  f_contactRate = -5;   // high whiff → strong UNDER
    else if (whiff >= 29)  f_contactRate = -3;
    else if (whiff >= 27)  f_contactRate = -1;
  }
  f_contactRate *= sideFlip;
  const score_batter_contact_rate = roundHalfAwayFromZero(f_contactRate * W_BATTER.contactRate);

  // ============================================================
  // D-817 — score_batter_pull_x_park_fence (HR-ONLY directional amplifier).
  // The CLASSIC HR setup: pull-heavy hitter at a short-pull-side fence.
  // Handedness routing:
  //   bats='L' → pulls RF → use park.rf_distance
  //   bats='R' → pulls LF → use park.lf_distance
  //   bats='S' → switch hitter, resolved via opposingPitcher.throws:
  //     vs RHP → bats lefty → pulls RF
  //     vs LHP → bats righty → pulls LF
  //     unknown opp hand → default to deeper (no boost) — fail-safe to 0
  //
  // Bucket asymmetry: only HIGH pull benefits substantially from SHORT fence.
  // Low-pull hitter at Yankee Stadium gets no extra boost (they don't pull
  // to RF anyway). High-pull hitter at deep park (Comerica 420ft CF, deep
  // gaps) gets suppressed because their pull power can't clear the wall.
  // ============================================================
  let f_pullXFence = 0;
  if (marketStat === "homeRuns" && ctx.batterPullRate && ctx.parkDimensions && season.bats) {
    const par = ctx.batterPullRate.pull_air_rate ?? ctx.batterPullRate.pull_rate * 0.5;
    let pullSideFence: number | null = null;
    // Resolve effective bats side for switch hitters.
    let effectiveBats: "L" | "R" | null = null;
    if (season.bats === "L") effectiveBats = "L";
    else if (season.bats === "R") effectiveBats = "R";
    else if (season.bats === "S") {
      // Switch: opposite-hand of opposing pitcher.
      const oppHand = opposingPitcher?.throws;
      if (oppHand === "R") effectiveBats = "L";       // vs RHP, switch bats lefty → pulls RF
      else if (oppHand === "L") effectiveBats = "R";  // vs LHP, switch bats righty → pulls LF
      // unknown opp hand → leave null → no boost
    }
    if (effectiveBats === "L") pullSideFence = ctx.parkDimensions.rf_distance;
    else if (effectiveBats === "R") pullSideFence = ctx.parkDimensions.lf_distance;

    if (pullSideFence !== null) {
      // Combined buckets — asymmetric (high pull benefits most from short fence).
      if (par >= 0.22 && pullSideFence <= 315)        f_pullXFence = 5;   // HR factory (Yankee RF 314 + lefty pull = textbook)
      else if (par >= 0.22 && pullSideFence <= 325)   f_pullXFence = 3;
      else if (par >= 0.20 && pullSideFence <= 320)   f_pullXFence = 2;
      else if (par >= 0.22 && pullSideFence >= 345)   f_pullXFence = -3;  // pull power suppressed by deep fence
      else if (par >= 0.22 && pullSideFence >= 335)   f_pullXFence = -1;
      else if (par <= 0.16 && pullSideFence <= 320)   f_pullXFence = -1;  // low-pull at short porch — doesn't exploit it
    }
  }
  f_pullXFence *= sideFlip;
  const score_batter_pull_x_park_fence = roundHalfAwayFromZero(f_pullXFence * W_BATTER.pullXParkFence);

  // ============================================================
  // D-520-APPLY — D-517 v2 score_batter_line_hit_rate (penalty-only)
  // Penalty bands on last10 line-hit-rate %. No reward — only damping
  // on weak l10. recentHitRate already incorporates pick side, so no
  // sideFlip. Gated to require recentN >= 10 (returns -1 otherwise
  // which skips the penalty so we don't punish thin samples).
  // CEO §19.3 approved 2026-06-13.
  // ============================================================
  // D-689 widened gameLog floor 10 → 5. Pre-D-689 = 1.7% fire on HR market
  // (most HR picks have <10 game history because call-ups, fresh promotes,
  // post-injury). L5 lookback gives weaker signal but factor fires more often.
  const l10Pct_for_factor = gameLog.length >= 5
    ? Math.round(recentHitRate(gameLog, prop.line, prop.pickSide, marketStat))
    : -1;
  let f_lineHitRate = 0;
  if (l10Pct_for_factor >= 0) {
    if      (l10Pct_for_factor >= 60) f_lineHitRate = 0;
    else if (l10Pct_for_factor >= 50) f_lineHitRate = -3;
    else if (l10Pct_for_factor >= 40) f_lineHitRate = -6;
    else if (l10Pct_for_factor >= 30) f_lineHitRate = -10;
    else                              f_lineHitRate = -15;
  }
  const score_batter_line_hit_rate = roundHalfAwayFromZero(f_lineHitRate * W_BATTER.lineHitRate);

  // ============================================================
  // D-797 — score_batter_xwoba (xwOBA — THE single best TB predictor)
  // Research: xwOBA assigns each batted ball a 1B/2B/3B/HR probability
  // from exit velo + launch angle — the per-batted-ball weighted on-base
  // value. Highest-information single-stat predictor of total bases in
  // MLB analytics; D-796 confirmed it was MISSING from the model (data
  // was loaded, dropped at BatterStatcastContext interface).
  // League avg xwOBA ~.320, elite > .380, poor < .280.
  // Applies to contact + extra-base markets: hits, totalBases, rbi.
  // ============================================================
  let f_xwoba = 0;
  // D-815 PART 1 — UNGATE for homeRuns. D-811 audit found xwOBA was loaded
  // into ctx.statcast (est_woba) but the gate excluded homeRuns — proven
  // dark on Nootbaar 0.398/Caissie 0.296/Winn 0.304/Stowers 0.325/Edwards 0.327
  // (real data, stored 0 because of the gate). xwOBA combines EV + LA + spray
  // → strongest HR-predictor in Statcast. Same one-line-gate fix pattern as
  // D-803 PART 2 (gb_fb HR→TB ungate).
  if (sc && sc.est_woba !== null && (marketStat === "hits" || marketStat === "totalBases" || marketStat === "rbi" || marketStat === "homeRuns")) {
    const xwoba_diff = sc.est_woba - 0.320;  // league-avg xwOBA
    if (xwoba_diff >= 0.060)       f_xwoba = 8;   // elite (>.380)
    else if (xwoba_diff >= 0.030)  f_xwoba = 4;   // above-avg (>.350)
    else if (xwoba_diff >= 0.010)  f_xwoba = 1;   // mild (>.330)
    else if (xwoba_diff <= -0.060) f_xwoba = -8;  // poor (<.260)
    else if (xwoba_diff <= -0.030) f_xwoba = -4;  // below-avg (<.290)
    else if (xwoba_diff <= -0.010) f_xwoba = -1;  // mild
  }
  f_xwoba *= sideFlip;
  const score_batter_xwoba = roundHalfAwayFromZero(f_xwoba * W_BATTER.xwoba);

  // ============================================================
  // D-797 — score_batter_launch_angle (avg launch angle — extra-base signal)
  // Research: optimal launch angle 8-32° (sweet-spot range). Sub-5° = grounders.
  // 12-20° = line drives / doubles. 25-35° = HR optimal. >35° = popups.
  // Applies to TB / HR / RBI (extra-base markets). For HR, optimal is higher
  // (~25-30°). For TB, mid-range 12-25° is best (catches 2B + low-angle HR).
  // ============================================================
  let f_launchAngle = 0;
  if (sc && sc.avg_hit_angle !== null && (marketStat === "totalBases" || marketStat === "homeRuns" || marketStat === "rbi")) {
    const la = sc.avg_hit_angle;
    if (marketStat === "homeRuns") {
      if (la >= 22 && la <= 32)      f_launchAngle = 4;   // HR sweet spot
      else if (la >= 18 && la <= 35) f_launchAngle = 2;
      else if (la < 5)               f_launchAngle = -5;  // grounders → no HRs
      else if (la > 40)              f_launchAngle = -3;  // popups
    } else {
      // TB / RBI: line-drive zone is sweetest (2B + low-angle HR + clean hits)
      if (la >= 10 && la <= 22)      f_launchAngle = 4;   // line-drive zone
      else if (la >= 8 && la <= 28)  f_launchAngle = 2;
      else if (la < 3)               f_launchAngle = -5;  // pure grounders
      else if (la > 35)              f_launchAngle = -3;  // popups
    }
  }
  f_launchAngle *= sideFlip;
  const score_batter_launch_angle = roundHalfAwayFromZero(f_launchAngle * W_BATTER.launchAngle);

  // ============================================================
  // D-797 — score_batter_sweet_spot (% batted balls in 8-32° sweet-spot zone)
  // Research: anglesweetspotpercent measures consistency of launch-angle
  // optimality. League avg ~33%, elite >40%, poor <26%.
  // Applies to TB / HR / RBI (extra-base markets).
  // ============================================================
  let f_sweetSpot = 0;
  if (sc && sc.anglesweetspotpercent !== null && (marketStat === "totalBases" || marketStat === "homeRuns" || marketStat === "rbi")) {
    const ss = sc.anglesweetspotpercent;
    if (ss >= 42)      f_sweetSpot = 5;   // elite
    else if (ss >= 37) f_sweetSpot = 3;
    else if (ss >= 34) f_sweetSpot = 1;
    else if (ss <= 26) f_sweetSpot = -5;  // poor
    else if (ss <= 30) f_sweetSpot = -3;
    else if (ss <= 32) f_sweetSpot = -1;
  }
  f_sweetSpot *= sideFlip;
  const score_batter_sweet_spot = roundHalfAwayFromZero(f_sweetSpot * W_BATTER.sweetSpot);

  // ============================================================
  // D-797 — score_batter_hard_hit (ev95percent — % batted balls ≥95mph)
  // Research: hard-hit % is THE most stable power predictor (stabilizes at
  // ~30 PA). League avg ~38%, elite >50%, poor <30%.
  // Complementary to barrel_rate (which requires BOTH high EV AND optimal LA);
  // hard_hit captures the raw EV-only signal. Applies to TB / HR / RBI.
  // ============================================================
  let f_hardHit = 0;
  // D-823 PART 1 — UNGATE for hits. D-822 audit found hard_hit was excluded
  // from hits via this gate. Hard contact creates more line drives → more
  // hits. Mirror of D-815 xwoba HR-ungate / D-803 PART 2 gb_fb TB-ungate.
  if (sc && sc.ev95percent !== null && (marketStat === "totalBases" || marketStat === "homeRuns" || marketStat === "rbi" || marketStat === "hits")) {
    const hh = sc.ev95percent;
    if (hh >= 52)      f_hardHit = 5;   // elite
    else if (hh >= 45) f_hardHit = 3;
    else if (hh >= 40) f_hardHit = 1;
    else if (hh <= 28) f_hardHit = -5;  // poor
    else if (hh <= 33) f_hardHit = -3;
    else if (hh <= 37) f_hardHit = -1;
  }
  f_hardHit *= sideFlip;
  const score_batter_hard_hit = roundHalfAwayFromZero(f_hardHit * W_BATTER.hardHit);

  // D-691 / M5 — WIN-PROBABILITY CONFIDENCE (Poisson batter markets). Factors nudge λ;
  // confidence = round(P(win | Poisson(λ)) × 100) with shrinkage above 60%.
  let winProb_d691 = 0;
  let confidence_raw_d691 = 0;
  let lambdaAdjusted_d691 = 0;
  let factorSum_d691 = 0;
  const usePoissonWinProb = isPoissonBatterStat(marketStat) &&
    !poissonDisabledForHarness();

  if (usePoissonWinProb) {
    factorSum_d691 = (
      score_batter_hit_rate + score_batter_form + score_opposing_pitcher_quality +
      score_recent_at_bats + score_handedness_matchup + score_ballpark_factor +
      score_weather_temp + score_lineup_consistency +
      score_batter_power_rate + score_batter_form_power + score_pitcher_hr_rate +
      score_weather_wind +
      score_lineup_spot + score_day_after_night_fatigue + score_travel_getaway +
      score_pitcher_baa_vs_hand + score_hitter_streak_fatigue +
      score_opp_pitcher_pitchtype_quality +
      score_batter_barrel_rate + score_batter_xslg_regression + score_batter_xba +
      score_batter_exit_velo_trend + score_batter_babip + score_batter_vs_pitcher_hand_split +
      score_bullpen_quality + score_pitcher_hr_per_9 + score_wind_direction_hr +
      score_batter_line_hit_rate + score_pitcher_gb_fb_rate +
      score_batter_xwoba + score_batter_launch_angle + score_batter_sweet_spot +
      score_batter_hard_hit + score_pitcher_hard_contact_allowed +
      score_batter_pull_rate + score_batter_pull_x_park_fence +
      score_batter_contact_rate
    );
    const lambdaMultiplier_d691 = clamp(1.0 + (factorSum_d691 * sideFlip) * getLambdaCoeff(), 0.65, 1.40);
    lambdaAdjusted_d691 = projectedStat * lambdaMultiplier_d691;
    winProb_d691 = winProbPoissonK(lambdaAdjusted_d691, prop.line, prop.pickSide as "over" | "under");
    confidence_raw_d691 = clamp(Math.round(winProb_d691 * 100), 0, 100);
    confidence = shrinkPoissonConfidence(confidence_raw_d691);
    confidence = clamp(confidence, 0, 100);
  } else {
    confidence += score_batter_barrel_rate + score_batter_xslg_regression + score_batter_xba + score_batter_exit_velo_trend + score_batter_babip + score_batter_vs_pitcher_hand_split + score_bullpen_quality + score_pitcher_hr_per_9 + score_wind_direction_hr + score_batter_line_hit_rate
                + score_pitcher_gb_fb_rate  // D-661 (HR-gated; 0 elsewhere)
                + score_batter_xwoba + score_batter_launch_angle + score_batter_sweet_spot + score_batter_hard_hit  // D-797
                + score_pitcher_hard_contact_allowed  // D-803
                + score_batter_pull_rate              // D-816 (HR-gated)
                + score_batter_pull_x_park_fence      // D-817 (HR-gated)
                + score_batter_contact_rate;          // D-824 (hits-gated)
    confidence = clamp(Math.round(confidence), 0, 100);
  }

  // D-467 — Edge-sign floor (non-hits only; obsolete under D-691 win-prob for hits).
  // the pick direction (side-adjusted edge < 0), confidence cannot reach
  // GOOD/STRONG/ELITE. Caps at 69 so the pick falls below the Sonnet gate
  // (anthropic_mlb.ts:87 SONNET_CONFIDENCE_GATE=70) and into template
  // fallback. D-466 quantified the gap: 35.6% of high-conf MLB picks
  // were getting FADE narratives; 100% of high-conf HR-OVER picks (13/13)
  // had negative side-adjusted edge while reaching STRONG/ELITE. The
  // narrative was correctly flagging via SELF-CHECK (D-465); the algorithm
  // now agrees by capping at 69 on picks where its own projection says the
  // bet direction is wrong.
  //
  // Layers BEFORE D-140 trivial-line cap (lines 1581-1584): D-467 fires
  // first at 69, D-140 may then cap further to 65 on tiny-line + heavy
  // juice picks. D-456 HR-OVER carve-out from D-140 is preserved — but
  // the same HR-OVER picks D-456 unblocked are now caught by D-467 when
  // their projection is below the line (which D-466 showed is 100% of
  // the high-conf HR-OVER cohort).
  //
  // `edge` is already side-adjusted at line 1018: `(projectedStat - line) * sideFlip`.
  // So edge < 0 means: OVER picks where projection < line, OR UNDER picks
  // where projection > line. Either way, the algo's own model contradicts
  // the bet direction.
  let d467_edge_floor_delta = 0;
  if (!usePoissonWinProb && edge < 0 && confidence > 69) {
    d467_edge_floor_delta = confidence - 69;
    confidence = 69;
  }

  // D-406: capture pre-cap confidence (full pipeline complete; cap is the last
  // op for batter market — no factors added after, so this IS the true pre-cap).
  // D-467: pre_cap reflects post-edge-floor value; the d467_edge_floor_delta
  // is tracked separately above. Pre_cap still means "before D-140 trivial cap".
  const confidence_pre_cap = confidence;

  // D-140 trivial-line cap
  // D-456: HR-OVER carve-out. D-405 + D-446 data showed HR-OVER picks
  // structurally cannot clear conf >= 70 because line=0.5 + odds>=200 + conf>65
  // snaps every HR-OVER above 65 to 65. UNDER + all other markets keep the
  // cap unchanged. The carve-out applies ONLY to (marketStat===homeRuns &&
  // pickSide===over). Final-confidence pre-cap snapshot at line 1560 is
  // unchanged — pre_cap will simply equal final confidence for carved-out
  // HR-OVER picks (no snap applied).
  if (prop.line <= 0.5 && Math.abs(prop.odds) >= 200 && confidence > 65
      && !(marketStat === "homeRuns" && prop.pickSide === "over")) {
    confidence = 65;
  }

  // D-479 — longshot OVER trap structural cap. Sibling of D-140.
  // Real-data finding (n=164): GOOD-tier OVER at +100-or-longer odds
  // runs WR 34% vs BE 40% (EDGE -5.9%, ROI -17.1%). Conf formula
  // doesn't penalize the longshot base rate. Cap to 65 (drops to
  // LEAN tier so picks stop surfacing as high-conf buys). HR-OVER
  // carve-out preserved (D-456 lottery cohort retained, consistent
  // with D-140 carve-out treatment).
  if (prop.pickSide === "over" && prop.odds >= 100
      && confidence >= 70 && confidence <= 79
      && marketStat !== "homeRuns") {
    confidence = 65;
  }

  // D-509 — ELITE/STRONG longshot OVER cap (sibling of D-479).
  // Post-D-506 backfill: conf>=80 OVER at +150+ in MLB runs WR 23.36%
  // ROI ~-34% on n=107. D-479 covered the GOOD tier only; D-509
  // extends the structural cap to the premium tiers.
  //
  // D-510 — rbi carve-out REMOVED after re-verify on pick_history_real
  // (post-D-506 fresh data). The +4% basis from D-505 (n=26) had
  // reverted to a confirmed bleed: n=76 WR 23.68% ROI -33.55% on
  // odds>=+150. ELITE 90+ sub-band catastrophic at WR 6.67% ROI -83%
  // (n=15); STRONG 80-89 at WR 27.87% ROI -21.39% (n=61). +100..149
  // band remains near BE (n=62 WR 43.55% ROI -1.40%) and is NOT
  // included in this cap (odds gate is >=150). HR carve-out (D-456
  // lottery cohort) preserved unchanged.
  if (prop.pickSide === "over" && confidence >= 80 && prop.odds >= 150
      && marketStat !== "homeRuns") {
    confidence = 75;
  }

  // === D-789 ISOTONIC CALIBRATION (TB only, per-side PAV) ==========
  // Applied AFTER D-140 / D-479 / D-509 caps so calibration sees post-cap
  // confidence and remaps to OOS-validated empirical hit rate per bucket.
  // PER-SIDE (under vs over calibrate differently — ~23pp WR gap on
  // cohort). Honest ceilings: 69 under, 45 over. NO TB PICK CAN SHOW
  // ABOVE THESE POST-D-789. Pre-D-789: OVER 90-100 hit 35%, UNDER 90-100
  // hit 66% — model was systematically over-confident at high tiers,
  // worse than batter_runs_scored (D-784).
  if (marketStat === "totalBases" && !usePoissonWinProb) {
    confidence = applyD789IsotonicCalibrationBatterTotalBases(confidence, prop.pickSide);
  }
  // D-815 — HR per-side PAV calibration. PAV-derived from 9,473 resolved
  // HR picks (n=2,075 OVER plus-money / n=7,398 UNDER minus-money). OOS-
  // validated 70/30 split (gap <0.01 MAE on both sides). Honest ceilings:
  // UNDER 91% (vs avg BE 92.9% → still -2pp vig at ceiling); OVER 20% (vs
  // avg BE 7.3% → +12.7pp EDGE potential at ceiling for top OVER picks).
  // CALIBRATION AGAINST REAL PLUS-MONEY BREAKEVEN: HR OVER is +200/+500;
  // a 20% realized rate at +400 = +EV (BE there is 20%). Calibration
  // REVEALS edge availability rather than masking it. Pre-D-815: stale
  // conf=100 UNDER (May 22-26) + conf=96 OVER (June 10-20) on dashboard.
  if (marketStat === "homeRuns" && !usePoissonWinProb) {
    confidence = applyD815IsotonicCalibrationBatterHomeRuns(confidence, prop.pickSide);
  }

  // Sanity flags
  let unbettableJuiceFlag = false;
  if (prop.pickSide === "under") {
    if (confidence >= 90 && prop.odds <= -350)      unbettableJuiceFlag = true;
    else if (confidence >= 80 && prop.odds <= -300) unbettableJuiceFlag = true;
    else if (confidence >= 70 && prop.odds <= -250) unbettableJuiceFlag = true;
    else if (confidence >= 60 && prop.odds <= -200) unbettableJuiceFlag = true;
  }

  let unbettableOverBreakevenFlag = false;
  if (usePoissonWinProb && prop.pickSide === "over") {
    const breakevenPct = impliedProbAmerican(prop.odds) * 100;
    unbettableOverBreakevenFlag = winProb_d691 * 100 <= breakevenPct;
  }

  const poissonEvFields = usePoissonWinProb
    ? { winProb: winProb_d691, ...computeEvFromWinProb(winProb_d691, prop.odds) }
    : {};

  const last10HitRate = recentHitRate(gameLog, prop.line, prop.pickSide, marketStat);
  // D-229 Fix 3 — compute last5 + season hit rates for PickCard display.
  const last5HitRate = hitRateOverWindow(gameLog.slice(-5), prop.line, prop.pickSide, marketStat);
  const seasonHitRate = hitRateOverWindow(gameLog, prop.line, prop.pickSide, marketStat);
  const coinFlipFlag = confidence >= 80 && last10HitRate >= 40 && last10HitRate <= 60;

  const factorArr = [
    score_batter_hit_rate, score_batter_form, score_opposing_pitcher_quality,
    score_recent_at_bats, score_handedness_matchup, score_ballpark_factor,
    score_weather_temp, score_lineup_consistency, score_batter_power_rate,
    score_batter_form_power, score_pitcher_hr_rate, score_weather_wind,
    // D-276-FACTORS Statcast additions (count toward negativeStackingFlag eval)
    score_batter_barrel_rate, score_batter_xslg_regression,
    // D-281 SHIP 2 — BABIP regression factor
    score_batter_babip,
    // D-282 SHIP 1 — batter hand split
    score_batter_vs_pitcher_hand_split,
    // D-283 SHIP 4 — bullpen quality (opposing)
    score_bullpen_quality,
    // D-284 SHIP 2 — pitcher HR/9 (HR market only)
    score_pitcher_hr_per_9,
    // D-287 SHIP 1 — wind direction × ballpark (HR market only)
    score_wind_direction_hr,
    // D-347 — 3 new batter factors
    score_lineup_spot, score_day_after_night_fatigue, score_travel_getaway,
    // D-349 — opposing pitcher BAA vs this batter's hand
    score_pitcher_baa_vs_hand,
    // D-354 — hitter streak fatigue
    score_hitter_streak_fatigue,
    // D-520-APPLY — D-517 v2 line-hit-rate penalty
    score_batter_line_hit_rate,
    // D-598 — opposing pitcher pitch-type matchup (batter-side)
    score_opp_pitcher_pitchtype_quality,
    // D-661 — pitcher groundball/flyball rate (HR market only)
    score_pitcher_gb_fb_rate,
    // D-797 — 4 new extra-base factors (TB primary).
    score_batter_xwoba, score_batter_launch_angle, score_batter_sweet_spot, score_batter_hard_hit,
    // D-803 — pitcher hard-contact-allowed (matchup counterpart to hard_hit).
    score_pitcher_hard_contact_allowed,
    // D-816 — pull rate (HR-only missing factor).
    score_batter_pull_rate,
    // D-817 — pull × pull-side fence (HR-only directional amplifier).
    score_batter_pull_x_park_fence,
    // D-824 — batter contact-rate / whiff-rate (hits-only discriminator).
    score_batter_contact_rate,
  ];
  const negativeFactorCount = factorArr.filter((v) => v < 0).length;
  const negativeStackingFlag = confidence >= 80 && negativeFactorCount >= 3;

  const breakdown: Record<string, number | string | null | boolean> = {
    market_stat: marketStat,
    season_games: season.gamesPlayed,
    season_avg_per_game: Math.round(seasonAvgPerGame * 1000) / 1000,
    season_ba: Math.round(season.battingAvg * 1000) / 1000,
    season_hr_per_pa: Math.round(season.hrPerPA * 10000) / 10000,
    season_iso: Math.round(season.iso * 1000) / 1000,
    last10_avg: Math.round(recentAvg * 1000) / 1000,
    last5_hit_rate_pct: Math.round(last5HitRate),
    last10_hit_rate_pct: Math.round(last10HitRate),
    season_hit_rate_pct: Math.round(seasonHitRate),
    pitcher_era: opposingPitcher?.era ?? null,
    pitcher_whip: opposingPitcher?.whip ?? null,
    pitcher_hr9: opposingPitcher?.hrPerNine ?? null,
    park_hits_factor: ballpark?.hitsFactor ?? 1.000,
    park_hr_factor: ballpark?.hrFactor ?? 1.000,
    weather_temp_f: weather?.tempF ?? null,
    weather_wind_mph: weather?.windSpeed ?? null,
    projected_stat: Math.round(projectedStat * 100) / 100,
    raw_edge: Math.round(edge * 100) / 100,
    score_batter_hit_rate, score_batter_form, score_opposing_pitcher_quality,
    score_recent_at_bats, score_handedness_matchup, score_ballpark_factor,
    score_weather_temp, score_lineup_consistency,
    score_batter_power_rate, score_batter_form_power, score_pitcher_hr_rate,
    score_weather_wind,
    // D-276-FACTORS new Statcast factors
    score_batter_barrel_rate, score_batter_xslg_regression,
    statcast_brl_pa: sc?.brl_pa ?? null,
    statcast_xslg_diff: sc?.est_slg_minus_slg_diff ?? null,
    // D-278-FACTORS additional Statcast factors
    score_batter_xba, score_batter_exit_velo_trend,
    statcast_xba: sc?.est_ba ?? null,
    statcast_avg_hit_speed: sc?.avg_hit_speed ?? null,
    // D-281 SHIP 2 — BABIP regression factor
    score_batter_babip,
    season_babip: season.babip,
    // D-282 SHIP 1 — hand split factor
    score_batter_vs_pitcher_hand_split,
    pitcher_hand_for_split: pitcherHand,
    // D-283 SHIP 4 — bullpen quality factor (opposing team)
    score_bullpen_quality,
    opposing_bullpen_era: oppBp?.bullpen_era ?? null,
    opposing_bullpen_ip: oppBp?.bullpen_ip ?? null,
    // D-284 SHIP 2 — HR-specific pitcher HR/9
    score_pitcher_hr_per_9,
    opposing_pitcher_ip: opposingPitcher?.inningsPitched ?? null,
    // D-287 SHIP 1 — wind direction × ballpark (HR market only)
    score_wind_direction_hr,
    wind_dir_deg: weather?.windDirDeg ?? null,
    wind_speed_mph: weather?.windSpeed ?? null,
    park_cf_compass_deg: bo?.cf_compass_degrees ?? null,
    park_is_dome: bo?.is_dome ?? null,
    // D-347 — 3 new batter factors
    score_lineup_spot,
    lineup_spot: ctx.lineupSpot ?? null,
    score_day_after_night_fatigue,
    day_after_night: ctx.dayAfterNight ?? false,
    score_travel_getaway,
    travel_miles: ctx.travelContext?.miles ?? null,
    travel_direction: ctx.travelContext?.direction ?? null,
    // D-349 — opposing pitcher's BAA vs this batter's hand
    score_pitcher_baa_vs_hand,
    opp_pitcher_baa_vs_lhb: ctx.opposingPitcherSplits?.baa_vs_lhb ?? null,
    opp_pitcher_baa_vs_rhb: ctx.opposingPitcherSplits?.baa_vs_rhb ?? null,
    // D-354 — hitter streak fatigue
    score_hitter_streak_fatigue,
    consecutive_starts: ctx.consecutiveStarts ?? null,
    // D-520-APPLY — D-517 v2 line-hit-rate penalty (audit field)
    score_batter_line_hit_rate,
    // D-661 — pitcher groundball/flyball rate (HR market only)
    score_pitcher_gb_fb_rate,
    opp_pitcher_ground_outs_to_airouts: opposingPitcher?.groundOutsToAirouts ?? null,
    d661_gb_fb_factor_wired: true,
    // D-598 — opposing pitcher pitch-type matchup (batter-side); plus
    // raw audit fields for future signal-gate tests + opp_pitcher_id so
    // D-599b-style joins are possible without re-fetching live probables.
    score_opp_pitcher_pitchtype_quality,
    opp_pitcher_id: ctx.opposingPitcherId ?? null,
    opp_pitcher_expected_put_away: oppArsenal?.expected_put_away ?? null,
    opp_pitcher_expected_whiff_pct: oppArsenal?.expected_whiff_pct ?? null,
    // D-797 — 4 new extra-base factors + raw Statcast inputs.
    score_batter_xwoba,
    score_batter_launch_angle,
    score_batter_sweet_spot,
    score_batter_hard_hit,
    statcast_xwoba: sc?.est_woba ?? null,
    statcast_xwoba_diff: sc?.est_woba_minus_woba_diff ?? null,
    statcast_avg_hit_angle: sc?.avg_hit_angle ?? null,
    statcast_sweet_spot_pct: sc?.anglesweetspotpercent ?? null,
    statcast_hard_hit_pct: sc?.ev95percent ?? null,
    d797_extra_base_factors_wired: true,
    // D-803 — pitcher hard-contact-allowed (matchup counterpart, TB/HR/RBI gated).
    score_pitcher_hard_contact_allowed,
    statcast_opp_pitcher_ev95_pct: opposingPitcher?.oppPitcherEv95Percent ?? null,
    statcast_opp_pitcher_brl_pa: opposingPitcher?.oppPitcherBrlPa ?? null,
    statcast_opp_pitcher_brl_pct: opposingPitcher?.oppPitcherBrlPercent ?? null,
    statcast_opp_pitcher_avg_hit_speed: opposingPitcher?.oppPitcherAvgHitSpeed ?? null,
    d803_pitcher_hard_contact_wired: true,
    // D-813 — clean-cohort provenance flag for TB / HR / RBI / hits markets.
    // True on every pick scored after D-812 + D-813 fixes (weather inline,
    // tonightLineupSpot projected fallback, nextHittersBehindOps projected
    // fallback). Forward retunes filter on this to exclude contaminated picks.
    d813_clean_cohort: true,
    // D-815 — HR-specific provenance: xwOBA HR ungate + per-side PAV cap
    // (UNDER 91 / OVER 20). True on every batter market pick scored post-D-815.
    // HR picks specifically have confidence capped via D-815 isotonic transform.
    d815_hr_calibration_applied: true,
    // D-816 — HR pull_rate factor + 3 breakdown→top-level column promotion.
    // For HR picks: score_batter_pull_rate fires from Baseball Savant data;
    // gb_fb_rate / hr_per_9 / wind_direction_hr promoted to top-level columns.
    d816_hr_factor_stack_complete: true,
    statcast_pull_rate: ctx.batterPullRate?.pull_rate ?? null,
    statcast_pull_air_rate: ctx.batterPullRate?.pull_air_rate ?? null,
    // D-817 — directional park × pull interaction. park_pull_side_fence_ft
    // is the LF or RF distance the batter pulls toward (lefty=RF, righty=LF,
    // switch via opp pitcher hand). park_pull_side='LF' or 'RF' or null.
    d817_directional_park_x_pull_wired: true,
    park_lf_distance_ft: ctx.parkDimensions?.lf_distance ?? null,
    park_cf_distance_ft: ctx.parkDimensions?.cf_distance ?? null,
    park_rf_distance_ft: ctx.parkDimensions?.rf_distance ?? null,
    // D-818 — HR-stack-complete provenance flag. True on every batter market
    // pick scored after D-818 seeds + storage proof. Forward D-820 HR retune
    // cohort filter: WHERE breakdown->>'d818_hr_stack_complete' = 'true' AND
    // created_at >= '<D-818 deploy time>'. Bulletproof — flag + deploy-time
    // gate together exclude any pre-D-818 contaminated picks.
    d818_hr_stack_complete: true,
    // D-823 — hits funnel applied: hard_hit + pitcher_hard_contact_allowed
    // ungated for hits + PAV per-side calibration (UNDER 67 / OVER 70).
    // Forward D-825 hits retune cohort filter on this flag.
    d823_hits_funnel_applied: marketStat !== "hits",
    // D-691 — win-probability path (batter_hits only).
    ...(usePoissonWinProb ? {
      d691_wired: true,
      d691_algo: "D-691: win-prob from Poisson(λ_adjusted) tail at line + shrinkage above 60%. Factors nudge λ at coef=0.002.",
      d691_lambda_base: Math.round(projectedStat * 1000) / 1000,
      d691_lambda_multiplier: Math.round((lambdaAdjusted_d691 / Math.max(projectedStat, 0.001)) * 1000) / 1000,
      d691_lambda_adjusted: Math.round(lambdaAdjusted_d691 * 1000) / 1000,
      d691_factor_sum_total: factorSum_d691,
      d691_win_prob: Math.round(winProb_d691 * 10000) / 10000,
      d691_confidence_raw: confidence_raw_d691,
      d691_implied_prob_book: Math.round(impliedProbAmerican(prop.odds) * 10000) / 10000,
      d691_edge_vs_implied: poissonEvFields.edgeVsImplied ?? 0,
      d691_ev_per_unit: poissonEvFields.evPerUnit ?? 0,
      unbettable_over_breakeven_flag: unbettableOverBreakevenFlag,
    } : {}),
    pick_side: prop.pickSide,
    bats: season.bats ?? "unknown",
    v1_algo: `8-factor MLB batter ${marketStat} (D-204) + Statcast 5-factor + hand_split (D-282) + bullpen_quality (D-283) + pitcher_hr_per_9 (D-284) + wind_dir_hr (D-287) + xwOBA/launch/sweet/hard-hit (D-797)`,
  };

  return {
    confidence,
    confidence_pre_cap,
    confidence_pre_tier_aware: confidence,
    verdict: getScoreLabel(confidence),
    projectedStat: Math.round(projectedStat * 100) / 100,
    seasonAvg: Math.round(seasonAvgPerGame * 100) / 100,
    recentAvg: Math.round(recentAvg * 100) / 100,
    edge: Math.round(edge * 100) / 100,
    score_batter_hit_rate, score_batter_form, score_opposing_pitcher_quality,
    score_recent_at_bats, score_handedness_matchup, score_ballpark_factor,
    score_weather_temp, score_lineup_consistency,
    score_batter_power_rate, score_batter_form_power, score_pitcher_hr_rate,
    score_weather_wind,
    score_lineup_spot, score_day_after_night_fatigue, score_travel_getaway,
    score_pitcher_baa_vs_hand,
    score_hitter_streak_fatigue,
    // D-520-APPLY — D-517 v2 line-hit-rate penalty
    score_batter_line_hit_rate,
    // D-598 — opposing pitcher pitch-type matchup (batter-side)
    score_opp_pitcher_pitchtype_quality,
    // D-785 — top-level persistence of Statcast + bullpen factors. obp +
    // recent_run_form are runs-specific so 0 here (preserves the "0 = N/A"
    // semantic; the 6 others are computed in this scorer).
    score_batter_obp: 0,
    score_recent_run_form: 0,
    score_bullpen_quality,
    score_batter_xba,
    score_batter_exit_velo_trend,
    score_batter_barrel_rate,
    score_batter_xslg_regression,
    score_batter_vs_pitcher_hand_split,
    // D-797 STEP 3 — fix score_batter_babip non-return (was computed +
    // contributing to confidence at line 4231 + logged to breakdown but
    // missing from the return — D-794-class). Confidence math UNCHANGED.
    score_batter_babip,
    // D-797 — 4 new extra-base factors at top-level for optimizer visibility.
    score_batter_xwoba,
    score_batter_launch_angle,
    score_batter_sweet_spot,
    score_batter_hard_hit,
    // D-803 — pitcher hard-contact-allowed matchup factor.
    score_pitcher_hard_contact_allowed,
    // D-807 — runs-only factors; zero-default to satisfy BatterMarketResult interface.
    score_batter_lineup_protection: 0,
    score_batter_team_offense: 0,
    // D-808 — runs-only baserunning factor; zero-default.
    score_batter_sprint_speed: 0,
    // D-816 — HR-only pull rate (fires only when marketStat==="homeRuns";
    // 0 on TB/RBI/hits by gate).
    score_batter_pull_rate,
    // D-817 — HR-only pull × pull-side fence interaction (0 on non-HR by gate).
    score_batter_pull_x_park_fence,
    // D-824 — hits-only contact-rate / whiff-rate (0 on non-hits by gate).
    score_batter_contact_rate,
    unbettableJuiceFlag, unbettableOverBreakevenFlag, coinFlipFlag, negativeStackingFlag, negativeFactorCount,
    ...poissonEvFields,
    breakdown,
  };
}

// ===========================================================================
// T3.3 — Game Side + Game Total
// ===========================================================================

export interface TeamSeasonContext {
  name: string;
  gamesPlayed: number;
  runsPerGame: number;
  runsAllowedPerGame: number;
  l10Runs: number | null;
  l10RunsAllowed: number | null;
  bullpenEra: number | null;
  bullpenWhip: number | null;
  // D-649 — team-level offense quality. Populated by readTeamSeasonContext
  // from cache_team_batting_stats.ops_season (30/30 teams covered as of
  // 2026-06-21 audit) and .k_rate (30/30). null on cache miss → v2 path
  // degrades to v1 (rpg-only) for that team.
  opsSeason: number | null;
  kRate: number | null;
  // D-652 — additional bullpen quality dimensions from cache_mlb_bullpen_stats.
  // bullpen_k_per_9 + bullpen_baa typical: ~8.5 K/9 ~0.245 BAA. null on cache miss.
  bullpenKPer9: number | null;
  bullpenBaa: number | null;
  // D-653 — REAL DEFENSE via Baseball Savant team-level Outs Above Average.
  // Populated daily by fetch-mlb-team-oaa cron from cache_mlb_team_oaa.
  // Typical range -25..+35 for season totals; +30 ≈ elite, 0 ≈ avg, -25 ≈ bottom.
  // Replaces the RAPG-derived combined-pitching+defense proxy used in D-652.
  // null on cache miss → defAdj falls back to D-652 RAPG proxy.
  teamOAA: number | null;
  // D-663 — L10 run-margin distribution. Computed in-place from the SAME
  // L10 query readTeamSeasonContext already runs (cache_mlb_historical_outcomes
  // home_score/away_score). Zero new HTTP, zero new memory beyond two floats
  // per team per scoring tick. Drives score_blowout_tendency_v3 on spreads.
  // l10AvgWinMargin: avg (myRuns − oppRuns) across L10 (signed). Positive = blowout team,
  //                  negative = grind team / current cold streak.
  // l10BlowoutPct: fraction of L10 games won by 3+ runs. null on cache miss.
  l10AvgWinMargin: number | null;
  l10BlowoutPct: number | null;
  // D-664 — team ISO/SLG (homer-teams cover -1.5 differently than singles-teams).
  // Populated by extended fetch-mlb-team-stats from cache_team_batting_stats.iso_season.
  // null on cache miss → score_team_iso_v3 falls back to 0.
  isoSeason: number | null;
  slgSeason: number | null;
  // D-664 — back-of-bullpen quality + pen-rest signals (from new daily caches).
  // bobAvgEra: avg ERA across "high-leverage" relievers (saveOpps >= 5 OR holds >= 10).
  // penIp48h: total relief innings the team logged in the last 48 hours (proxy for rest).
  bobAvgEra: number | null;
  penIp48h: number | null;
}

export interface H2HRecent {
  l10Games: number;
  runsPerGame: number;       // combined runs/game
  homeTeamWinPct: number;    // win pct of designated home team
}

export interface GameScoringContext {
  game: {
    homeTeam: string;
    awayTeam: string;
    gameTime: string;
    venue: string | null;
  };
  homeTeam: TeamSeasonContext;
  awayTeam: TeamSeasonContext;
  homePitcher: OpposingPitcherContext | null;   // home SP
  awayPitcher: OpposingPitcherContext | null;   // away SP
  ballpark: BallparkFactor | null;
  weather: GameWeather | null;
  umpire: UmpireStats | null;
  h2h: H2HRecent | null;
  prop: {
    propType: string;       // "h2h" / "spreads" / "totals"
    line: number;           // run line value or total
    odds: number;
    pickSide: "over" | "under" | "home" | "away";
    bookmaker: string;
  };
  // D-285 SHIP 1 — team-aggregated lineup OPS vs starter hand. Pre-computed
  // at run start via PA-weighted average over lineup batters' splits from
  // cache_mlb_batter_splits. Null when lineup unknown or all batters
  // missing splits — scoring fn gracefully degrades to 0 factor.
  // D-286 SHIP 1 — added home_source/away_source for breakdown transparency.
  lineupVsHand?: {
    home_vs_lhp_ops: number | null;
    home_vs_rhp_ops: number | null;
    away_vs_lhp_ops: number | null;
    away_vs_rhp_ops: number | null;
    home_lineup_pa: number;
    away_lineup_pa: number;
    home_source?: "confirmed" | "projected" | "unavailable";
    away_source?: "confirmed" | "projected" | "unavailable";
    // D-664 — lineup depth (top-3 vs bottom-3 slot OPS PA-weighted).
    home_top3_ops?: number | null;
    home_bottom3_ops?: number | null;
    away_top3_ops?: number | null;
    away_bottom3_ops?: number | null;
  } | null;
  // D-652 — pre-computed market signals (line movement + sharp money + RLM + steam)
  // populated by process-games-mlb game_side branch from _shared/{line_movement,sharp_money}.ts.
  // Weight LITERAL 0 in v3 (computed + stored, not scored) until D-549 r_residual
  // measures on 30+ days of post-D-652 game_side picks. Same discipline as batters
  // per D-636-UNVALIDATED-PENDING.
  marketSignals?: {
    lm_raw_score: number | null;
    rlm_raw_score: number | null;
    sharp_money_raw: number | null;
    steam_signal: number | null;
  } | null;
  // D-663 — per-team travel context. Reuses the existing caches.travelContext
  // accessor (D-347 batter path; team-keyed, cached per team+date). Cheap:
  // single PostgREST call per team-date, memoized for the slate.
  // miles = haversine(yesterday's host venue → today's venue).
  // direction = "EW" (east→west) / "WE" (west→east) / null (same TZ band).
  // null when no prior-day game OR gap > 36h (off-day).
  gameTravel?: {
    home: { miles: number; direction: "EW" | "WE" | null } | null;
    away: { miles: number; direction: "EW" | "WE" | null } | null;
  } | null;
}

export interface GameMarketResult {
  confidence: number;
  confidence_pre_cap: number;          // D-406: == confidence (no D-140 cap fires on game markets)
  confidence_pre_tier_aware: number;
  verdict: string;
  projectedHomeRuns: number;
  projectedAwayRuns: number;
  projectedTotal: number;
  edge: number;
  score_offense_differential: number;
  score_pitching_matchup: number;
  score_bullpen_strength: number;
  score_recent_run_diff: number;
  score_h2h_recent: number;
  score_team_form: number;
  score_ballpark_factor: number;
  score_weather_wind: number;
  score_weather_temp: number;
  score_umpire_k_zone: number;
  score_lineup_vs_hand_split: number;  // D-285 SHIP 1
  unbettableJuiceFlag: boolean;
  coinFlipFlag: boolean;
  negativeStackingFlag: boolean;
  negativeFactorCount: number;
  breakdown: Record<string, number | string | null | boolean>;
}

// D-340 / T6 — see W comment above.
const DEFAULT_W_GAME = {
  offenseDiff: 1.5,
  pitchingMatchup: 1.5,
  bullpenStrength: 1.0,
  recentRunDiff: 1.0,
  h2hRecent: 0.5,
  teamForm: 1.0,
  ballpark: 1.0,
  weatherWind: 0.5,
  weatherTemp: 0.5,
  umpireKZone: 0.75,
  lineupVsHand: 1.0,  // D-285 SHIP 1 — w_mlb_lineup_vs_hand_split
} as const;
let W_GAME: { -readonly [K in keyof typeof DEFAULT_W_GAME]: number } = { ...DEFAULT_W_GAME };

// ============================================================
// D-340 / T6 — MLB DB-tunable weights interface + setters.
// process-games-mlb's loadMlbWeightsFromDB() reads algorithm_weights row 1
// and calls setMlbWeights(loaded) once per cron tick before scoring fires.
// ============================================================
export interface MlbScoringWeights {
  W: typeof DEFAULT_W;
  W_BATTER: typeof DEFAULT_W_BATTER;
  W_GAME: typeof DEFAULT_W_GAME;
}

export function getMlbDefaultWeights(): MlbScoringWeights {
  return {
    W: { ...DEFAULT_W },
    W_BATTER: { ...DEFAULT_W_BATTER },
    W_GAME: { ...DEFAULT_W_GAME },
  };
}

// D-755 — load-time guard. Asserts every key in DEFAULT_W{,_BATTER,_GAME} has
// a matching entry in the loader output. Throws with the missing key names so
// the cron tick fails LOUDLY on the very first invocation post-deploy — the
// next */5 process-games-mlb tick logs the error to error_log and writes 0
// picks for ALL markets (not just the one with the unwired factor), making
// the failure unmissable instead of the silent NaN cascade that D-749 + D-753
// hid for ~12+ hours.
//
// Catches the bug class: a factor weight is added to DEFAULT_W{,_BATTER,_GAME}
// but the corresponding `keyName: num(w.w_mlb_..., fallback.W.keyName)` line
// is never added to mlb_weights.ts loadMlbWeightsFromDB(). setMlbWeights does
// `W = { ...weights.W }` which silently drops missing keys → W.keyName is
// undefined at runtime → `f * undefined = NaN` cascade → calibration silently
// falls through to its default → every pick masquerades as the same value.
//
// Verified caught D-749 in D-755 STEP 2 (deliberate-break test) → message:
//   "[D-755] W is missing loader-wired keys: pitcherCsw. Add the line to ..."
function assertWeightsWired<T extends Record<string, number>>(
  blockName: string,
  defaults: T,
  actual: Record<string, unknown>,
): void {
  const defaultKeys = Object.keys(defaults);
  const actualKeys = new Set(Object.keys(actual));
  const missing = defaultKeys.filter((k) => !actualKeys.has(k));
  if (missing.length > 0) {
    throw new Error(
      `[D-755] ${blockName} is missing loader-wired keys: ${missing.join(", ")}. ` +
      `Add the line(s) to mlb_weights.ts loadMlbWeightsFromDB() — see D-749 / D-753 ` +
      `for the bug class (loader-missing key → undefined → NaN cascade → silent default).`,
    );
  }
}

export function setMlbWeights(weights: MlbScoringWeights): void {
  // D-755 — fail-fast wiring guard. Runs on every cron tick BEFORE scoring.
  assertWeightsWired("W (pitcher)", DEFAULT_W, weights.W as Record<string, unknown>);
  assertWeightsWired("W_BATTER", DEFAULT_W_BATTER, weights.W_BATTER as Record<string, unknown>);
  assertWeightsWired("W_GAME", DEFAULT_W_GAME, weights.W_GAME as Record<string, unknown>);
  W = { ...weights.W };
  W_BATTER = { ...weights.W_BATTER };
  W_GAME = { ...weights.W_GAME };
  // D-534 — also store as the "global" baseline so setActiveMarket can
  // fall back to it when a market has no override. Backward-compat:
  // existing callers that only call setMlbWeights() still work; the
  // perMarket map stays empty so every setActiveMarket(...) returns
  // the global → byte-identical to pre-D-534 behavior.
  _global_for_per_market = { W: { ...weights.W }, W_BATTER: { ...weights.W_BATTER }, W_GAME: { ...weights.W_GAME } };
  _per_market_weights = {};
}

export function resetMlbWeights(): void {
  W = { ...DEFAULT_W };
  W_BATTER = { ...DEFAULT_W_BATTER };
  W_GAME = { ...DEFAULT_W_GAME };
  _global_for_per_market = null;
  _per_market_weights = {};
}

// D-534 — per-market weights support.
//
// Pre-D-534: weights are GLOBAL — one W_BATTER set applies to every
// batter market. D-533 proved this is the wrong shape (R4 doubled helps
// batter_hits but hurts batter_total_bases). D-534 adds the plumbing so
// each market can have its OWN weights without disturbing others.
//
// Phase A (this batch): plumbing only. Default state = no overrides,
// every market resolves to the global weights → BYTE-IDENTICAL scoring.
//
// Phase B (D-535+): CEO populates overrides per market; the optimizer
// can target one market at a time.
let _global_for_per_market: MlbScoringWeights | null = null;
let _per_market_weights: Record<string, MlbScoringWeights> = {};

/** Initialize the module with global weights + a per-market override map.
 *  Mirrors setMlbWeights(global) for the initial swap, then stores the
 *  perMarket map so setActiveMarket(market) can swap in O(1).
 *
 *  When the perMarket map is empty (the default), setActiveMarket(any)
 *  resolves to the global weights → behavior identical to pre-D-534. */
export function setMlbWeightsWithPerMarket(
  global: MlbScoringWeights,
  perMarket: Record<string, MlbScoringWeights>,
): void {
  // D-755 — same fail-fast wiring guard at the per-market entry point (the
  // path process-games-mlb actually uses post-D-534). Validates BOTH the
  // global block AND every per-market override.
  assertWeightsWired("W (pitcher / global)", DEFAULT_W, global.W as Record<string, unknown>);
  assertWeightsWired("W_BATTER (global)", DEFAULT_W_BATTER, global.W_BATTER as Record<string, unknown>);
  assertWeightsWired("W_GAME (global)", DEFAULT_W_GAME, global.W_GAME as Record<string, unknown>);
  for (const [marketName, marketW] of Object.entries(perMarket)) {
    assertWeightsWired(`W (per-market ${marketName})`, DEFAULT_W, marketW.W as Record<string, unknown>);
    assertWeightsWired(`W_BATTER (per-market ${marketName})`, DEFAULT_W_BATTER, marketW.W_BATTER as Record<string, unknown>);
    assertWeightsWired(`W_GAME (per-market ${marketName})`, DEFAULT_W_GAME, marketW.W_GAME as Record<string, unknown>);
  }
  W = { ...global.W };
  W_BATTER = { ...global.W_BATTER };
  W_GAME = { ...global.W_GAME };
  _global_for_per_market = { W: { ...global.W }, W_BATTER: { ...global.W_BATTER }, W_GAME: { ...global.W_GAME } };
  _per_market_weights = {};
  for (const [market, w] of Object.entries(perMarket)) {
    _per_market_weights[market] = {
      W: { ...w.W },
      W_BATTER: { ...w.W_BATTER },
      W_GAME: { ...w.W_GAME },
    };
  }
}

/** Swap module-scope W / W_BATTER / W_GAME to the given market's set.
 *  Falls back to the global weights when the market has no entry in
 *  the per-market map. Idempotent — calling with the same market twice
 *  yields the same module state.
 *
 *  Callers: the process-games-mlb dispatcher invokes this immediately
 *  BEFORE each scoreBatter* / scorePitcher* / scoreGame* so the scorer
 *  reads the correct market's weights from W / W_BATTER / W_GAME. */
export function setActiveMarket(market: string): void {
  const baseline = _global_for_per_market;
  if (!baseline) return;
  const weights = _per_market_weights[market] ?? baseline;
  W = { ...weights.W };
  W_BATTER = { ...weights.W_BATTER };
  W_GAME = { ...weights.W_GAME };
}

/** Test helper: read the currently-active module-scope weights so
 *  tests can assert exact equality after a setActiveMarket(...) swap. */
export function _getActiveWeightsForTest(): MlbScoringWeights {
  return {
    W: { ...W },
    W_BATTER: { ...W_BATTER },
    W_GAME: { ...W_GAME },
  };
}

export function scoreGameSide(ctx: GameScoringContext): GameMarketResult {
  return scoreGameMarket(ctx, "side");
}
export function scoreGameTotal(ctx: GameScoringContext): GameMarketResult {
  return scoreGameMarket(ctx, "total");
}

function scoreGameMarket(ctx: GameScoringContext, market: "side" | "total"): GameMarketResult {
  const { homeTeam, awayTeam, homePitcher, awayPitcher, ballpark, weather, umpire, h2h, prop } = ctx;

  // Projected runs for both sides via blend of offense × opp pitching.
  // Adjust by park, weather, and league avg drift.
  const leagueAvgRPG = 4.5;
  const parkAdj = ballpark ? clamp(ballpark.runsFactor, 0.85, 1.20) : 1.0;

  function projTeamRuns(off: TeamSeasonContext, opp: OpposingPitcherContext | null, oppTeam: TeamSeasonContext): number {
    const offRate = off.runsPerGame > 0 ? off.runsPerGame : leagueAvgRPG;
    // Pitching adjustment: blend opposing SP ERA contribution (~5IP) + opp team RA/G contribution (~4IP for bullpen)
    let pitchAdj = 1.0;
    if (opp && opp.inningsPitched > 0) {
      pitchAdj = clamp(opp.era / LEAGUE_AVG_ERA, 0.70, 1.40);
    }
    const oppBullpenEra = oppTeam.bullpenEra ?? LEAGUE_AVG_ERA;
    const bpAdj = clamp(oppBullpenEra / LEAGUE_AVG_ERA, 0.80, 1.25);
    // 60% SP weight + 40% bullpen weight
    const combinedPitchAdj = 0.6 * pitchAdj + 0.4 * bpAdj;
    return offRate * combinedPitchAdj * parkAdj;
  }

  const projHomeRuns = projTeamRuns(homeTeam, awayPitcher, awayTeam);
  const projAwayRuns = projTeamRuns(awayTeam, homePitcher, homeTeam);
  const projTotal = projHomeRuns + projAwayRuns;
  const projDiff = projHomeRuns - projAwayRuns;

  // Edge depends on market
  let edge = 0;
  if (market === "total") {
    edge = prop.pickSide === "over" ? projTotal - prop.line : prop.line - projTotal;
  } else {
    // side market — line is spread (positive = home favored by abs(line) when negative)
    // Convention: prop.line is the spread for pick_side="home" — home is favored if line<0.
    // For h2h-style: pickSide "home"/"away" with line 0.
    const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
    edge = pickHome ? projDiff - prop.line : -projDiff - prop.line;
  }

  let confidence = 50 + edge * (market === "total" ? 6 : 8);

  // ============================================================
  // FACTOR — score_offense_differential
  // For side market: home RPG - away RPG. For total: home RPG + away RPG vs league.
  //
  // D-339 (2026-05-27): zero on home-side picks on "side" market (spreads + h2h)
  // per CEO §19.3. D-296 deep dive established this factor is ANTI-PREDICTIVE
  // on home-side (covers 17.6% on n=17 home-side >= +6 cell) but CORRECTLY
  // DIRECTIONAL on away-side (100% on n=6 away-side mirror cell). Root cause:
  // spreads/h2h markets already price in offense differential, so betting
  // home-favorite-with-better-offense is betting against the already-priced
  // edge. D-297 surgically suppressed Elite home-side only at conf=90+; D-339
  // extends that suppression to ALL TIERS on home-side. Away-side and totals
  // unchanged per D-305 evidence (delta -0.89 measured on spreads only).
  // ============================================================
  let f_offDiff = 0;
  if (market === "side") {
    const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
    if (!pickHome) {
      // Away-side: D-296 confirmed factor is correctly directional. Keep computing.
      const diff = homeTeam.runsPerGame - awayTeam.runsPerGame;
      const d = -diff;  // flip for away
      if (d >= 1.0)      f_offDiff = 8;
      else if (d >= 0.5) f_offDiff = 4;
      else if (d >= 0.25) f_offDiff = 2;
      else if (d <= -1.0) f_offDiff = -8;
      else if (d <= -0.5) f_offDiff = -4;
      else if (d <= -0.25) f_offDiff = -2;
    }
    // D-339 — pickHome path intentionally falls through with f_offDiff=0.
  } else {
    const totalOff = homeTeam.runsPerGame + awayTeam.runsPerGame;
    const flip = prop.pickSide === "over" ? 1 : -1;
    const d = (totalOff - 2 * leagueAvgRPG) * flip;
    if (d >= 1.5)      f_offDiff = 8;
    else if (d >= 0.75) f_offDiff = 4;
    else if (d >= 0.3) f_offDiff = 2;
    else if (d <= -1.5) f_offDiff = -8;
    else if (d <= -0.75) f_offDiff = -4;
    else if (d <= -0.3) f_offDiff = -2;
  }
  const score_offense_differential = roundHalfAwayFromZero(f_offDiff * W_GAME.offenseDiff);

  // ============================================================
  // FACTOR — score_pitching_matchup (SP head-to-head)
  // ============================================================
  let f_pmatchup = 0;
  if (homePitcher && awayPitcher && homePitcher.inningsPitched > 0 && awayPitcher.inningsPitched > 0) {
    const eraDiff = awayPitcher.era - homePitcher.era;  // positive = home pitcher better
    if (market === "side") {
      const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHome ? 1 : -1;
      const d = eraDiff * flip;
      if (d >= 1.5)       f_pmatchup = 8;
      else if (d >= 0.75) f_pmatchup = 4;
      else if (d >= 0.3)  f_pmatchup = 2;
      else if (d <= -1.5) f_pmatchup = -8;
      else if (d <= -0.75) f_pmatchup = -4;
      else if (d <= -0.3) f_pmatchup = -2;
    } else {
      // For totals: combined ERA better than league → fewer runs → under
      const combined = (homePitcher.era + awayPitcher.era) / 2;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - LEAGUE_AVG_ERA) * flip;
      if (d >= 1.2)      f_pmatchup = 8;
      else if (d >= 0.6) f_pmatchup = 4;
      else if (d <= -1.2) f_pmatchup = -8;
      else if (d <= -0.6) f_pmatchup = -4;
    }
  }
  const score_pitching_matchup = roundHalfAwayFromZero(f_pmatchup * W_GAME.pitchingMatchup);

  // ============================================================
  // FACTOR — score_bullpen_strength
  // ============================================================
  let f_bullpen = 0;
  if (homeTeam.bullpenEra !== null && awayTeam.bullpenEra !== null) {
    if (market === "side") {
      const diff = awayTeam.bullpenEra - homeTeam.bullpenEra;  // positive = home bullpen better
      const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHome ? 1 : -1;
      const d = diff * flip;
      // D-711 BUG FIX (empirical wrong-sign correction): D-709 measured a -34.9pp
      // wrong-sign gap on n=200 game_side picks (>0 WR 32.8% vs <0 WR 67.7%). The
      // factor's INTRINSIC logic (strong bullpen on the pick side → push for that
      // pick) is intuitively correct, but the betting market already prices in
      // bullpen strength — empirically, betting the strong-pen side LOSES money on
      // game_side. Invert the assignments to align with realized WR direction.
      // Same magnitudes (5/2/-5/-2), opposite sign mapping.
      if (d >= 1.0)       f_bullpen = -5;
      else if (d >= 0.5)  f_bullpen = -2;
      else if (d <= -1.0) f_bullpen = 5;
      else if (d <= -0.5) f_bullpen = 2;
    } else {
      const combined = (homeTeam.bullpenEra + awayTeam.bullpenEra) / 2;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - LEAGUE_AVG_ERA) * flip;
      if (d >= 1.0)       f_bullpen = 5;
      else if (d >= 0.5)  f_bullpen = 2;
      else if (d <= -1.0) f_bullpen = -5;
      else if (d <= -0.5) f_bullpen = -2;
    }
  }
  const score_bullpen_strength = roundHalfAwayFromZero(f_bullpen * W_GAME.bullpenStrength);

  // ============================================================
  // D-285 SHIP 1 — score_lineup_vs_hand_split (team-platoon vs SP hand)
  // Each team's lineup OPS vs the OPPOSING starter's hand. PA-weighted
  // average over starting batters' splits (from cache_mlb_batter_splits).
  // League avg OPS ~0.720; combined OPS = sum of two team-matchup OPS.
  // Gated: requires both teams' aggregates AND opposing SP hand known.
  // Total market: combined OPS vs 2×0.720 baseline (1.440).
  // Side market: home_matchup_ops - away_matchup_ops favors home/away.
  // Bucket ±6 with W_GAME.lineupVsHand weight (1.0).
  // ============================================================
  let f_lineupHandSplit = 0;
  const lvh = ctx.lineupVsHand ?? null;
  const homePitcherHand = homePitcher?.throws ?? null;
  const awayPitcherHand = awayPitcher?.throws ?? null;
  if (lvh && homePitcherHand && awayPitcherHand && lvh.home_lineup_pa >= 100 && lvh.away_lineup_pa >= 100) {
    // Home lineup faces away SP; pick the home-vs-(away SP hand) OPS
    const homeMatchupOps = awayPitcherHand === "L" ? lvh.home_vs_lhp_ops : lvh.home_vs_rhp_ops;
    const awayMatchupOps = homePitcherHand === "L" ? lvh.away_vs_lhp_ops : lvh.away_vs_rhp_ops;
    if (homeMatchupOps !== null && awayMatchupOps !== null) {
      const LEAGUE_AVG_OPS = 0.720;
      if (market === "total") {
        const combined = homeMatchupOps + awayMatchupOps;
        const flip = prop.pickSide === "over" ? 1 : -1;
        const d = (combined - 2 * LEAGUE_AVG_OPS) * flip;
        if (d >= 0.160)      f_lineupHandSplit = 6;
        else if (d >= 0.080) f_lineupHandSplit = 3;
        else if (d >= 0.040) f_lineupHandSplit = 1;
        else if (d <= -0.160) f_lineupHandSplit = -6;
        else if (d <= -0.080) f_lineupHandSplit = -3;
        else if (d <= -0.040) f_lineupHandSplit = -1;
      } else {
        // Side market
        const diff = homeMatchupOps - awayMatchupOps;
        const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
        const flip = pickHome ? 1 : -1;
        const d = diff * flip;
        if (d >= 0.100)      f_lineupHandSplit = 6;
        else if (d >= 0.050) f_lineupHandSplit = 3;
        else if (d >= 0.025) f_lineupHandSplit = 1;
        else if (d <= -0.100) f_lineupHandSplit = -6;
        else if (d <= -0.050) f_lineupHandSplit = -3;
        else if (d <= -0.025) f_lineupHandSplit = -1;
      }
    }
  }
  const score_lineup_vs_hand_split = roundHalfAwayFromZero(f_lineupHandSplit * W_GAME.lineupVsHand);

  // ============================================================
  // FACTOR — score_recent_run_diff (last10 run differential trend)
  // ============================================================
  let f_recent = 0;
  if (homeTeam.l10Runs !== null && homeTeam.l10RunsAllowed !== null &&
      awayTeam.l10Runs !== null && awayTeam.l10RunsAllowed !== null) {
    const homeRecent = homeTeam.l10Runs - homeTeam.l10RunsAllowed;
    const awayRecent = awayTeam.l10Runs - awayTeam.l10RunsAllowed;
    if (market === "side") {
      const diff = homeRecent - awayRecent;
      const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHome ? 1 : -1;
      const d = diff * flip;
      if (d >= 2.0)      f_recent = 6;
      else if (d >= 1.0) f_recent = 3;
      else if (d <= -2.0) f_recent = -6;
      else if (d <= -1.0) f_recent = -3;
    } else {
      const totalRecent = homeTeam.l10Runs + homeTeam.l10RunsAllowed + awayTeam.l10Runs + awayTeam.l10RunsAllowed;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (totalRecent / 2 - 2 * leagueAvgRPG) * flip;
      if (d >= 1.5)      f_recent = 6;
      else if (d >= 0.75) f_recent = 3;
      else if (d <= -1.5) f_recent = -6;
      else if (d <= -0.75) f_recent = -3;
    }
  }
  const score_recent_run_diff = roundHalfAwayFromZero(f_recent * W_GAME.recentRunDiff);

  // ============================================================
  // FACTOR — score_h2h_recent
  // ============================================================
  let f_h2h = 0;
  if (h2h && h2h.l10Games >= 3) {
    if (market === "side") {
      const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
      const wp = h2h.homeTeamWinPct;
      const flip = pickHome ? 1 : -1;
      const d = (wp - 0.5) * flip;
      if (d >= 0.30)      f_h2h = 4;
      else if (d >= 0.15) f_h2h = 2;
      else if (d <= -0.30) f_h2h = -4;
      else if (d <= -0.15) f_h2h = -2;
    } else {
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (h2h.runsPerGame - 2 * leagueAvgRPG) * flip;
      if (d >= 1.5)       f_h2h = 4;
      else if (d >= 0.75) f_h2h = 2;
      else if (d <= -1.5) f_h2h = -4;
      else if (d <= -0.75) f_h2h = -2;
    }
  }
  const score_h2h_recent = roundHalfAwayFromZero(f_h2h * W_GAME.h2hRecent);

  // ============================================================
  // FACTOR — score_team_form (general recent trend)
  // ============================================================
  let f_form = 0;
  if (homeTeam.l10Runs !== null && awayTeam.l10Runs !== null) {
    const homeForm = (homeTeam.l10Runs ?? 0) - (homeTeam.l10RunsAllowed ?? 0);
    const awayForm = (awayTeam.l10Runs ?? 0) - (awayTeam.l10RunsAllowed ?? 0);
    if (market === "side") {
      const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
      const target = pickHome ? homeForm : awayForm;
      // D-689 widened (game-side): added ±0.25 mild band.
      if (target >= 1.5)       f_form = 4;
      else if (target >= 0.5)  f_form = 2;
      else if (target >= 0.25) f_form = 1;
      else if (target <= -1.5) f_form = -4;
      else if (target <= -0.5) f_form = -2;
      else if (target <= -0.25) f_form = -1;
    } else {
      // For totals: D-689 widened (was: combined ≥3 only = 5% fire). New: graduated 1.5/3.0.
      const combined = Math.abs(homeForm) + Math.abs(awayForm);
      const flip = prop.pickSide === "over" ? 1 : -1;
      if (combined >= 3)        f_form = 2 * flip;
      else if (combined >= 1.5) f_form = 1 * flip;
    }
  }
  const score_team_form = roundHalfAwayFromZero(f_form * W_GAME.teamForm);

  // ============================================================
  // FACTOR — score_ballpark_factor (runs)
  // ============================================================
  let f_park = 0;
  if (ballpark) {
    const flip = market === "total" ? (prop.pickSide === "over" ? 1 : -1) : 0;
    const r = ballpark.runsFactor;
    if (market === "total") {
      const d = (r - 1.0) * flip;
      if (d >= 0.05)       f_park = 6;
      else if (d >= 0.02)  f_park = 3;
      else if (d <= -0.05) f_park = -6;
      else if (d <= -0.02) f_park = -3;
    }
    // side market: park effect is symmetric for both teams — skip
  }
  const score_ballpark_factor = roundHalfAwayFromZero(f_park * W_GAME.ballpark);

  // ============================================================
  // FACTOR — score_weather_wind (totals only; matters for HR)
  // ============================================================
  let f_wind = 0;
  if (market === "total" && weather && weather.condition !== "indoor" && typeof weather.windSpeed === "number") {
    const ws = weather.windSpeed;
    const flip = prop.pickSide === "over" ? 1 : -1;
    // D-689 widened. Pre-D-689 game_total wind = 20% fire. Added ws≥5 / ≤4 mild bands.
    if (ws >= 14)      f_wind = 3 * flip;
    else if (ws >= 8)  f_wind = 2 * flip;
    else if (ws >= 5)  f_wind = 1 * flip;
    else if (ws <= 2)  f_wind = -2 * flip;
    else if (ws <= 4)  f_wind = -1 * flip;
  }
  const score_weather_wind = roundHalfAwayFromZero(f_wind * W_GAME.weatherWind);

  // ============================================================
  // FACTOR — score_weather_temp (totals only)
  // ============================================================
  let f_temp = 0;
  if (market === "total" && weather && weather.condition !== "indoor" && typeof weather.tempF === "number") {
    const d = weather.tempF - LEAGUE_AVG_TEMP_F;
    const flip = prop.pickSide === "over" ? 1 : -1;
    // D-689 widened. Pre-D-689 game_total temp = 15% fire (≥8°F delta). Added ±4°F mild bands.
    if (d >= 15)       f_temp = 3 * flip;
    else if (d >= 8)   f_temp = 2 * flip;
    else if (d >= 4)   f_temp = 1 * flip;
    else if (d <= -15) f_temp = -3 * flip;
    else if (d <= -8)  f_temp = -2 * flip;
    else if (d <= -4)  f_temp = -1 * flip;
  }
  const score_weather_temp = roundHalfAwayFromZero(f_temp * W_GAME.weatherTemp);

  // ============================================================
  // FACTOR — score_umpire_k_zone (bigger zone = lower total)
  // ============================================================
  let f_umpire = 0;
  if (market === "total" && umpire && typeof umpire.kZoneSizeIndex === "number") {
    const kz = umpire.kZoneSizeIndex;
    const flip = prop.pickSide === "over" ? 1 : -1;
    if (kz >= 1.06)      f_umpire = -4 * flip;  // pitcher-friendly = more K = fewer runs
    else if (kz >= 1.03) f_umpire = -2 * flip;
    else if (kz <= 0.94) f_umpire = 4 * flip;
    else if (kz <= 0.97) f_umpire = 2 * flip;
  }
  const score_umpire_k_zone = roundHalfAwayFromZero(f_umpire * W_GAME.umpireKZone);

  // ============================================================
  // D-649 — V2 REBUILD (shadow by default; promoted via env var).
  // ────────────────────────────────────────────────────────────
  // D-648 found game-side was ~11% offense weight share with NO
  // opposing-offense quality term in the projection. v2 rebuilds the
  // projection symmetrically (BOTH offenses vs BOTH pitching staffs)
  // and adds offense-pure factors. SHADOW MODE writes all v2 fields
  // to breakdown so D-549 + OOS can measure; confidence is NOT mutated
  // unless `D649_GAME_SIDE_V2_PROMOTE=true` env secret is set.
  //
  // Data inputs available per 2026-06-21 audit:
  //   - team OPS_season (cache_team_batting_stats, 30/30 teams)
  //   - team k_rate (30/30 teams)
  //   - lineup OPS vs opp SP hand (D-285 lineupVsHand; ~66% gated)
  //   - opposing SP era + kPerNine (existing)
  //   - opposing bullpen ERA (existing)
  //   - park × weather (existing)
  //
  // NOT available (ops_l10, vs_lhp_k_rate, vs_rhp_k_rate — all 0/30).
  // ============================================================
  const LEAGUE_OPS = 0.720;
  const LEAGUE_TEAM_K_RATE = 0.230;
  const LEAGUE_SP_K_PER_9 = 8.5;

  function d649_projRunsV2(
    team: TeamSeasonContext,
    oppPitcher: OpposingPitcherContext | null,
    oppTeam: TeamSeasonContext,
    lineupOPSvsOppHand: number | null,
  ): number {
    const rpgBase = team.runsPerGame > 0 ? team.runsPerGame : leagueAvgRPG;
    const opsAdj = team.opsSeason ? clamp(team.opsSeason / LEAGUE_OPS, 0.80, 1.20) : 1.0;
    let platoonAdj = 1.0;
    if (lineupOPSvsOppHand !== null && team.opsSeason && team.opsSeason > 0) {
      platoonAdj = clamp(lineupOPSvsOppHand / team.opsSeason, 0.85, 1.18);
    }
    let kAdj = 1.0;
    if (team.kRate !== null && oppPitcher && oppPitcher.kPerNine > 0) {
      const oppK9_norm = oppPitcher.kPerNine / 9.0;
      const matchupK = (team.kRate + oppK9_norm) / 2;
      kAdj = clamp(LEAGUE_TEAM_K_RATE / Math.max(matchupK, 0.10), 0.85, 1.10);
    }
    let spRate = 1.0;
    if (oppPitcher && oppPitcher.inningsPitched > 0 && oppPitcher.era > 0) {
      spRate = clamp(oppPitcher.era / LEAGUE_AVG_ERA, 0.70, 1.40);
    }
    let bpRate = 1.0;
    if (oppTeam.bullpenEra && oppTeam.bullpenEra > 0) {
      bpRate = clamp(oppTeam.bullpenEra / LEAGUE_AVG_ERA, 0.80, 1.25);
    }
    const pitchRate = 0.6 * spRate + 0.4 * bpRate;
    return rpgBase * opsAdj * platoonAdj * kAdj * pitchRate * parkAdj;
  }

  // Map lineup OPS to the OPPOSING starter's hand for each team.
  const homeLineupOPSvsAwayHand = (lvh && awayPitcherHand)
    ? (awayPitcherHand === "L" ? lvh.home_vs_lhp_ops : lvh.home_vs_rhp_ops)
    : null;
  const awayLineupOPSvsHomeHand = (lvh && homePitcherHand)
    ? (homePitcherHand === "L" ? lvh.away_vs_lhp_ops : lvh.away_vs_rhp_ops)
    : null;

  const projHomeRunsV2 = d649_projRunsV2(homeTeam, awayPitcher, awayTeam, homeLineupOPSvsAwayHand);
  const projAwayRunsV2 = d649_projRunsV2(awayTeam, homePitcher, homeTeam, awayLineupOPSvsHomeHand);
  const projTotalV2 = projHomeRunsV2 + projAwayRunsV2;
  const projDiffV2 = projHomeRunsV2 - projAwayRunsV2;

  let edgeV2 = 0;
  if (market === "total") {
    edgeV2 = prop.pickSide === "over" ? projTotalV2 - prop.line : prop.line - projTotalV2;
  } else {
    const pickHomeV2 = prop.pickSide === "home" || prop.pickSide === "over";
    edgeV2 = pickHomeV2 ? projDiffV2 - prop.line : -projDiffV2 - prop.line;
  }

  // New offense-pure factor — team OPS season vs league. Seed weight
  // 1.5 LITERAL (NOT in algorithm_weights yet — promote post-D-549).
  let f_offStrengthV2 = 0;
  const homeOps = homeTeam.opsSeason;
  const awayOps = awayTeam.opsSeason;
  if (homeOps !== null && awayOps !== null) {
    if (market === "side") {
      const diff = homeOps - awayOps;
      const pickHomeS = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeS ? 1 : -1;
      const d = diff * flip;
      if (d >= 0.060)       f_offStrengthV2 = 6;
      else if (d >= 0.030)  f_offStrengthV2 = 3;
      else if (d >= 0.015)  f_offStrengthV2 = 1;
      else if (d <= -0.060) f_offStrengthV2 = -6;
      else if (d <= -0.030) f_offStrengthV2 = -3;
      else if (d <= -0.015) f_offStrengthV2 = -1;
    } else {
      const combined = homeOps + awayOps;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - 2 * LEAGUE_OPS) * flip;
      if (d >= 0.100)       f_offStrengthV2 = 6;
      else if (d >= 0.050)  f_offStrengthV2 = 3;
      else if (d >= 0.025)  f_offStrengthV2 = 1;
      else if (d <= -0.100) f_offStrengthV2 = -6;
      else if (d <= -0.050) f_offStrengthV2 = -3;
      else if (d <= -0.025) f_offStrengthV2 = -1;
    }
  }
  const score_team_offense_strength_v2 = roundHalfAwayFromZero(f_offStrengthV2 * 1.5);

  // K-matchup factor (totals only). High combined K → fewer runs → UNDER signal.
  let f_kMatchupV2 = 0;
  if (market === "total" && homeTeam.kRate !== null && awayTeam.kRate !== null
      && homePitcher && awayPitcher
      && homePitcher.kPerNine > 0 && awayPitcher.kPerNine > 0) {
    const combinedTeamK = homeTeam.kRate + awayTeam.kRate;
    const combinedSpK = (homePitcher.kPerNine + awayPitcher.kPerNine) / 9.0;
    const composite = combinedTeamK + combinedSpK;
    const baseline = 2 * LEAGUE_TEAM_K_RATE + 2 * (LEAGUE_SP_K_PER_9 / 9.0);
    const flip = prop.pickSide === "over" ? 1 : -1;
    const d = (composite - baseline) * -flip;
    if (d >= 0.30)       f_kMatchupV2 = 4;
    else if (d >= 0.15)  f_kMatchupV2 = 2;
    else if (d <= -0.30) f_kMatchupV2 = -4;
    else if (d <= -0.15) f_kMatchupV2 = -2;
  }
  const score_k_matchup_v2 = roundHalfAwayFromZero(f_kMatchupV2 * 1.0);

  const D649_PROMOTE = (Deno.env.get("D649_GAME_SIDE_V2_PROMOTE") || "").toLowerCase() === "true";
  if (D649_PROMOTE) {
    // V2 path: v2 edge replaces v1 edge, v2 offense factors added,
    // legacy score_offense_differential dropped (it's 0 anyway).
    confidence = 50 + edgeV2 * (market === "total" ? 6 : 8);
    confidence +=
      score_team_offense_strength_v2 + score_k_matchup_v2 +
      score_pitching_matchup + score_bullpen_strength +
      score_recent_run_diff + score_h2h_recent + score_team_form +
      score_ballpark_factor + score_weather_wind + score_weather_temp +
      score_umpire_k_zone + score_lineup_vs_hand_split;
  } else {
    // V1 path (unchanged from D-285 era).
    confidence +=
      score_offense_differential + score_pitching_matchup + score_bullpen_strength +
      score_recent_run_diff + score_h2h_recent + score_team_form +
      score_ballpark_factor + score_weather_wind + score_weather_temp +
      score_umpire_k_zone + score_lineup_vs_hand_split;
  }
  confidence = clamp(Math.round(confidence), 0, 100);

  // ════════════════════════════════════════════════════════════════
  // D-652 — V3 FULL REBUILD (shadow by default; promoted via env var).
  // CEO §19.3 approved 2026-06-21. Per D-650 audit: v1 game_side is
  // home -9.86% ROI at conf>=90 (book double-counts home advantage);
  // 86.3% of ELITE confidence drives off 3 entangled net-form factors
  // (pitching_matchup + team_form + recent_run_diff). D-649 v2 tried
  // an offense rebuild — OOS -10.72% vs v1 -7.63%, held.
  //
  // V3 strategy: rebuild projection symmetrically with offense (OPS,
  // platoon, L10 form) × pitching (Statcast whiff + ERA + K/9 + bullpen
  // composite) × defense (RAPG-derived proxy — see GAP below) × park
  // × weather. Decouple team_form into OFFENSE (l10 runs scored) and
  // RUN_PREVENTION (l10 runs allowed) so we stop double-counting.
  // Un-gate park & weather for side market in v3. Wire market signals
  // (D-635 lm, D-636 sharp/rlm/steam) into game_side breakdown at
  // weight LITERAL 0 — same discipline as batter markets, awaits
  // D-549 r_residual measurement on 30+ days of post-D-652 data.
  //
  // DATA COVERAGE PER 2026-06-21 PROBE:
  //   AVAILABLE 30/30: ops_season, k_rate, runs_per_game, runs_allowed_per_game,
  //     bullpen_era, bullpen_k_per_9, bullpen_baa (cache_mlb_bullpen_stats)
  //   AVAILABLE 24.6%: expected_whiff_pct, expected_k_pct, expected_put_away
  //     per pitcher (cache_statcast_pitcher_arsenal, post D-646 fix)
  //   AVAILABLE 66%: lineup OPS vs SP hand (D-285 lvh)
  //   AVAILABLE: park.runsFactor, weather.tempF/windSpeed, lineup confirmed-flag
  //
  // NAMED GAPS — used best proxy, did NOT silently skip:
  //   - team wOBA / ISO / HR rate: no cache column → OPS used as power proxy.
  //   - team L10 OPS: cache col exists but populated 0/30 → L10 runs differential used.
  //   - team vs_lhp/rhp_k_rate: cache col exists but populated 0/30 → season k_rate used.
  //   - team DRS/OAA: NO FREE SOURCE without Savant scrape → runs_allowed_per_game
  //     used as COMBINED pitching+defense proxy. Defense is NOT isolated — flagged
  //     in d652 doc, filed as D-652-DEFENSE-FOLLOWUP for future Savant integration.
  //   - bullpen rest / B2B / real-time injury: deferred — flagged in d652 doc.
  // ════════════════════════════════════════════════════════════════
  const D652_PROMOTE = (Deno.env.get("D652_GAME_SIDE_V3_PROMOTE") || "").toLowerCase() === "true";
  const LEAGUE_OPS_V3 = 0.720;
  const LEAGUE_TEAM_K_V3 = 0.230;
  // D-710 BUG 1 FIX: was 0.26 (fraction). cache_statcast_pitcher_arsenal.expected_whiff_pct
  // is stored in percentage-points (e.g. 22.39 not 0.2239), so the constant must be 26.0 to
  // match cache units. D-709 evaluator measured 48/50 picks saturating at abs(score)==6
  // because (22.39 + 20.71) - 2*0.26 = 42.58 vs threshold 0.06, i.e. ~780x past threshold.
  // Thresholds at lines 4774-4777 + 4783-4786 also scaled fraction→percentage-point (×100).
  const LEAGUE_WHIFF_V3 = 26.0;
  const LEAGUE_PUT_AWAY_V3 = 19.37;
  const LEAGUE_BULLPEN_KP9_V3 = 8.5;
  const LEAGUE_BULLPEN_BAA_V3 = 0.245;

  function d652_pitchQualityV3(p: OpposingPitcherContext | null): number {
    if (!p || p.inningsPitched <= 0 || p.era <= 0) return 1.0;
    const eraComp = clamp(p.era / LEAGUE_AVG_ERA, 0.70, 1.40);
    if (p.expectedWhiffPct === null || p.expectedPutAway === null) return eraComp;
    const whiffComp = clamp(LEAGUE_WHIFF_V3 / Math.max(p.expectedWhiffPct, 0.10), 0.85, 1.15);
    const paComp = clamp(LEAGUE_PUT_AWAY_V3 / Math.max(p.expectedPutAway, 5.0), 0.85, 1.15);
    return 0.60 * eraComp + 0.25 * whiffComp + 0.15 * paComp;
  }
  function d652_bullpenQualityV3(team: TeamSeasonContext): number {
    if (!team.bullpenEra || team.bullpenEra <= 0) return 1.0;
    const eraC = clamp(team.bullpenEra / LEAGUE_AVG_ERA, 0.80, 1.25);
    if (!team.bullpenKPer9 || !team.bullpenBaa) return eraC;
    const kC = clamp(LEAGUE_BULLPEN_KP9_V3 / Math.max(team.bullpenKPer9, 4.0), 0.90, 1.15);
    const baaC = clamp(team.bullpenBaa / LEAGUE_BULLPEN_BAA_V3, 0.85, 1.15);
    return 0.60 * eraC + 0.20 * kC + 0.20 * baaC;
  }
  function d652_defenseProxyV3(team: TeamSeasonContext): number {
    // D-653 SHIP 2 — REAL defense via Baseball Savant team OAA when available.
    // OAA range -25..+35 over a season; mapped to [0.83, 1.15] multiplier where
    // positive OAA = better defense = lower opponent runs = adj < 1.0.
    // Empirical anchor: every +10 OAA ≈ -0.10 runs/game prevented (Savant).
    if (team.teamOAA !== null) {
      return clamp(1.0 - team.teamOAA / 100, 0.83, 1.18);
    }
    // FALLBACK (cache miss): D-652 RAPG combined pitching+defense proxy.
    if (team.runsAllowedPerGame <= 0) return 1.0;
    return clamp(team.runsAllowedPerGame / leagueAvgRPG, 0.80, 1.25);
  }
  function d652_projTeamRunsV3(
    teamX: TeamSeasonContext,
    oppSP: OpposingPitcherContext | null,
    oppTeam: TeamSeasonContext,
    lineupOpsVsOppHand: number | null,
  ): number {
    const rpgBase = teamX.runsPerGame > 0 ? teamX.runsPerGame : leagueAvgRPG;
    const opsAdj = teamX.opsSeason ? clamp(teamX.opsSeason / LEAGUE_OPS_V3, 0.80, 1.20) : 1.0;
    let platoonAdj = 1.0;
    if (lineupOpsVsOppHand !== null && teamX.opsSeason && teamX.opsSeason > 0) {
      platoonAdj = clamp(lineupOpsVsOppHand / teamX.opsSeason, 0.85, 1.18);
    }
    let kAdj = 1.0;
    if (teamX.kRate !== null && oppSP && oppSP.kPerNine > 0) {
      const matchupK = (teamX.kRate + oppSP.kPerNine / 9.0) / 2;
      kAdj = clamp(LEAGUE_TEAM_K_V3 / Math.max(matchupK, 0.10), 0.85, 1.10);
    }
    const spQ = d652_pitchQualityV3(oppSP);
    const bpQ = d652_bullpenQualityV3(oppTeam);
    const pitchRate = 0.60 * spQ + 0.40 * bpQ;
    const defAdj = d652_defenseProxyV3(oppTeam);
    const combinedRunPrevention = pitchRate * Math.pow(defAdj, 0.5);
    let weatherAdj = 1.0;
    if (weather && weather.condition !== "indoor") {
      if (typeof weather.tempF === "number") {
        const tDiff = weather.tempF - LEAGUE_AVG_TEMP_F;
        weatherAdj += tDiff > 15 ? 0.04 : tDiff > 8 ? 0.02 : tDiff < -15 ? -0.04 : tDiff < -8 ? -0.02 : 0;
      }
      if (typeof weather.windSpeed === "number") {
        weatherAdj += weather.windSpeed >= 14 ? 0.03 : weather.windSpeed >= 8 ? 0.015 : weather.windSpeed <= 3 ? -0.01 : 0;
      }
    }
    weatherAdj = clamp(weatherAdj, 0.92, 1.08);
    return rpgBase * opsAdj * platoonAdj * kAdj * combinedRunPrevention * parkAdj * weatherAdj;
  }

  // Symmetric v3 projection per team.
  const homeLineupVsAwayHand_v3 = (lvh && awayPitcherHand)
    ? (awayPitcherHand === "L" ? lvh.home_vs_lhp_ops : lvh.home_vs_rhp_ops)
    : null;
  const awayLineupVsHomeHand_v3 = (lvh && homePitcherHand)
    ? (homePitcherHand === "L" ? lvh.away_vs_lhp_ops : lvh.away_vs_rhp_ops)
    : null;
  const projHomeRunsV3 = d652_projTeamRunsV3(homeTeam, awayPitcher, awayTeam, homeLineupVsAwayHand_v3);
  const projAwayRunsV3 = d652_projTeamRunsV3(awayTeam, homePitcher, homeTeam, awayLineupVsHomeHand_v3);
  const projTotalV3 = projHomeRunsV3 + projAwayRunsV3;
  const projDiffV3 = projHomeRunsV3 - projAwayRunsV3;
  let edgeV3 = 0;
  if (market === "total") {
    edgeV3 = prop.pickSide === "over" ? projTotalV3 - prop.line : prop.line - projTotalV3;
  } else {
    const pickHomeV3 = prop.pickSide === "home" || prop.pickSide === "over";
    edgeV3 = pickHomeV3 ? projDiffV3 - prop.line : -projDiffV3 - prop.line;
  }

  // V3 FACTORS — co-equal offense / pitching / defense / context.
  //
  // ⚠️ ALL V3 WEIGHTS BELOW ARE PROVISIONAL — set by Claude D-652/D-653
  // WITHOUT OOS calibration. They are PLACEHOLDERS until the D-682 forward-test
  // window closes (2026-07-21) and the D-372/D-498 optimizer fits them to real
  // hit/miss data.
  //
  // EVIDENCE WEIGHTS NEED DATA-FIT (D-653 SHIP 4 partial-fit on 882 v1 game_side
  // picks since D-379):
  //   - score_team_form     live_w=2.50 → data lift -5.0pp (ANTI-PREDICTIVE)
  //   - score_recent_run_diff live_w=1.75 → data lift -9.2pp (ANTI-PREDICTIVE)
  //   - score_lineup_vs_hand_split live_w=1.00 → data lift -7.0pp (ANTI-PREDICTIVE)
  //   - score_h2h_recent    live_w=0.25 → data lift -5.7pp (ANTI-PREDICTIVE)
  //   - score_pitching_matchup live_w=1.50 → data lift +13.8pp ✓ (correct sign,
  //     under-weighted; data suggests ~1.70)
  //   - score_bullpen_strength live_w=0.50 → data lift +8.7pp ✓ (under-weighted;
  //     data suggests ~0.92)
  //
  // The v1 weights have FOUR positive-weighted factors that are ANTI-PREDICTIVE
  // in the data. v3 inherits the SAME problem until optimized. The factors
  // dropped from v3 confidence math (team_form, recent_run_diff) align with
  // the data direction. score_lineup_vs_hand_split + score_h2h_recent remain in
  // v3 confidence math but ARE flagged as data-anti-predictive — they should be
  // re-weighted by the optimizer (D-682 + D-682-FIT batch).
  //
  // Composite ratios inside d652_projTeamRunsV3 are ALSO provisional:
  //   - SP composite: 60% ERA / 25% whiff / 15% put_away  [Claude-set]
  //   - Bullpen composite: 60% ERA / 20% K/9 / 20% BAA    [Claude-set]
  //   - pitchRate split: 60% SP / 40% bullpen              [from v1 — kept]
  //   - OAA defAdj: clamp(1 - oaa/100, 0.83, 1.18)         [D-653 — Claude-set]
  // These will be tuned per D-682-FIT-COMPOSITES once forward-test data accumulates.
  //
  // See d653_*.md §SHIP 4 for the optimizer procedure + first-run date.

  // (1) Decoupled team OFFENSE form — L10 runs scored only.
  let f_offForm_v3 = 0;
  if (homeTeam.l10Runs !== null && awayTeam.l10Runs !== null) {
    if (market === "side") {
      const diff = homeTeam.l10Runs - awayTeam.l10Runs;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 1.0) f_offForm_v3 = 6;
      else if (d >= 0.5) f_offForm_v3 = 3;
      else if (d <= -1.0) f_offForm_v3 = -6;
      else if (d <= -0.5) f_offForm_v3 = -3;
    } else {
      const combined = homeTeam.l10Runs + awayTeam.l10Runs;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - 2 * leagueAvgRPG) * flip;
      if (d >= 1.5) f_offForm_v3 = 6;
      else if (d >= 0.75) f_offForm_v3 = 3;
      else if (d <= -1.5) f_offForm_v3 = -6;
      else if (d <= -0.75) f_offForm_v3 = -3;
    }
  }
  const score_team_offense_form_v3 = roundHalfAwayFromZero(f_offForm_v3 * 1.5);

  // (2) Decoupled team RUN_PREVENTION form — L10 runs allowed only.
  let f_defForm_v3 = 0;
  if (homeTeam.l10RunsAllowed !== null && awayTeam.l10RunsAllowed !== null) {
    if (market === "side") {
      const diff = awayTeam.l10RunsAllowed - homeTeam.l10RunsAllowed;  // positive = home prevents better
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 1.0) f_defForm_v3 = 6;
      else if (d >= 0.5) f_defForm_v3 = 3;
      else if (d <= -1.0) f_defForm_v3 = -6;
      else if (d <= -0.5) f_defForm_v3 = -3;
    } else {
      // For totals: combined RA higher than league → more runs allowed → OVER
      const combined = homeTeam.l10RunsAllowed + awayTeam.l10RunsAllowed;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - 2 * leagueAvgRPG) * flip;
      if (d >= 1.5) f_defForm_v3 = 6;
      else if (d >= 0.75) f_defForm_v3 = 3;
      else if (d <= -1.5) f_defForm_v3 = -6;
      else if (d <= -0.75) f_defForm_v3 = -3;
    }
  }
  const score_team_run_prevention_form_v3 = roundHalfAwayFromZero(f_defForm_v3 * 1.5);

  // (3) Starter Statcast quality (whiff + put_away vs league).
  let f_spStatcast_v3 = 0;
  if (homePitcher && awayPitcher
      && homePitcher.expectedWhiffPct !== null && awayPitcher.expectedWhiffPct !== null
      && homePitcher.expectedPutAway !== null && awayPitcher.expectedPutAway !== null) {
    const homeQ = (homePitcher.expectedWhiffPct - LEAGUE_WHIFF_V3)
                + 0.5 * (homePitcher.expectedPutAway - LEAGUE_PUT_AWAY_V3) / LEAGUE_PUT_AWAY_V3;
    const awayQ = (awayPitcher.expectedWhiffPct - LEAGUE_WHIFF_V3)
                + 0.5 * (awayPitcher.expectedPutAway - LEAGUE_PUT_AWAY_V3) / LEAGUE_PUT_AWAY_V3;
    if (market === "side") {
      const diff = homeQ - awayQ;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      // D-710 BUG 1 FIX: thresholds scaled fraction→percentage-points (×100).
      if (d >= 6.0) f_spStatcast_v3 = 6;
      else if (d >= 3.0) f_spStatcast_v3 = 3;
      else if (d <= -6.0) f_spStatcast_v3 = -6;
      else if (d <= -3.0) f_spStatcast_v3 = -3;
    } else {
      // High combined whiff → fewer runs → UNDER
      const combined = (homePitcher.expectedWhiffPct + awayPitcher.expectedWhiffPct);
      const flip = prop.pickSide === "over" ? -1 : 1;
      const d = (combined - 2 * LEAGUE_WHIFF_V3) * flip;
      // D-710 BUG 1 FIX: thresholds scaled fraction→percentage-points (×100).
      if (d >= 6.0) f_spStatcast_v3 = 4;
      else if (d >= 3.0) f_spStatcast_v3 = 2;
      else if (d <= -6.0) f_spStatcast_v3 = -4;
      else if (d <= -3.0) f_spStatcast_v3 = -2;
    }
  }
  const score_sp_statcast_quality_v3 = roundHalfAwayFromZero(f_spStatcast_v3 * 1.5);

  // (4) Bullpen full-composite quality (ERA + K/9 + BAA combined).
  let f_bullpenV3 = 0;
  if (homeTeam.bullpenEra !== null && awayTeam.bullpenEra !== null) {
    const homeBP_combined = homeTeam.bullpenEra
      + 0.10 * (LEAGUE_BULLPEN_KP9_V3 - (homeTeam.bullpenKPer9 ?? LEAGUE_BULLPEN_KP9_V3))
      + 4.0  * ((homeTeam.bullpenBaa ?? LEAGUE_BULLPEN_BAA_V3) - LEAGUE_BULLPEN_BAA_V3);
    const awayBP_combined = awayTeam.bullpenEra
      + 0.10 * (LEAGUE_BULLPEN_KP9_V3 - (awayTeam.bullpenKPer9 ?? LEAGUE_BULLPEN_KP9_V3))
      + 4.0  * ((awayTeam.bullpenBaa ?? LEAGUE_BULLPEN_BAA_V3) - LEAGUE_BULLPEN_BAA_V3);
    if (market === "side") {
      const diff = awayBP_combined - homeBP_combined;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 1.0) f_bullpenV3 = 5;
      else if (d >= 0.5) f_bullpenV3 = 2;
      else if (d <= -1.0) f_bullpenV3 = -5;
      else if (d <= -0.5) f_bullpenV3 = -2;
    } else {
      const combined = (homeBP_combined + awayBP_combined) / 2;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - LEAGUE_AVG_ERA) * flip;
      if (d >= 1.0) f_bullpenV3 = 5;
      else if (d >= 0.5) f_bullpenV3 = 2;
      else if (d <= -1.0) f_bullpenV3 = -5;
      else if (d <= -0.5) f_bullpenV3 = -2;
    }
  }
  const score_bullpen_quality_v3 = roundHalfAwayFromZero(f_bullpenV3 * 1.5);

  // (5) Park (un-gated for side; symmetric handling — high-runs park favors OVER, low-runs favors UNDER + dog).
  let f_parkV3 = 0;
  if (ballpark) {
    if (market === "side") {
      // Per D-650: high-run parks weakly favor the dog (more variance covers spreads).
      // Side application: pick_side=home is typically the favorite; high parkRF reduces home cover prob.
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const adj = (ballpark.runsFactor - 1.0) * (pickHomeF ? -1 : 1);
      if (adj >= 0.04) f_parkV3 = 2;
      else if (adj >= 0.02) f_parkV3 = 1;
      else if (adj <= -0.04) f_parkV3 = -2;
      else if (adj <= -0.02) f_parkV3 = -1;
    } else {
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (ballpark.runsFactor - 1.0) * flip;
      if (d >= 0.05) f_parkV3 = 6;
      else if (d >= 0.02) f_parkV3 = 3;
      else if (d <= -0.05) f_parkV3 = -6;
      else if (d <= -0.02) f_parkV3 = -3;
    }
  }
  const score_park_runs_v3 = roundHalfAwayFromZero(f_parkV3 * 0.75);

  // (6a) D-653 SHIP 2 — Team defense OAA (real, from Baseball Savant).
  // ⚠️ PROVISIONAL WEIGHT (literal 1.5). Set by Claude D-653 without
  // OOS calibration — see d653_*.md §SHIP 4 + framework D-652-WEIGHTS-OPTIMIZE.
  let f_oaaV3 = 0;
  if (homeTeam.teamOAA !== null && awayTeam.teamOAA !== null) {
    if (market === "side") {
      const diff = homeTeam.teamOAA - awayTeam.teamOAA;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 20) f_oaaV3 = 6;
      else if (d >= 10) f_oaaV3 = 3;
      else if (d >= 5) f_oaaV3 = 1;
      else if (d <= -20) f_oaaV3 = -6;
      else if (d <= -10) f_oaaV3 = -3;
      else if (d <= -5) f_oaaV3 = -1;
    } else {
      const combined = homeTeam.teamOAA + awayTeam.teamOAA;
      const flip = prop.pickSide === "over" ? -1 : 1;
      if (combined >= 30) f_oaaV3 = 4 * flip;
      else if (combined >= 15) f_oaaV3 = 2 * flip;
      else if (combined <= -30) f_oaaV3 = -4 * flip;
      else if (combined <= -15) f_oaaV3 = -2 * flip;
    }
  }
  const score_team_defense_oaa_v3 = roundHalfAwayFromZero(f_oaaV3 * 1.5);

  // (6) Lineup confirmation strength (D-637 watcher data).
  let f_lineupConfirm_v3 = 0;
  if (lvh) {
    const homeConfirmed = lvh.home_source === "confirmed";
    const awayConfirmed = lvh.away_source === "confirmed";
    if (market === "side") {
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const ourConfirmed = pickHomeF ? homeConfirmed : awayConfirmed;
      if (!ourConfirmed) f_lineupConfirm_v3 = -2;
    } else {
      if (!homeConfirmed && !awayConfirmed) f_lineupConfirm_v3 = prop.pickSide === "over" ? -2 : 2;
    }
  }
  const score_lineup_confirmation_v3 = roundHalfAwayFromZero(f_lineupConfirm_v3 * 0.75);

  // ============================================================
  // D-663 — Five additional handicapper-grade v3 spread factors.
  // ALL provisional weights LITERAL — same caveat as D-652/D-653.
  // Re-tuned by D-682 forward-test + optimizer on 7+ days of resolved
  // post-D-663 picks (cohort flagged via breakdown.d663_wired=true).
  // ============================================================

  // (7) D-663-A — Pitcher GB/FB rate on spreads (D-661 batter signal now wired to spreads).
  // High-GB SP suppresses oppo runs → favors the team facing that SP's opponent.
  // For side: diff between SPs. League avg goToAo ≈ 1.10.
  let f_gbfbV3 = 0;
  if (homePitcher?.groundOutsToAirouts != null && awayPitcher?.groundOutsToAirouts != null) {
    if (market === "side") {
      // Home SP higher goToAo → fewer away runs → home covers more often.
      const diff = homePitcher.groundOutsToAirouts - awayPitcher.groundOutsToAirouts;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 0.40) f_gbfbV3 = 4;
      else if (d >= 0.20) f_gbfbV3 = 2;
      else if (d <= -0.40) f_gbfbV3 = -4;
      else if (d <= -0.20) f_gbfbV3 = -2;
    } else {
      // High combined goToAo → fewer HR → UNDER.
      const combined = (homePitcher.groundOutsToAirouts + awayPitcher.groundOutsToAirouts) / 2;
      const flip = prop.pickSide === "over" ? -1 : 1;
      const d = (combined - 1.10) * flip;
      if (d >= 0.25) f_gbfbV3 = 3;
      else if (d >= 0.12) f_gbfbV3 = 2;
      else if (d <= -0.25) f_gbfbV3 = -3;
      else if (d <= -0.12) f_gbfbV3 = -2;
    }
  }
  const score_pitcher_gb_fb_rate_v3 = roundHalfAwayFromZero(f_gbfbV3 * 1.0);

  // (8) D-663-B — Team OPS season as standalone signal factor on spreads.
  // opsSeason already feeds the projection multiplicatively via opsAdj; this
  // adds it as a co-equal confidence-list factor so handicapper-style OPS
  // diffs carry independent weight (currently OPS only tilts the edge, not
  // the additive factor list).
  let f_teamOpsV3 = 0;
  if (homeTeam.opsSeason != null && awayTeam.opsSeason != null) {
    const opsDiff = homeTeam.opsSeason - awayTeam.opsSeason;
    if (market === "side") {
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = opsDiff * flip;
      if (d >= 0.060) f_teamOpsV3 = 6;
      else if (d >= 0.030) f_teamOpsV3 = 3;
      else if (d <= -0.060) f_teamOpsV3 = -6;
      else if (d <= -0.030) f_teamOpsV3 = -3;
    } else {
      // Combined OPS above league → OVER.
      const combined = (homeTeam.opsSeason + awayTeam.opsSeason);
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - 2 * 0.720) * flip;
      if (d >= 0.060) f_teamOpsV3 = 4;
      else if (d >= 0.030) f_teamOpsV3 = 2;
      else if (d <= -0.060) f_teamOpsV3 = -4;
      else if (d <= -0.030) f_teamOpsV3 = -2;
    }
  }
  const score_team_ops_v3 = roundHalfAwayFromZero(f_teamOpsV3 * 1.5);

  // (9) D-663-C — SP innings depth (IP per start).
  // Deeper SP = less bullpen exposure = better margin = covers -1.5 more often.
  // Threshold ~5.5 IP/start ≈ league avg modern SP usage.
  let f_ipDepthV3 = 0;
  if (homePitcher?.gamesStarted != null && homePitcher.gamesStarted > 0
      && awayPitcher?.gamesStarted != null && awayPitcher.gamesStarted > 0
      && homePitcher.inningsPitched > 0 && awayPitcher.inningsPitched > 0) {
    const homeIPpS = homePitcher.inningsPitched / homePitcher.gamesStarted;
    const awayIPpS = awayPitcher.inningsPitched / awayPitcher.gamesStarted;
    if (market === "side") {
      const diff = homeIPpS - awayIPpS;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 1.0) f_ipDepthV3 = 4;
      else if (d >= 0.5) f_ipDepthV3 = 2;
      else if (d <= -1.0) f_ipDepthV3 = -4;
      else if (d <= -0.5) f_ipDepthV3 = -2;
    } else {
      // High combined IP/start → less pen exposure → typically UNDER.
      const combined = (homeIPpS + awayIPpS) / 2;
      const flip = prop.pickSide === "over" ? -1 : 1;
      const d = (combined - 5.5) * flip;
      if (d >= 0.8) f_ipDepthV3 = 3;
      else if (d >= 0.4) f_ipDepthV3 = 2;
      else if (d <= -0.8) f_ipDepthV3 = -3;
      else if (d <= -0.4) f_ipDepthV3 = -2;
    }
  }
  const score_sp_ip_depth_v3 = roundHalfAwayFromZero(f_ipDepthV3 * 1.0);

  // (10) D-663-D — Team blowout tendency (L10 run-margin distribution).
  // Spread covers = winning by 2+. A team that wins by 5 or loses by 1 covers -1.5
  // more often than a team that wins by 2 or loses by 5 at the same WR.
  let f_blowoutV3 = 0;
  if (homeTeam.l10AvgWinMargin != null && awayTeam.l10AvgWinMargin != null) {
    if (market === "side") {
      const diff = homeTeam.l10AvgWinMargin - awayTeam.l10AvgWinMargin;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 2.0) f_blowoutV3 = 5;
      else if (d >= 1.0) f_blowoutV3 = 3;
      else if (d <= -2.0) f_blowoutV3 = -5;
      else if (d <= -1.0) f_blowoutV3 = -3;
    } else {
      // For totals: extreme margin tendencies in BOTH directions → variance signal.
      // Two grind-teams (low |margin|) → tighter games → UNDER tilt.
      const combinedAbs = Math.abs(homeTeam.l10AvgWinMargin) + Math.abs(awayTeam.l10AvgWinMargin);
      const flip = prop.pickSide === "over" ? -1 : 1;
      const d = (1.5 - combinedAbs) * flip;
      if (d >= 1.0) f_blowoutV3 = 2;
      else if (d >= 0.5) f_blowoutV3 = 1;
      else if (d <= -1.0) f_blowoutV3 = -2;
      else if (d <= -0.5) f_blowoutV3 = -1;
    }
  }
  const score_blowout_tendency_v3 = roundHalfAwayFromZero(f_blowoutV3 * 1.0);

  // (11) D-663-E — Team travel flatness (getaway / day-after-flight).
  // Long travel on short rest → flatter offense + sluggish first-3-innings = bad spread cover.
  // > 800 mi = cross-region; > 1500 mi = cross-country (e.g. LA→NYC).
  let f_travelV3 = 0;
  const gt = ctx.gameTravel ?? null;
  if (gt && market === "side") {
    const homeMi = gt.home?.miles ?? 0;
    const awayMi = gt.away?.miles ?? 0;
    // Net travel disadvantage. Home with 0 mi vs away with 1500 mi = +1500 home edge.
    const netDis = awayMi - homeMi;
    const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
    const flip = pickHomeF ? 1 : -1;
    const d = netDis * flip;
    if (d >= 1500) f_travelV3 = 3;
    else if (d >= 800) f_travelV3 = 2;
    else if (d <= -1500) f_travelV3 = -3;
    else if (d <= -800) f_travelV3 = -2;
  } else if (gt && market === "total") {
    // Both teams traveled long → flatter offense both sides → UNDER tilt.
    const totalMi = (gt.home?.miles ?? 0) + (gt.away?.miles ?? 0);
    const flip = prop.pickSide === "over" ? -1 : 1;
    if (totalMi >= 2000) f_travelV3 = 2 * flip;
    else if (totalMi >= 1200) f_travelV3 = 1 * flip;
  }
  const score_team_travel_flat_v3 = roundHalfAwayFromZero(f_travelV3 * 0.75);

  // ============================================================
  // D-664 — Five additional handicapper factors closing the D-663 deferred set.
  // ALL provisional weights LITERAL — re-tuned by the 2026-06-28 weight-fit run
  // (see d664_weight_fit_plan.md). Cohort flagged via breakdown.d664_extras_wired=true.
  // ============================================================

  // (12) D-664-A — Team ISO (slg - avg). Homer-teams cover -1.5 differently than
  // singles-teams: high-ISO teams are more variance-bound (cover via boom-or-bust)
  // and tend to outperform on +run lines (dog +1.5) where any HR covers.
  let f_teamIsoV3 = 0;
  if (homeTeam.isoSeason != null && awayTeam.isoSeason != null) {
    const isoDiff = homeTeam.isoSeason - awayTeam.isoSeason;
    if (market === "side") {
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = isoDiff * flip;
      if (d >= 0.030) f_teamIsoV3 = 4;
      else if (d >= 0.015) f_teamIsoV3 = 2;
      else if (d <= -0.030) f_teamIsoV3 = -4;
      else if (d <= -0.015) f_teamIsoV3 = -2;
    } else {
      // High combined ISO → more HRs → OVER on totals.
      const combined = homeTeam.isoSeason + awayTeam.isoSeason;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - 2 * 0.165) * flip;  // league avg ISO ≈ 0.165
      if (d >= 0.030) f_teamIsoV3 = 3;
      else if (d >= 0.015) f_teamIsoV3 = 1;
      else if (d <= -0.030) f_teamIsoV3 = -3;
      else if (d <= -0.015) f_teamIsoV3 = -1;
    }
  }
  const score_team_iso_v3 = roundHalfAwayFromZero(f_teamIsoV3 * 1.0);

  // (13) D-664-B — Pen rest. Total relief IP last 48h. Tired bullpen blows late leads
  // = bad for FAVORITE covering -1.5 (cover requires holding the margin late).
  let f_penRestV3 = 0;
  if (homeTeam.penIp48h != null && awayTeam.penIp48h != null) {
    if (market === "side") {
      // Heavier 48h pen usage → worse cover prob for that team.
      const diff = awayTeam.penIp48h - homeTeam.penIp48h;  // positive → home pen fresher
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 4.0) f_penRestV3 = 3;
      else if (d >= 2.0) f_penRestV3 = 2;
      else if (d <= -4.0) f_penRestV3 = -3;
      else if (d <= -2.0) f_penRestV3 = -2;
    } else {
      // Both pens overused → late-game runs more likely → OVER.
      // D-710 BUG 2 FIX: baseline was 6.0 but actual combined penIp48h distribution
      // (measured on n=58 recent picks) is median=35.0, mean=32.6, range 17.0-37.3.
      // Old baseline yielded d=29 vs threshold 4 (7x past) → 100% saturated at abs(2).
      // New baseline 35.0 (observed median) with same ±2/±4 thresholds yields ~64%
      // score-0, ~15% score-±1, ~21% saturated — fresh-pen games (combined=17, low tail)
      // correctly saturate UNDER, heavy-use games correctly push OVER.
      const combined = homeTeam.penIp48h + awayTeam.penIp48h;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - 35.0) * flip;
      if (d >= 4.0) f_penRestV3 = 2;
      else if (d >= 2.0) f_penRestV3 = 1;
      else if (d <= -4.0) f_penRestV3 = -2;
      else if (d <= -2.0) f_penRestV3 = -1;
    }
  }
  const score_pen_rest_v3 = roundHalfAwayFromZero(f_penRestV3 * 1.0);

  // (14) D-664-C — Back-of-bullpen quality. High-leverage (closer + setup) ERA.
  // Decides 7th-9th = decides -1.5 cover for favorites.
  let f_bobV3 = 0;
  if (homeTeam.bobAvgEra != null && awayTeam.bobAvgEra != null) {
    if (market === "side") {
      // Lower BoB ERA = better high-leverage = covers more.
      const diff = awayTeam.bobAvgEra - homeTeam.bobAvgEra;  // positive → home BoB better
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 1.5) f_bobV3 = 4;
      else if (d >= 0.75) f_bobV3 = 2;
      else if (d <= -1.5) f_bobV3 = -4;
      else if (d <= -0.75) f_bobV3 = -2;
    } else {
      // Two bad BoBs → late-inning runs more likely → OVER.
      const combinedDev = (homeTeam.bobAvgEra + awayTeam.bobAvgEra) - 2 * LEAGUE_AVG_ERA;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = combinedDev * flip;
      if (d >= 1.5) f_bobV3 = 3;
      else if (d >= 0.75) f_bobV3 = 1;
      else if (d <= -1.5) f_bobV3 = -3;
      else if (d <= -0.75) f_bobV3 = -1;
    }
  }
  const score_bob_quality_v3 = roundHalfAwayFromZero(f_bobV3 * 1.0);

  // (15) D-664-D — Starter last-3-start form. Hot SP (cold ERA) vs season ERA
  // = direction of next start. Captured here as ERA delta from full season.
  let f_spLast3V3 = 0;
  if (homePitcher?.last3StartEra != null && awayPitcher?.last3StartEra != null
      && homePitcher.era > 0 && awayPitcher.era > 0) {
    // Form deltas: negative = hot (recent ERA < season ERA).
    const homeForm = homePitcher.last3StartEra - homePitcher.era;
    const awayForm = awayPitcher.last3StartEra - awayPitcher.era;
    if (market === "side") {
      // Negative form (hot) on home SP + positive (cold) on away SP → home covers.
      const formDiff = awayForm - homeForm;  // positive → home SP relatively hot
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = formDiff * flip;
      if (d >= 2.0) f_spLast3V3 = 4;
      else if (d >= 1.0) f_spLast3V3 = 2;
      else if (d <= -2.0) f_spLast3V3 = -4;
      else if (d <= -1.0) f_spLast3V3 = -2;
    } else {
      // Both SPs cold (positive form) → high-runs game → OVER.
      const combined = homeForm + awayForm;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = combined * flip;
      if (d >= 3.0) f_spLast3V3 = 3;
      else if (d >= 1.5) f_spLast3V3 = 1;
      else if (d <= -3.0) f_spLast3V3 = -3;
      else if (d <= -1.5) f_spLast3V3 = -1;
    }
  }
  const score_sp_last3_form_v3 = roundHalfAwayFromZero(f_spLast3V3 * 1.0);

  // (16) D-664-E — Lineup depth (top-3 vs bottom-3 OPS PA-weighted, hand-blended).
  // Bottom-third weakness stalls rallies → covering -1.5 needs late-game scoring.
  let f_depthV3 = 0;
  if (lvh && lvh.home_bottom3_ops != null && lvh.away_bottom3_ops != null
      && lvh.home_top3_ops != null && lvh.away_top3_ops != null) {
    // Depth metric: top3 + bottom3 average. Deeper lineup = closer to top.
    const homeDepth = (lvh.home_top3_ops + lvh.home_bottom3_ops) / 2;
    const awayDepth = (lvh.away_top3_ops + lvh.away_bottom3_ops) / 2;
    if (market === "side") {
      const diff = homeDepth - awayDepth;
      const pickHomeF = prop.pickSide === "home" || prop.pickSide === "over";
      const flip = pickHomeF ? 1 : -1;
      const d = diff * flip;
      if (d >= 0.060) f_depthV3 = 3;
      else if (d >= 0.030) f_depthV3 = 2;
      else if (d <= -0.060) f_depthV3 = -3;
      else if (d <= -0.030) f_depthV3 = -2;
    } else {
      // Both deep lineups → more runs → OVER.
      const combined = homeDepth + awayDepth;
      const flip = prop.pickSide === "over" ? 1 : -1;
      const d = (combined - 2 * 0.720) * flip;  // league-avg OPS bench
      if (d >= 0.060) f_depthV3 = 2;
      else if (d >= 0.030) f_depthV3 = 1;
      else if (d <= -0.060) f_depthV3 = -2;
      else if (d <= -0.030) f_depthV3 = -1;
    }
  }
  const score_lineup_depth_v3 = roundHalfAwayFromZero(f_depthV3 * 1.0);

  // Market signals (weight LITERAL 0 — persist, do not score, per D-636-UNVALIDATED-PENDING discipline).
  const ms = ctx.marketSignals ?? null;
  const score_line_movement_v3 = 0;  // ms?.lm_raw_score × 0
  const score_sharp_money_v3 = 0;    // ms?.sharp_money_raw × 0
  const score_rlm_signal_v3 = 0;     // ms?.rlm_raw_score × 0
  const score_steam_v3 = 0;          // ms?.steam_signal × 0

  // V3 confidence assembly (only applied when D652_PROMOTE).
  let confidence_v3_shadow = 50 + edgeV3 * (market === "total" ? 6 : 8);
  confidence_v3_shadow +=
      score_team_offense_form_v3 + score_team_run_prevention_form_v3
    + score_sp_statcast_quality_v3 + score_bullpen_quality_v3
    + score_team_defense_oaa_v3   // D-653 SHIP 2 — REAL defense factor (provisional weight)
    + score_park_runs_v3 + score_lineup_confirmation_v3
    // D-663 — five additional handicapper factors, all provisional weights.
    + score_pitcher_gb_fb_rate_v3
    + score_team_ops_v3
    + score_sp_ip_depth_v3
    + score_blowout_tendency_v3
    + score_team_travel_flat_v3
    // D-664 — five additional handicapper factors closing the D-663 deferred set.
    + score_team_iso_v3
    + score_pen_rest_v3
    + score_bob_quality_v3
    + score_sp_last3_form_v3
    + score_lineup_depth_v3
    + score_line_movement_v3 + score_sharp_money_v3 + score_rlm_signal_v3 + score_steam_v3
    // Keep v1 factors that v3 has NOT replaced (avoid double-count of replaced ones):
    + score_pitching_matchup        // ERA-based SP matchup; complements Statcast above
    + score_lineup_vs_hand_split    // D-285 platoon
    + score_h2h_recent              // recent matchup
    + score_weather_wind + score_weather_temp + score_umpire_k_zone;
  // Intentionally DROPPED from v3 confidence (entangled / replaced):
  //   score_offense_differential (w=0 in DB anyway; replaced by score_team_offense_form_v3)
  //   score_team_form + score_recent_run_diff (entangled offense+defense; decoupled into v3 form pair)
  //   score_bullpen_strength (replaced by score_bullpen_quality_v3)
  //   score_ballpark_factor (replaced by score_park_runs_v3, un-gated on side)
  confidence_v3_shadow = clamp(Math.round(confidence_v3_shadow), 0, 100);

  if (D652_PROMOTE) {
    confidence = confidence_v3_shadow;
  }

  const confidence_pre_d297 = confidence;
  let d297_elite_suppression_triggered = false;
  // ============================================================
  // D-297 SHIP 1 — Elite suppression for home-side game_side picks
  // where score_offense_differential ≥ +6.
  //
  // ROOT CAUSE (D-296 deep dive): score_offense_differential is a
  // "who wins" signal. The algorithm above adds it directly to
  // confidence as if it were a "who covers the spread" signal, but
  // spreads already price in offensive differential. When home is
  // rated >= +0.5 RPG better than away (f_offDiff = +4 → score = +6,
  // or f_offDiff = +8 → score = +12), the algorithm gives Elite (90+)
  // confidence to home-cover; historical home covers only 17.6%
  // of the time in this cell (3/17 on n=95 MLB Elite sample).
  //
  // EXPECTED LIFT (counterfactual on existing n=95 MLB Elite):
  // 64.2% → 71.6% on n=81 (+7.4pp), suppressing 14 picks (3 hit,
  // 11 miss).
  //
  // Asymmetric on purpose: away-side picks with mirror condition
  // (away offense rated +0.5 better) WIN at 100% (6/6 in same bucket
  // per D-296 cross-check). The factor is correctly directional for
  // away-side spread covers but inverted for home-side covers.
  //
  // Weight adjustment alone insufficient per D-297 SHIP 1 backtest
  // sweep (W=0.3-1.5 all give 58-61% Elite WR); ≥3 non-zero factor
  // gate unusable (would suppress 68 of 69 picks); surgical
  // suppression on this specific cell matches D-296 counterfactual.
  if (market === "side"
      && (prop.pickSide === "home" || prop.pickSide === "over")
      && score_offense_differential >= 6
      && confidence >= 90) {
    confidence = 89;
    d297_elite_suppression_triggered = true;
  }
  // ============================================================

  // Trivial-line cap doesn't really apply to spreads/totals — skip.

  // ============================================================
  // D-479 LONGSHOT OVER CAP — applies to game_total OVER picks too.
  // Real-data cluster sample (n=15 game_total OVER GOOD +100+): WR 20%
  // ROI -59.5% — the worst-bleeding sub-cohort of the longshot trap.
  // Same structural rule as in batter/pitcher scorers: GOOD-tier OVER
  // at +100-or-longer odds → cap 65 (drop to LEAN). Game_side market
  // ("side") not affected — only totals where pick_side="over" is the
  // betting-OVER-the-line direction.
  // ============================================================
  if (market === "total"
      && prop.pickSide === "over"
      && prop.odds >= 100
      && confidence >= 70 && confidence <= 79) {
    confidence = 65;
  }
  // ============================================================
  // D-509 ELITE/STRONG LONGSHOT OVER CAP — applies to game_total
  // OVER at any odds (game_total OVER conf>=80 cluster bleeds at
  // -56u on n=64 post-backfill; the worst single-market loser in
  // the ELITE/STRONG longshot cluster). Per D-505 Option 3: cap
  // game_total OVER at conf>=80 regardless of odds (the cluster
  // bleed isn't limited to +150+ for this market). game_side
  // ("side") not affected — pickSide is "home"/"away" there.
  // ============================================================
  if (market === "total"
      && prop.pickSide === "over"
      && confidence >= 80) {
    confidence = 75;
  }
  // ============================================================

  let unbettableJuiceFlag = false;
  if (prop.pickSide === "under") {
    if (confidence >= 90 && prop.odds <= -350)      unbettableJuiceFlag = true;
    else if (confidence >= 80 && prop.odds <= -300) unbettableJuiceFlag = true;
    else if (confidence >= 70 && prop.odds <= -250) unbettableJuiceFlag = true;
    else if (confidence >= 60 && prop.odds <= -200) unbettableJuiceFlag = true;
  }
  // For game side: no clean "last10 hit rate" — skip coinFlipFlag
  const coinFlipFlag = false;

  const factorArr = [
    score_offense_differential, score_pitching_matchup, score_bullpen_strength,
    score_recent_run_diff, score_h2h_recent, score_team_form,
    score_ballpark_factor, score_weather_wind, score_weather_temp, score_umpire_k_zone,
    score_lineup_vs_hand_split,  // D-285 SHIP 1
  ];
  const negativeFactorCount = factorArr.filter((v) => v < 0).length;
  const negativeStackingFlag = confidence >= 80 && negativeFactorCount >= 3;

  const breakdown: Record<string, number | string | null | boolean> = {
    market,
    home_rpg: Math.round(homeTeam.runsPerGame * 100) / 100,
    away_rpg: Math.round(awayTeam.runsPerGame * 100) / 100,
    home_rapg: Math.round(homeTeam.runsAllowedPerGame * 100) / 100,
    away_rapg: Math.round(awayTeam.runsAllowedPerGame * 100) / 100,
    home_bullpen_era: homeTeam.bullpenEra ?? null,
    away_bullpen_era: awayTeam.bullpenEra ?? null,
    home_pitcher_era: homePitcher?.era ?? null,
    away_pitcher_era: awayPitcher?.era ?? null,
    park_runs_factor: ballpark?.runsFactor ?? 1.000,
    weather_temp_f: weather?.tempF ?? null,
    weather_wind_mph: weather?.windSpeed ?? null,
    umpire_k_zone_idx: umpire?.kZoneSizeIndex ?? null,
    proj_home_runs: Math.round(projHomeRuns * 100) / 100,
    proj_away_runs: Math.round(projAwayRuns * 100) / 100,
    proj_total: Math.round(projTotal * 100) / 100,
    proj_diff: Math.round(projDiff * 100) / 100,
    raw_edge: Math.round(edge * 100) / 100,
    score_offense_differential, score_pitching_matchup, score_bullpen_strength,
    score_recent_run_diff, score_h2h_recent, score_team_form,
    score_ballpark_factor, score_weather_wind, score_weather_temp, score_umpire_k_zone,
    // D-285 SHIP 1 — lineup-vs-pitcher-hand factor
    score_lineup_vs_hand_split,
    home_lineup_vs_lhp_ops: lvh?.home_vs_lhp_ops ?? null,
    home_lineup_vs_rhp_ops: lvh?.home_vs_rhp_ops ?? null,
    away_lineup_vs_lhp_ops: lvh?.away_vs_lhp_ops ?? null,
    away_lineup_vs_rhp_ops: lvh?.away_vs_rhp_ops ?? null,
    home_lineup_pa: lvh?.home_lineup_pa ?? 0,
    away_lineup_pa: lvh?.away_lineup_pa ?? 0,
    // D-286 SHIP 1 — lineup source transparency
    home_lineup_source: lvh?.home_source ?? "unavailable",
    away_lineup_source: lvh?.away_source ?? "unavailable",
    pick_side: prop.pickSide,
    // D-297 SHIP 1 transparency
    confidence_pre_d297_suppression: confidence_pre_d297,
    d297_elite_suppression_triggered,
    v1_algo: `10-factor MLB ${market === "side" ? "game_side" : "game_total"} (D-204 T3.3) + lineup_vs_hand (D-285) + projected_fallback (D-286) + d297_suppression`,
    // ─────────────────────────────────────────────────────────────
    // D-649 — V2 rebuild fields (always emitted, even in shadow mode).
    // Confidence is mutated by v2 ONLY when D649_GAME_SIDE_V2_PROMOTE=true.
    // Persisted so D-549 harness + OOS validator can measure on real picks.
    home_ops_season: homeTeam.opsSeason,
    away_ops_season: awayTeam.opsSeason,
    home_k_rate: homeTeam.kRate,
    away_k_rate: awayTeam.kRate,
    home_lineup_ops_vs_opp_hand: homeLineupOPSvsAwayHand,
    away_lineup_ops_vs_opp_hand: awayLineupOPSvsHomeHand,
    proj_home_runs_v2: Math.round(projHomeRunsV2 * 100) / 100,
    proj_away_runs_v2: Math.round(projAwayRunsV2 * 100) / 100,
    proj_total_v2: Math.round(projTotalV2 * 100) / 100,
    proj_diff_v2: Math.round(projDiffV2 * 100) / 100,
    raw_edge_v2: Math.round(edgeV2 * 100) / 100,
    score_team_offense_strength_v2,
    score_k_matchup_v2,
    d649_v2_promoted: D649_PROMOTE,
    // ─────────────────────────────────────────────────────────────
    // D-652 — V3 rebuild fields (always emitted; confidence mutated only when env flag set).
    // Persisted so forward-test (D-549 r_residual harness) can measure on real
    // post-D-652 game_side picks. Per ESC #3: clean OOS impossible on real factors
    // (cache_team_batting_stats only has 30d history; OAA/wOBA/ISO not in cache).
    // home_bullpen_k_per_9: homeTeam.bullpenKPer9,
    home_bullpen_k_per_9: homeTeam.bullpenKPer9,
    away_bullpen_k_per_9: awayTeam.bullpenKPer9,
    home_bullpen_baa: homeTeam.bullpenBaa,
    away_bullpen_baa: awayTeam.bullpenBaa,
    home_sp_expected_whiff_pct: homePitcher?.expectedWhiffPct ?? null,
    away_sp_expected_whiff_pct: awayPitcher?.expectedWhiffPct ?? null,
    home_sp_expected_k_pct: homePitcher?.expectedKPct ?? null,
    away_sp_expected_k_pct: awayPitcher?.expectedKPct ?? null,
    home_sp_expected_put_away: homePitcher?.expectedPutAway ?? null,
    away_sp_expected_put_away: awayPitcher?.expectedPutAway ?? null,
    proj_home_runs_v3: Math.round(projHomeRunsV3 * 100) / 100,
    proj_away_runs_v3: Math.round(projAwayRunsV3 * 100) / 100,
    proj_total_v3: Math.round(projTotalV3 * 100) / 100,
    proj_diff_v3: Math.round(projDiffV3 * 100) / 100,
    raw_edge_v3: Math.round(edgeV3 * 100) / 100,
    confidence_v3_shadow,
    score_team_offense_form_v3,
    score_team_run_prevention_form_v3,
    score_sp_statcast_quality_v3,
    score_bullpen_quality_v3,
    // D-653 SHIP 2 — REAL defense OAA fields persisted unconditionally.
    home_team_oaa: homeTeam.teamOAA,
    away_team_oaa: awayTeam.teamOAA,
    score_team_defense_oaa_v3,
    score_park_runs_v3,
    score_lineup_confirmation_v3,
    // D-663 — five new handicapper factor scores + raw inputs for 7d lift test.
    score_pitcher_gb_fb_rate_v3,
    score_team_ops_v3,
    score_sp_ip_depth_v3,
    score_blowout_tendency_v3,
    score_team_travel_flat_v3,
    home_pitcher_go_to_ao: homePitcher?.groundOutsToAirouts ?? null,
    away_pitcher_go_to_ao: awayPitcher?.groundOutsToAirouts ?? null,
    home_team_ops_season: homeTeam.opsSeason,
    away_team_ops_season: awayTeam.opsSeason,
    home_sp_games_started: homePitcher?.gamesStarted ?? null,
    away_sp_games_started: awayPitcher?.gamesStarted ?? null,
    home_sp_ip_per_start: (homePitcher?.gamesStarted != null && homePitcher.gamesStarted > 0)
      ? Math.round((homePitcher.inningsPitched / homePitcher.gamesStarted) * 100) / 100 : null,
    away_sp_ip_per_start: (awayPitcher?.gamesStarted != null && awayPitcher.gamesStarted > 0)
      ? Math.round((awayPitcher.inningsPitched / awayPitcher.gamesStarted) * 100) / 100 : null,
    home_l10_avg_win_margin: homeTeam.l10AvgWinMargin,
    away_l10_avg_win_margin: awayTeam.l10AvgWinMargin,
    home_l10_blowout_pct: homeTeam.l10BlowoutPct,
    away_l10_blowout_pct: awayTeam.l10BlowoutPct,
    home_travel_miles: ctx.gameTravel?.home?.miles ?? null,
    away_travel_miles: ctx.gameTravel?.away?.miles ?? null,
    home_travel_direction: ctx.gameTravel?.home?.direction ?? null,
    away_travel_direction: ctx.gameTravel?.away?.direction ?? null,
    d663_wired: true,
    // D-664 — five additional handicapper factor scores + raw inputs for 7d lift test.
    score_team_iso_v3,
    score_pen_rest_v3,
    score_bob_quality_v3,
    score_sp_last3_form_v3,
    score_lineup_depth_v3,
    home_team_iso_season: homeTeam.isoSeason,
    away_team_iso_season: awayTeam.isoSeason,
    home_pen_ip_48h: homeTeam.penIp48h,
    away_pen_ip_48h: awayTeam.penIp48h,
    home_bob_avg_era: homeTeam.bobAvgEra,
    away_bob_avg_era: awayTeam.bobAvgEra,
    home_sp_last3_era: homePitcher?.last3StartEra ?? null,
    away_sp_last3_era: awayPitcher?.last3StartEra ?? null,
    home_lineup_top3_ops: lvh?.home_top3_ops ?? null,
    away_lineup_top3_ops: lvh?.away_top3_ops ?? null,
    home_lineup_bottom3_ops: lvh?.home_bottom3_ops ?? null,
    away_lineup_bottom3_ops: lvh?.away_bottom3_ops ?? null,
    d664_extras_wired: true,
    score_line_movement_v3,
    score_sharp_money_v3,
    score_rlm_signal_v3,
    score_steam_v3,
    // Market-signal raw values (computed by callers; null if not plumbed yet).
    lm_raw_score: ms?.lm_raw_score ?? null,
    rlm_raw_score: ms?.rlm_raw_score ?? null,
    sharp_money_raw: ms?.sharp_money_raw ?? null,
    steam_signal: ms?.steam_signal ?? null,
    d652_v3_promoted: D652_PROMOTE,
  };

  // D-406: pre-cap for game markets = pre-D-297-suppression. D-140 cap doesn't
  // fire on game markets (line not <=0.5); the relevant suppression layer is D-297.
  const confidence_pre_cap = confidence_pre_d297;

  return {
    confidence,
    confidence_pre_cap,
    confidence_pre_tier_aware: confidence,
    verdict: getScoreLabel(confidence),
    projectedHomeRuns: Math.round(projHomeRuns * 100) / 100,
    projectedAwayRuns: Math.round(projAwayRuns * 100) / 100,
    projectedTotal: Math.round(projTotal * 100) / 100,
    edge: Math.round(edge * 100) / 100,
    score_offense_differential, score_pitching_matchup, score_bullpen_strength,
    score_recent_run_diff, score_h2h_recent, score_team_form,
    score_ballpark_factor, score_weather_wind, score_weather_temp, score_umpire_k_zone,
    score_lineup_vs_hand_split,  // D-285 SHIP 1
    unbettableJuiceFlag, coinFlipFlag, negativeStackingFlag, negativeFactorCount,
    breakdown,
  };
}



// D-287 marker 1779456899
// D-287 trigger force 1779457118
