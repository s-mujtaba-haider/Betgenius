// Phase 1 backtest harness — MLB weights loader (Postgres).
//
// Mirror of supabase/functions/_shared/mlb_weights.ts DB-loading path,
// adapted for direct read-only Postgres. Uses getMlbDefaultWeights() from
// the real scorer as fallback on any error — same defense-in-depth as prod.

import {
  getMlbDefaultWeights,
  type MlbScoringWeights,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";
import type { Db } from "./env.ts";

const KNOWN_MLB_MARKETS: readonly string[] = [
  "pitcher_k", "batter_hits", "batter_hr", "batter_total_bases",
  "batter_rbis", "game_side", "game_total",
  "batter_strikeouts", "batter_runs_scored", "pitcher_outs",
] as const;

const COL_TO_PATH: Record<string, { group: "W" | "W_BATTER" | "W_GAME"; key: string }> = {
  w_mlb_pitcher_k_rate: { group: "W", key: "pitcherKRate" },
  w_mlb_pitcher_form: { group: "W", key: "pitcherForm" },
  w_mlb_opposing_lineup_k: { group: "W", key: "opposingLineupK" },
  w_mlb_handedness_matchup: { group: "W", key: "handednessMatchup" },
  w_mlb_pitch_count_trend: { group: "W", key: "pitchCountTrend" },
  w_mlb_rest_pitcher: { group: "W", key: "restPitcher" },
  w_mlb_pitcher_ballpark_factor: { group: "W", key: "ballparkFactor" },
  w_mlb_pitcher_weather_wind: { group: "W", key: "weatherWind" },
  w_mlb_pitcher_weather_temp: { group: "W", key: "weatherTemp" },
  w_mlb_pitcher_umpire_k_zone: { group: "W", key: "umpireKZone" },
  w_mlb_pitcher_command_trend: { group: "W", key: "pitcherCommandTrend" },
  w_mlb_pitcher_velocity_trend: { group: "W", key: "pitcherVelocityTrend" },
  w_mlb_lineup_k_composition: { group: "W", key: "lineupKComposition" },
  w_mlb_pitcher_xera_edge: { group: "W", key: "pitcherXeraEdge" },
  w_mlb_pitcher_baa: { group: "W", key: "pitcherBaa" },
  w_mlb_catcher_framing: { group: "W", key: "catcherFraming" },
  w_mlb_pitcher_pitch_mix_k: { group: "W", key: "pitcherPitchMixK" },
  w_mlb_batter_hit_rate: { group: "W_BATTER", key: "hitRate" },
  w_mlb_batter_form: { group: "W_BATTER", key: "form" },
  w_mlb_batter_pitcher_quality: { group: "W_BATTER", key: "pitcherQuality" },
  w_mlb_batter_recent_ab: { group: "W_BATTER", key: "recentAB" },
  w_mlb_batter_handedness_matchup: { group: "W_BATTER", key: "handednessMatchup" },
  w_mlb_batter_ballpark_hits_factor: { group: "W_BATTER", key: "ballparkHitsFactor" },
  w_mlb_batter_weather_temp: { group: "W_BATTER", key: "weatherTemp" },
  w_mlb_batter_lineup_consistency: { group: "W_BATTER", key: "lineupConsistency" },
  w_mlb_batter_power_rate: { group: "W_BATTER", key: "powerRate" },
  w_mlb_batter_form_power: { group: "W_BATTER", key: "formPower" },
  w_mlb_batter_pitcher_hr_rate: { group: "W_BATTER", key: "pitcherHrRate" },
  w_mlb_batter_weather_wind: { group: "W_BATTER", key: "weatherWind" },
  w_mlb_lineup_spot: { group: "W_BATTER", key: "lineupSpot" },
  w_mlb_day_after_night_fatigue: { group: "W_BATTER", key: "dayAfterNightFatigue" },
  w_mlb_travel_getaway: { group: "W_BATTER", key: "travelGetaway" },
  w_mlb_pitcher_baa_vs_hand: { group: "W_BATTER", key: "opposingPitcherBaaVsHand" },
  w_mlb_hitter_streak_fatigue: { group: "W_BATTER", key: "hitterStreakFatigue" },
  w_mlb_batter_xba: { group: "W_BATTER", key: "xba" },
  w_mlb_batter_exit_velo_trend: { group: "W_BATTER", key: "exitVeloTrend" },
  w_mlb_batter_barrel_rate: { group: "W_BATTER", key: "barrelRate" },
  w_mlb_batter_xslg_regression: { group: "W_BATTER", key: "xslgRegression" },
  w_mlb_batter_babip: { group: "W_BATTER", key: "babip" },
  w_mlb_batter_vs_pitcher_hand_split: { group: "W_BATTER", key: "vsPitcherHandSplit" },
  w_mlb_bullpen_quality: { group: "W_BATTER", key: "bullpenQuality" },
  w_mlb_wind_direction_hr: { group: "W_BATTER", key: "windDirectionHr" },
  w_mlb_pitcher_hr_per_9: { group: "W_BATTER", key: "pitcherHrPer9" },
  w_mlb_batter_line_hit_rate: { group: "W_BATTER", key: "lineHitRate" },
  w_mlb_batter_xwoba: { group: "W_BATTER", key: "xwoba" },
  w_mlb_batter_launch_angle: { group: "W_BATTER", key: "launchAngle" },
  w_mlb_batter_sweet_spot: { group: "W_BATTER", key: "sweetSpot" },
  w_mlb_batter_hard_hit: { group: "W_BATTER", key: "hardHit" },
  w_mlb_pitcher_hard_contact_allowed: { group: "W_BATTER", key: "pitcherHardContactAllowed" },
  w_mlb_batter_lineup_protection: { group: "W_BATTER", key: "lineupProtection" },
  w_mlb_batter_team_offense: { group: "W_BATTER", key: "teamOffense" },
  w_mlb_batter_sprint_speed: { group: "W_BATTER", key: "sprintSpeed" },
  w_mlb_batter_pull_rate: { group: "W_BATTER", key: "pullRate" },
  w_mlb_batter_pull_x_park_fence: { group: "W_BATTER", key: "pullXParkFence" },
  w_mlb_batter_contact_rate: { group: "W_BATTER", key: "contactRate" },
  w_mlb_game_offense_diff: { group: "W_GAME", key: "offenseDiff" },
  w_mlb_game_pitching_matchup: { group: "W_GAME", key: "pitchingMatchup" },
  w_mlb_game_bullpen_strength: { group: "W_GAME", key: "bullpenStrength" },
  w_mlb_game_recent_run_diff: { group: "W_GAME", key: "recentRunDiff" },
  w_mlb_game_h2h_recent: { group: "W_GAME", key: "h2hRecent" },
  w_mlb_game_team_form: { group: "W_GAME", key: "teamForm" },
  w_mlb_game_ballpark: { group: "W_GAME", key: "ballpark" },
  w_mlb_game_weather_wind: { group: "W_GAME", key: "weatherWind" },
  w_mlb_game_weather_temp: { group: "W_GAME", key: "weatherTemp" },
  w_mlb_game_umpire_k_zone: { group: "W_GAME", key: "umpireKZone" },
  w_mlb_lineup_vs_hand_split: { group: "W_GAME", key: "lineupVsHand" },
  w_mlb_batter_opp_pitcher_pitchtype_quality: { group: "W_BATTER", key: "oppPitcherPitchTypeQuality" },
};

function applyOverrides(
  global: MlbScoringWeights,
  overrides: Record<string, Record<string, number>>,
): Record<string, MlbScoringWeights> {
  const out: Record<string, MlbScoringWeights> = {};
  for (const market of KNOWN_MLB_MARKETS) {
    const marketOverride = overrides[market] ?? {};
    const w: MlbScoringWeights = {
      W: { ...global.W },
      W_BATTER: { ...global.W_BATTER },
      W_GAME: { ...global.W_GAME },
    };
    for (const [colName, value] of Object.entries(marketOverride)) {
      const path = COL_TO_PATH[colName];
      if (!path) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const group = w[path.group] as Record<string, number>;
      group[path.key] = value;
    }
    out[market] = w;
  }
  return out;
}

function mapRowToWeights(w: Record<string, unknown>, fallback: MlbScoringWeights): MlbScoringWeights {
  const num = (v: unknown, fb: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  return {
    W: {
      pitcherKRate: num(w.w_mlb_pitcher_k_rate, fallback.W.pitcherKRate),
      pitcherForm: num(w.w_mlb_pitcher_form, fallback.W.pitcherForm),
      opposingLineupK: num(w.w_mlb_opposing_lineup_k, fallback.W.opposingLineupK),
      handednessMatchup: num(w.w_mlb_handedness_matchup, fallback.W.handednessMatchup),
      pitchCountTrend: num(w.w_mlb_pitch_count_trend, fallback.W.pitchCountTrend),
      restPitcher: num(w.w_mlb_rest_pitcher, fallback.W.restPitcher),
      ballparkFactor: num(w.w_mlb_pitcher_ballpark_factor, fallback.W.ballparkFactor),
      weatherWind: num(w.w_mlb_pitcher_weather_wind, fallback.W.weatherWind),
      weatherTemp: num(w.w_mlb_pitcher_weather_temp, fallback.W.weatherTemp),
      umpireKZone: num(w.w_mlb_pitcher_umpire_k_zone, fallback.W.umpireKZone),
      pitcherCommandTrend: num(w.w_mlb_pitcher_command_trend, fallback.W.pitcherCommandTrend),
      pitcherVelocityTrend: num(w.w_mlb_pitcher_velocity_trend, fallback.W.pitcherVelocityTrend),
      lineupKComposition: num(w.w_mlb_lineup_k_composition, fallback.W.lineupKComposition),
      pitcherXeraEdge: num(w.w_mlb_pitcher_xera_edge, fallback.W.pitcherXeraEdge),
      pitcherBaa: num(w.w_mlb_pitcher_baa, fallback.W.pitcherBaa),
      catcherFraming: num(w.w_mlb_catcher_framing, fallback.W.catcherFraming),
      pitcherPitchMixK: num(w.w_mlb_pitcher_pitch_mix_k, fallback.W.pitcherPitchMixK),
      pitcherCsw: num(w.w_mlb_pitcher_csw, fallback.W.pitcherCsw),
      pitchTypeMatchup: num(w.w_mlb_pitch_type_matchup, fallback.W.pitchTypeMatchup),
      outsPitcherAvgIp: num(w.w_mlb_outs_pitcher_avg_ip, fallback.W.outsPitcherAvgIp),
      outsPitcherRecentIpTrend: num(w.w_mlb_outs_pitcher_recent_ip_trend, fallback.W.outsPitcherRecentIpTrend),
      outsPitcherVolatilityV2: num(w.w_mlb_outs_pitcher_volatility_v2, fallback.W.outsPitcherVolatilityV2),
      outsRestPitcher: num(w.w_mlb_outs_rest_pitcher, fallback.W.outsRestPitcher),
      outsPitcherWalkEfficiency: num(w.w_mlb_outs_pitcher_walk_efficiency, fallback.W.outsPitcherWalkEfficiency),
      outsPitcherRecentPitchCount: num(w.w_mlb_outs_pitcher_recent_pitch_count, fallback.W.outsPitcherRecentPitchCount),
      outsFirstInningTrouble: num(w.w_mlb_outs_first_inning_trouble, fallback.W.outsFirstInningTrouble),
      outsBullpenGameOrOpener: num(w.w_mlb_outs_bullpen_game_or_opener, fallback.W.outsBullpenGameOrOpener),
      outsOwnPenRest: num(w.w_mlb_outs_own_pen_rest, fallback.W.outsOwnPenRest),
      outsGameScriptRisk: num(w.w_mlb_outs_game_script_risk, fallback.W.outsGameScriptRisk),
      outsOppKRate: num(w.w_mlb_outs_opp_k_rate, fallback.W.outsOppKRate),
      outsOppObpPatience: num(w.w_mlb_outs_opp_obp_patience, fallback.W.outsOppObpPatience),
      outsOppWalkRate: num(w.w_mlb_outs_opp_walk_rate, fallback.W.outsOppWalkRate),
      outsOppPitchGrind: num(w.w_mlb_outs_opp_pitch_grind, fallback.W.outsOppPitchGrind),
      outsOppChaseRate: num(w.w_mlb_outs_opp_chase_rate, fallback.W.outsOppChaseRate),
      outsBallparkFactor: num(w.w_mlb_outs_ballpark_factor, fallback.W.outsBallparkFactor),
      outsWeatherTemp: num(w.w_mlb_outs_weather_temp, fallback.W.outsWeatherTemp),
      outsThirdTimeThrough: num(w.w_mlb_outs_third_time_through, fallback.W.outsThirdTimeThrough),
      outsPitchesPerIp: num(w.w_mlb_outs_pitches_per_ip, fallback.W.outsPitchesPerIp),
      outsManagerHook: num(w.w_mlb_outs_manager_hook, fallback.W.outsManagerHook),
    },
    W_BATTER: {
      hitRate: num(w.w_mlb_batter_hit_rate, fallback.W_BATTER.hitRate),
      form: num(w.w_mlb_batter_form, fallback.W_BATTER.form),
      pitcherQuality: num(w.w_mlb_batter_pitcher_quality, fallback.W_BATTER.pitcherQuality),
      recentAB: num(w.w_mlb_batter_recent_ab, fallback.W_BATTER.recentAB),
      handednessMatchup: num(w.w_mlb_batter_handedness_matchup, fallback.W_BATTER.handednessMatchup),
      ballparkHitsFactor: num(w.w_mlb_batter_ballpark_hits_factor, fallback.W_BATTER.ballparkHitsFactor),
      weatherTemp: num(w.w_mlb_batter_weather_temp, fallback.W_BATTER.weatherTemp),
      lineupConsistency: num(w.w_mlb_batter_lineup_consistency, fallback.W_BATTER.lineupConsistency),
      powerRate: num(w.w_mlb_batter_power_rate, fallback.W_BATTER.powerRate),
      formPower: num(w.w_mlb_batter_form_power, fallback.W_BATTER.formPower),
      pitcherHrRate: num(w.w_mlb_batter_pitcher_hr_rate, fallback.W_BATTER.pitcherHrRate),
      weatherWind: num(w.w_mlb_batter_weather_wind, fallback.W_BATTER.weatherWind),
      lineupSpot: num(w.w_mlb_lineup_spot, fallback.W_BATTER.lineupSpot),
      dayAfterNightFatigue: num(w.w_mlb_day_after_night_fatigue, fallback.W_BATTER.dayAfterNightFatigue),
      travelGetaway: num(w.w_mlb_travel_getaway, fallback.W_BATTER.travelGetaway),
      opposingPitcherBaaVsHand: num(w.w_mlb_pitcher_baa_vs_hand, fallback.W_BATTER.opposingPitcherBaaVsHand),
      hitterStreakFatigue: num(w.w_mlb_hitter_streak_fatigue, fallback.W_BATTER.hitterStreakFatigue),
      xba: num(w.w_mlb_batter_xba, fallback.W_BATTER.xba),
      exitVeloTrend: num(w.w_mlb_batter_exit_velo_trend, fallback.W_BATTER.exitVeloTrend),
      barrelRate: num(w.w_mlb_batter_barrel_rate, fallback.W_BATTER.barrelRate),
      xslgRegression: num(w.w_mlb_batter_xslg_regression, fallback.W_BATTER.xslgRegression),
      babip: num(w.w_mlb_batter_babip, fallback.W_BATTER.babip),
      vsPitcherHandSplit: num(w.w_mlb_batter_vs_pitcher_hand_split, fallback.W_BATTER.vsPitcherHandSplit),
      bullpenQuality: num(w.w_mlb_bullpen_quality, fallback.W_BATTER.bullpenQuality),
      windDirectionHr: num(w.w_mlb_wind_direction_hr, fallback.W_BATTER.windDirectionHr),
      pitcherHrPer9: num(w.w_mlb_pitcher_hr_per_9, fallback.W_BATTER.pitcherHrPer9),
      lineHitRate: num(w.w_mlb_batter_line_hit_rate, fallback.W_BATTER.lineHitRate),
      oppPitcherPitchTypeQuality: num(w.w_mlb_batter_opp_pitcher_pitchtype_quality, fallback.W_BATTER.oppPitcherPitchTypeQuality),
      xwoba: num(w.w_mlb_batter_xwoba, fallback.W_BATTER.xwoba),
      launchAngle: num(w.w_mlb_batter_launch_angle, fallback.W_BATTER.launchAngle),
      sweetSpot: num(w.w_mlb_batter_sweet_spot, fallback.W_BATTER.sweetSpot),
      hardHit: num(w.w_mlb_batter_hard_hit, fallback.W_BATTER.hardHit),
      pitcherHardContactAllowed: num(w.w_mlb_pitcher_hard_contact_allowed, fallback.W_BATTER.pitcherHardContactAllowed),
      lineupProtection: num(w.w_mlb_batter_lineup_protection, fallback.W_BATTER.lineupProtection),
      teamOffense: num(w.w_mlb_batter_team_offense, fallback.W_BATTER.teamOffense),
      sprintSpeed: num(w.w_mlb_batter_sprint_speed, fallback.W_BATTER.sprintSpeed),
      pullRate: num(w.w_mlb_batter_pull_rate, fallback.W_BATTER.pullRate),
      pullXParkFence: num(w.w_mlb_batter_pull_x_park_fence, fallback.W_BATTER.pullXParkFence),
      contactRate: num(w.w_mlb_batter_contact_rate, fallback.W_BATTER.contactRate),
    },
    W_GAME: {
      offenseDiff: num(w.w_mlb_game_offense_diff, fallback.W_GAME.offenseDiff),
      pitchingMatchup: num(w.w_mlb_game_pitching_matchup, fallback.W_GAME.pitchingMatchup),
      bullpenStrength: num(w.w_mlb_game_bullpen_strength, fallback.W_GAME.bullpenStrength),
      recentRunDiff: num(w.w_mlb_game_recent_run_diff, fallback.W_GAME.recentRunDiff),
      h2hRecent: num(w.w_mlb_game_h2h_recent, fallback.W_GAME.h2hRecent),
      teamForm: num(w.w_mlb_game_team_form, fallback.W_GAME.teamForm),
      ballpark: num(w.w_mlb_game_ballpark, fallback.W_GAME.ballpark),
      weatherWind: num(w.w_mlb_game_weather_wind, fallback.W_GAME.weatherWind),
      weatherTemp: num(w.w_mlb_game_weather_temp, fallback.W_GAME.weatherTemp),
      umpireKZone: num(w.w_mlb_game_umpire_k_zone, fallback.W_GAME.umpireKZone),
      lineupVsHand: num(w.w_mlb_lineup_vs_hand_split, fallback.W_GAME.lineupVsHand),
    },
  };
}

export async function loadMlbWeightsWithPerMarket(db: Db): Promise<{
  global: MlbScoringWeights;
  perMarket: Record<string, MlbScoringWeights>;
}> {
  const fallback = getMlbDefaultWeights();
  try {
    const rows = await db.query<Record<string, unknown>>(
      `SELECT * FROM algorithm_weights WHERE id = 1 LIMIT 1`,
    );
    if (rows.length === 0) {
      console.log("[harness/weights] No weights row found, using defaults");
      return { global: fallback, perMarket: applyOverrides(fallback, {}) };
    }
    const w = rows[0];
    const global = mapRowToWeights(w, fallback);
    let overrides: Record<string, Record<string, number>> = {};
    const raw = w.mlb_market_weight_overrides;
    if (raw && typeof raw === "object") {
      overrides = raw as Record<string, Record<string, number>>;
    }
    const perMarket = applyOverrides(global, overrides);
    const overrideKeys = Object.keys(overrides);
    console.log(
      `[harness/weights] Loaded from DB: pitcherKRate=${global.W.pitcherKRate} ` +
        `batterHitRate=${global.W_BATTER.hitRate}; per-market overrides: ` +
        `${overrideKeys.length} markets (${overrideKeys.join(",") || "none — all byte-identical to global"})`,
    );
    return { global, perMarket };
  } catch (err) {
    console.log(`[harness/weights] Load error: ${err} — using defaults`);
    return { global: fallback, perMarket: applyOverrides(fallback, {}) };
  }
}
