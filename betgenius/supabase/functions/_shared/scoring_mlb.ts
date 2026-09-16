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
}

export interface PitcherGameLogEntry {
  date: string;
  strikeOuts: number;
  inningsPitched: number;
  opponent: string;
  pitchCount: number | null;
}

export interface TeamHittingStats {
  gamesPlayed: number;
  strikeOuts: number;
  plateAppearances: number;
  kRate: number;
  kRateVsLHP: number | null;
  kRateVsRHP: number | null;
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
  arsenal?: { breaking_ball_pct: number | null; offspeed_pct: number | null; total_pitches: number | null } | null;
}

export interface PitcherKScoringResult {
  confidence: number;                  // 0-100 final
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

const W = {
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
};

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

  // ---- baseline projection (same blend as v0 + clearer ceiling/floor)
  const last5 = gameLog.slice(-5);
  const recentAvg = last5.length > 0
    ? last5.reduce((a, g) => a + g.strikeOuts, 0) / last5.length
    : 0;
  const seasonAvgPerStart = season.gamesPlayed > 0
    ? season.strikeOuts / season.gamesPlayed
    : 0;

  const blended = recentAvg > 0
    ? 0.6 * recentAvg + 0.4 * seasonAvgPerStart
    : seasonAvgPerStart;

  const oppKRate = opposingHitting?.kRate ?? LEAGUE_AVG_TEAM_K_RATE;
  const oppAdjustment = clamp(oppKRate / LEAGUE_AVG_TEAM_K_RATE, 0.75, 1.30);
  const parkAdj = ballpark ? clamp(ballpark.kFactor, 0.85, 1.20) : 1.0;
  const projectedK = blended * oppAdjustment * parkAdj;
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
  const score_pitcher_k_rate = Math.round(f_pitcherKRate * W.pitcherKRate);

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
  const score_pitcher_form = Math.round(f_pitcherForm * W.pitcherForm);

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
  const score_opposing_lineup_k = Math.round(f_opposingLineupK * W.opposingLineupK);

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
  const score_handedness_matchup = Math.round(f_handednessMatchup * W.handednessMatchup);

  // ============================================================
  // FACTOR 5 — score_pitch_count_trend
  // Last 3 starts avg pitch count vs starter norm (90). Pitcher
  // going deeper = more K opportunity. Limited use when pitch_count
  // is null in the source data.
  // ============================================================
  let f_pitchCountTrend = 0;
  const last3WithPC = gameLog.slice(-3).filter((g) => typeof g.pitchCount === "number" && (g.pitchCount as number) > 0);
  if (last3WithPC.length >= 2) {
    const avgPC = last3WithPC.reduce((a, g) => a + (g.pitchCount as number), 0) / last3WithPC.length;
    const delta = avgPC - STARTER_PITCHES_NORM;
    if (delta >= 15)       f_pitchCountTrend = 4;
    else if (delta >= 7)   f_pitchCountTrend = 2;
    else if (delta <= -15) f_pitchCountTrend = -4;
    else if (delta <= -7)  f_pitchCountTrend = -2;
  }
  f_pitchCountTrend *= sideFlip;
  const score_pitch_count_trend = Math.round(f_pitchCountTrend * W.pitchCountTrend);

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
  const score_rest_pitcher = Math.round(f_restPitcher * W.restPitcher);

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
  const score_ballpark_factor = Math.round(f_ballparkFactor * W.ballparkFactor);

  // ============================================================
  // FACTOR 8 — score_weather_wind
  // Strong wind tends to depress K-rate by changing pitch movement;
  // tailwind into batter slightly reduces swing-and-miss. v1
  // conservative: only ±8mph from norm matters. Indoor → 0.
  // ============================================================
  let f_weatherWind = 0;
  if (weather && weather.condition !== "indoor" && typeof weather.windSpeed === "number") {
    const ws = weather.windSpeed;
    if (ws >= 18)      f_weatherWind = -3;
    else if (ws >= 12) f_weatherWind = -1;
    // Calm conditions slightly favor strikeouts (cleaner ball flight).
    else if (ws <= 4)  f_weatherWind = 1;
  }
  f_weatherWind *= sideFlip;
  const score_weather_wind = Math.round(f_weatherWind * W.weatherWind);

  // ============================================================
  // FACTOR 9 — score_weather_temp
  // Hot air = ball flies = fewer K. Cool air = denser, more K.
  // v1: ±15F bands.
  // ============================================================
  let f_weatherTemp = 0;
  if (weather && weather.condition !== "indoor" && typeof weather.tempF === "number") {
    const d = weather.tempF - LEAGUE_AVG_TEMP_F;
    if (d >= 15)       f_weatherTemp = -3;
    else if (d >= 8)   f_weatherTemp = -1;
    else if (d <= -15) f_weatherTemp = 3;
    else if (d <= -8)  f_weatherTemp = 1;
  }
  f_weatherTemp *= sideFlip;
  const score_weather_temp = Math.round(f_weatherTemp * W.weatherTemp);

  // ============================================================
  // FACTOR 10 — score_umpire_k_zone
  // k_zone_size_index >1 = bigger called-strike zone = pitcher friendly.
  // ============================================================
  let f_umpireKZone = 0;
  if (umpire && typeof umpire.kZoneSizeIndex === "number") {
    const kz = umpire.kZoneSizeIndex;
    if (kz >= 1.06)      f_umpireKZone = 6;
    else if (kz >= 1.03) f_umpireKZone = 3;
    else if (kz >= 1.01) f_umpireKZone = 1;
    else if (kz <= 0.94) f_umpireKZone = -6;
    else if (kz <= 0.97) f_umpireKZone = -3;
    else if (kz <= 0.99) f_umpireKZone = -1;
  }
  f_umpireKZone *= sideFlip;
  const score_umpire_k_zone = Math.round(f_umpireKZone * W.umpireKZone);

  // ---- aggregate
  confidence +=
    score_pitcher_k_rate + score_pitcher_form + score_opposing_lineup_k +
    score_handedness_matchup + score_pitch_count_trend + score_rest_pitcher +
    score_ballpark_factor + score_weather_wind + score_weather_temp +
    score_umpire_k_zone;

  confidence = clamp(Math.round(confidence), 0, 100);

  // ============================================================
  // D-140 trivial-line cap — heavy juice on a tiny line shouldn't
  // earn an Elite read just from edge math. Mirrors NBA.
  // ============================================================
  if (prop.line <= 0.5 && Math.abs(prop.odds) >= 200 && confidence > 65) {
    confidence = 65;
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
  ];
  const negativeFactorCount = factorArr.filter((v) => v < 0).length;
  const negativeStackingFlag = confidence >= 80 && negativeFactorCount >= 3;

  // ============================================================
  // D-276-FACTORS — Statcast factor #1: pitcher xERA edge.
  // D-278-FACTORS — Statcast factor #4: pitcher BAA-allowed (est_ba).
  // Both gracefully degrade to 0 when respective ctx.statcast fields null.
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
  const score_pitcher_xera_edge = Math.round(f_pitcherXeraEdge * 1.0); // default weight 1.0 from algorithm_weights.w_mlb_pitcher_xera_edge

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
  const score_pitcher_baa = Math.round(f_pitcherBaa * 1.0); // w_mlb_pitcher_baa

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
  const score_catcher_framing = Math.round(f_catcherFraming * 1.0); // w_mlb_catcher_framing weight 1.0

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
  const score_pitcher_pitch_mix_k = Math.round(f_pitchMix * 1.0);  // w_mlb_pitcher_pitch_mix_k

  // D-276 + D-278 + D-282 + D-286 — apply Statcast + arsenal factors to final confidence.
  confidence += score_pitcher_xera_edge + score_pitcher_baa + score_catcher_framing + score_pitcher_pitch_mix_k;
  confidence = clamp(confidence, 0, 100);

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
    pick_side: prop.pickSide,
    pitcher_throws: season.throws ?? "unknown",
    v1_algo: "10-factor MLB pitcher_k (D-204) + Statcast 3-factor (D-276+D-278+D-282) + pitch_mix (D-286)",
  };

  return {
    confidence,
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
    unbettableJuiceFlag, coinFlipFlag, negativeStackingFlag, negativeFactorCount,
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
}

export interface BatterMarketResult {
  confidence: number;
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
  // sanity
  unbettableJuiceFlag: boolean;
  coinFlipFlag: boolean;
  negativeStackingFlag: boolean;
  negativeFactorCount: number;
  breakdown: Record<string, number | string | null | boolean>;
}

const W_BATTER = {
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
};

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

  // Pitcher quality adjustment (worse pitcher → more offense for batter)
  let pitcherAdj = 1.0;
  if (opposingPitcher && opposingPitcher.era > 0) {
    pitcherAdj = clamp(opposingPitcher.era / LEAGUE_AVG_ERA, 0.80, 1.25);
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

  let confidence = 50 + edge * (marketStat === "homeRuns" ? 25 : marketStat === "hits" ? 10 : 6);

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
    // High BABIP → regression down → for "over" picks this hurts (f<0)
    // Low BABIP → regression up → for "over" picks this helps (f>0)
    // sideFlip handles under/over conversion at the end
    if (babipDiff >= 0.060)      f_babip = -5;  // very lucky, strong regression down
    else if (babipDiff >= 0.030) f_babip = -3;  // somewhat lucky
    else if (babipDiff >= 0.015) f_babip = -1;
    else if (babipDiff <= -0.060) f_babip = 5;  // very unlucky, strong upside
    else if (babipDiff <= -0.030) f_babip = 3;
    else if (babipDiff <= -0.015) f_babip = 1;
  }
  f_babip *= sideFlip;
  const score_batter_hit_rate = isPowerMarket ? 0 : Math.round(f_hitRate * W_BATTER.hitRate);

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
  const score_batter_power_rate = isPowerMarket ? Math.round(f_powerRate * W_BATTER.powerRate) : 0;

  // ============================================================
  // FACTOR — score_batter_form (last 10 game avg vs season)
  // ============================================================
  let f_form = 0;
  if (gameLog.length >= 5 && seasonAvgPerGame > 0) {
    const delta = recentAvg - seasonAvgPerGame;
    const scale = marketStat === "homeRuns" ? 0.3 : marketStat === "hits" ? 0.8 : 0.5;
    if (delta >= 2 * scale)      f_form = 8;
    else if (delta >= 1 * scale) f_form = 4;
    else if (delta >= 0.5 * scale) f_form = 2;
    else if (delta <= -2 * scale) f_form = -8;
    else if (delta <= -1 * scale) f_form = -4;
    else if (delta <= -0.5 * scale) f_form = -2;
  }
  f_form *= sideFlip;
  const score_batter_form = isPowerMarket ? 0 : Math.round(f_form * W_BATTER.form);
  const score_batter_form_power = isPowerMarket ? Math.round(f_form * W_BATTER.formPower) : 0;

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
  const score_opposing_pitcher_quality = Math.round(f_pitcherQ * W_BATTER.pitcherQuality);

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
  const score_pitcher_hr_rate = isPowerMarket ? Math.round(f_pitcherHr * W_BATTER.pitcherHrRate) : 0;

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
  const score_recent_at_bats = Math.round(f_recentAB * W_BATTER.recentAB);

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
  const score_handedness_matchup = Math.round(f_handMatchup * W_BATTER.handednessMatchup);

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
  const score_ballpark_factor = Math.round(f_park * W_BATTER.ballparkHitsFactor);

  // ============================================================
  // FACTOR — score_weather_temp (warm air → more offense)
  // ============================================================
  let f_temp = 0;
  if (weather && weather.condition !== "indoor" && typeof weather.tempF === "number") {
    const d = weather.tempF - LEAGUE_AVG_TEMP_F;
    if (d >= 15)       f_temp = 3;
    else if (d >= 8)   f_temp = 1;
    else if (d <= -15) f_temp = -3;
    else if (d <= -8)  f_temp = -1;
  }
  f_temp *= sideFlip;
  const score_weather_temp = Math.round(f_temp * W_BATTER.weatherTemp);

  // ============================================================
  // FACTOR — score_weather_wind (HR markets only — tailwind boosts)
  // ============================================================
  let f_wind = 0;
  if (isPowerMarket && weather && weather.condition !== "indoor" && typeof weather.windSpeed === "number") {
    const ws = weather.windSpeed;
    if (ws >= 14)       f_wind = 3;
    else if (ws >= 8)   f_wind = 1;
    else if (ws <= 3)   f_wind = -1;
  }
  f_wind *= sideFlip;
  const score_weather_wind = isPowerMarket ? Math.round(f_wind * W_BATTER.weatherWind) : 0;

  // ============================================================
  // FACTOR — score_lineup_consistency
  // ============================================================
  const lcMag = lineupConsistencyScore(gameLog);
  const score_lineup_consistency = Math.round(lcMag * W_BATTER.lineupConsistency * sideFlip);

  // ---- aggregate
  confidence +=
    score_batter_hit_rate + score_batter_form + score_opposing_pitcher_quality +
    score_recent_at_bats + score_handedness_matchup + score_ballpark_factor +
    score_weather_temp + score_lineup_consistency +
    score_batter_power_rate + score_batter_form_power + score_pitcher_hr_rate +
    score_weather_wind;

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
      score_batter_xba = Math.round(f_xba * sideFlip * 1.0);  // w_mlb_batter_xba weight 1.0
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
      score_batter_exit_velo_trend = Math.round(f_evt * sideFlip * 1.0);  // w_mlb_batter_exit_velo_trend
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
      score_batter_barrel_rate = Math.round(f_barrel * sideFlip * 1.0);  // w_mlb_batter_barrel_rate default 1.0
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
      score_batter_xslg_regression = Math.round(f_xslg * sideFlip * 1.0);  // w_mlb_batter_xslg_regression default 1.0
    }
  }
  // D-281 SHIP 2: BABIP factor scoring (apply default weight 1.0)
  const score_batter_babip = Math.round(f_babip * 1.0);

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
  const score_batter_vs_pitcher_hand_split = Math.round(f_handSplit * 1.0);  // w_mlb_batter_vs_pitcher_hand_split = 1.0

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
  const score_bullpen_quality = Math.round(f_bullpenQuality * 1.0);  // w_mlb_bullpen_quality = 1.0

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
  if (marketStat === "homeRuns" && bo && !isIndoor && wd !== null && ws >= 5) {
    // Convert wind FROM-direction to TO-direction (where it's blowing toward).
    const windTo = (wd + 180) % 360;
    // Angular distance to CF bearing (0..180°). 0 = straight out to CF;
    // 180 = straight in from CF.
    let delta = Math.abs(windTo - bo.cf_compass_degrees) % 360;
    if (delta > 180) delta = 360 - delta;
    // Signed effect via cosine. cos(0)=+1 (out), cos(90)=0 (crosswind), cos(180)=-1 (in).
    const dirEffect = Math.cos((delta * Math.PI) / 180);
    // Speed multiplier: 5-15 mph moderate, 15+ mph strong
    const speedMult = ws >= 15 ? 1.0 : ws >= 10 ? 0.6 : 0.3;
    const score = dirEffect * speedMult;  // approx -1..+1
    if (score >= 0.6)       f_windDirHr = 6;
    else if (score >= 0.3)  f_windDirHr = 3;
    else if (score >= 0.15) f_windDirHr = 1;
    else if (score <= -0.6) f_windDirHr = -6;
    else if (score <= -0.3) f_windDirHr = -3;
    else if (score <= -0.15) f_windDirHr = -1;
  }
  f_windDirHr *= sideFlip;
  const score_wind_direction_hr = Math.round(f_windDirHr * 1.0);  // w_mlb_wind_direction_hr = 1.0

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
  const score_pitcher_hr_per_9 = Math.round(f_pitcherHrPer9 * 1.0);  // w_mlb_pitcher_hr_per_9 = 1.0

  confidence += score_batter_barrel_rate + score_batter_xslg_regression + score_batter_xba + score_batter_exit_velo_trend + score_batter_babip + score_batter_vs_pitcher_hand_split + score_bullpen_quality + score_pitcher_hr_per_9 + score_wind_direction_hr;
  confidence = clamp(Math.round(confidence), 0, 100);

  // D-140 trivial-line cap
  if (prop.line <= 0.5 && Math.abs(prop.odds) >= 200 && confidence > 65) confidence = 65;

  // Sanity flags
  let unbettableJuiceFlag = false;
  if (prop.pickSide === "under") {
    if (confidence >= 90 && prop.odds <= -350)      unbettableJuiceFlag = true;
    else if (confidence >= 80 && prop.odds <= -300) unbettableJuiceFlag = true;
    else if (confidence >= 70 && prop.odds <= -250) unbettableJuiceFlag = true;
    else if (confidence >= 60 && prop.odds <= -200) unbettableJuiceFlag = true;
  }

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
    pick_side: prop.pickSide,
    bats: season.bats ?? "unknown",
    v1_algo: `8-factor MLB batter ${marketStat} (D-204) + Statcast 5-factor + hand_split (D-282) + bullpen_quality (D-283) + pitcher_hr_per_9 (D-284) + wind_dir_hr (D-287)`,
  };

  return {
    confidence,
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
    unbettableJuiceFlag, coinFlipFlag, negativeStackingFlag, negativeFactorCount,
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
  } | null;
}

export interface GameMarketResult {
  confidence: number;
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

const W_GAME = {
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
};

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
  // ============================================================
  let f_offDiff = 0;
  if (market === "side") {
    const diff = homeTeam.runsPerGame - awayTeam.runsPerGame;
    const pickHome = prop.pickSide === "home" || prop.pickSide === "over";
    const flip = pickHome ? 1 : -1;
    const d = diff * flip;
    if (d >= 1.0)      f_offDiff = 8;
    else if (d >= 0.5) f_offDiff = 4;
    else if (d >= 0.25) f_offDiff = 2;
    else if (d <= -1.0) f_offDiff = -8;
    else if (d <= -0.5) f_offDiff = -4;
    else if (d <= -0.25) f_offDiff = -2;
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
  const score_offense_differential = Math.round(f_offDiff * W_GAME.offenseDiff);

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
  const score_pitching_matchup = Math.round(f_pmatchup * W_GAME.pitchingMatchup);

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
      if (d >= 1.0)       f_bullpen = 5;
      else if (d >= 0.5)  f_bullpen = 2;
      else if (d <= -1.0) f_bullpen = -5;
      else if (d <= -0.5) f_bullpen = -2;
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
  const score_bullpen_strength = Math.round(f_bullpen * W_GAME.bullpenStrength);

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
  const score_lineup_vs_hand_split = Math.round(f_lineupHandSplit * W_GAME.lineupVsHand);

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
  const score_recent_run_diff = Math.round(f_recent * W_GAME.recentRunDiff);

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
  const score_h2h_recent = Math.round(f_h2h * W_GAME.h2hRecent);

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
      if (target >= 1.5)       f_form = 4;
      else if (target >= 0.5)  f_form = 2;
      else if (target <= -1.5) f_form = -4;
      else if (target <= -0.5) f_form = -2;
    } else {
      // For totals: high combined positive form = hot offenses
      const combined = Math.abs(homeForm) + Math.abs(awayForm);
      if (combined >= 3) f_form = prop.pickSide === "over" ? 2 : -2;
    }
  }
  const score_team_form = Math.round(f_form * W_GAME.teamForm);

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
  const score_ballpark_factor = Math.round(f_park * W_GAME.ballpark);

  // ============================================================
  // FACTOR — score_weather_wind (totals only; matters for HR)
  // ============================================================
  let f_wind = 0;
  if (market === "total" && weather && weather.condition !== "indoor" && typeof weather.windSpeed === "number") {
    const ws = weather.windSpeed;
    const flip = prop.pickSide === "over" ? 1 : -1;
    if (ws >= 14)      f_wind = 3 * flip;
    else if (ws >= 8)  f_wind = 1 * flip;
    else if (ws <= 3)  f_wind = -1 * flip;
  }
  const score_weather_wind = Math.round(f_wind * W_GAME.weatherWind);

  // ============================================================
  // FACTOR — score_weather_temp (totals only)
  // ============================================================
  let f_temp = 0;
  if (market === "total" && weather && weather.condition !== "indoor" && typeof weather.tempF === "number") {
    const d = weather.tempF - LEAGUE_AVG_TEMP_F;
    const flip = prop.pickSide === "over" ? 1 : -1;
    if (d >= 15)       f_temp = 3 * flip;
    else if (d >= 8)   f_temp = 1 * flip;
    else if (d <= -15) f_temp = -3 * flip;
    else if (d <= -8)  f_temp = -1 * flip;
  }
  const score_weather_temp = Math.round(f_temp * W_GAME.weatherTemp);

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
  const score_umpire_k_zone = Math.round(f_umpire * W_GAME.umpireKZone);

  confidence +=
    score_offense_differential + score_pitching_matchup + score_bullpen_strength +
    score_recent_run_diff + score_h2h_recent + score_team_form +
    score_ballpark_factor + score_weather_wind + score_weather_temp +
    score_umpire_k_zone + score_lineup_vs_hand_split;
  confidence = clamp(Math.round(confidence), 0, 100);

  // Trivial-line cap doesn't really apply to spreads/totals — skip.

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
    v1_algo: `10-factor MLB ${market === "side" ? "game_side" : "game_total"} (D-204 T3.3) + lineup_vs_hand (D-285) + projected_fallback (D-286)`,
  };

  return {
    confidence,
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
