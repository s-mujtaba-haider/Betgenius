import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { etGameDateYmd } from "@/lib/etDate";
import { useAuthSession, currentUserId } from "@/lib/auth";
import { readStoredSport, type Sport } from "@/lib/sport";
import { SportSelector } from "@/components/SportSelector";
import { readBankroll, MAX_BET_PCT, kellyBreakdown, readKellyFraction } from "@/lib/kelly";
import { computeKellyAction, type KellyActionResult } from "@/lib/kelly_action";
import { readDiscretionaryStake } from "@/lib/user_preferences";
import { formatGameTime } from "@/lib/formatGameTime";
import { isMarketUnvalidated } from "@/lib/marketValidation";
import { getLineMovementCaption, getSharpMoneyBadge } from "@/lib/lineMovementDisplay";
import { FactorPanel } from "@/components/FactorPanel";

type AvailableBook = {
  bookmaker: string;
  line: number;
  odds: number;
  pick_side: string;
};

interface Recommendation {
  playerName: string;
  team: string;
  opponent: string;
  propType: string;
  // D-631 — used by isMarketUnvalidated() to drive the UNVALIDATED badge.
  mlbMarketType?: string | null;
  line: number;
  pickSide: "over" | "under" | "home" | "away";
  odds: number;
  confidence: number;
  verdict: string;
  hitRates: { l5: string; l10: string; season: string };
  gameTime: string;
  aiAnalysis?: string | null;
  breakdown?: Record<string, number>;
  teamStats?: { home: any; away: any; h2h?: { homeWins: number; awayWins: number } };
  scores?: Record<string, number | null>; // score_l5, score_l10, ... populated from recommendations_cache
  bookmaker?: string | null;
  availableBooks?: AvailableBook[] | null;
  // D-164 (May 14, 2026): TRUE when under-side odds exceed tier breakeven.
  unbettableJuiceFlag?: boolean;
  // D-165 (May 14, 2026): TRUE for same-player non-primary markets.
  isSecondaryMarket?: boolean;
  // D-166 (May 14, 2026): TRUE when Elite confidence with ~50% season WR.
  coinFlipFlag?: boolean;
  // D-167 (May 14, 2026): Failure Mode D — Elite + 3+ negative factors.
  negativeStackingFlag?: boolean;
  negativeFactorCount?: number;
  // M4 — production EV surface parity
  recommendationShown?: boolean;
  evPerUnit?: number | null;
  edgeVsImplied?: number | null;
  winProb?: number | null;
}

/** M4 — mirror production recommendation_shown with pre-migration fallback. */
function isRecommendationShownRow(row: Record<string, unknown>): boolean {
  if (row.recommendation_shown === true) return true;
  if (row.recommendation_shown === false) return false;
  const bd = (row.breakdown as Record<string, unknown> | undefined) ?? {};
  const ev = row.ev_per_unit ?? bd.d691_ev_per_unit;
  if (ev !== undefined && ev !== null && Number(ev) <= 0) return false;
  if (row.unbettable_juice_flag) return false;
  if (row.unbettable_over_breakeven_flag) return false;
  return Number(row.confidence ?? 0) >= 60;
}

// Display labels for each score_* column. Ordered by how the algorithm applies them.
const FACTOR_LABELS: { col: string; label: string }[] = [
  { col: "score_l5", label: "Last 5 games" },
  { col: "score_l10", label: "Last 10 games" },
  { col: "score_season", label: "Season hit rate" },
  { col: "score_floor_ceiling", label: "Floor & ceiling" },
  { col: "score_recent_form", label: "Recent form" },
  { col: "score_home_away", label: "Home / away" },
  { col: "score_rest", label: "Days of rest" },
  { col: "score_b2b", label: "Back-to-back" },
  { col: "score_minutes_trend", label: "Minutes trend" },
  { col: "score_pace", label: "Pace" },
  { col: "score_opp_defense", label: "Opp defense" },
  { col: "score_z_score", label: "Projection edge" },
  { col: "score_role_change", label: "Role change" },
  // §15.10 #8 audit (May 12, 2026): factor fires when projection within
  // 5% of line AND |zScore| < 0.5 — measures "no edge after vig", not
  // "high juice". Renamed display label to match what's actually
  // computed. DB column score_vig_filter unchanged for backward compat.
  { col: "score_vig_filter", label: "No edge" },
  { col: "score_usg_rate", label: "Usage rate" },
  { col: "score_regression", label: "Regression" },
  { col: "score_market_conf", label: "Market confirmation" },
  { col: "score_home_away_split", label: "H/A split" },
  { col: "score_minutes_floor", label: "Minutes floor" },
  { col: "score_consistency", label: "Consistency (low stdev)" },
  { col: "score_prop_type_penalty", label: "Prop type" },
  { col: "score_stale_data", label: "Stale data" },
  { col: "score_player_injury", label: "Player injury" },
  // D-150 (May 13, 2026): added 7 missing factor labels surfaced by
  // D-148 v2 Finding #5. These columns were already persisted to
  // pick_history but silently absent from the factor breakdown UI.
  // Includes today's D-136 / D-137 / D-139 factors — shipped May 13
  // but invisible to subscribers until this fix lands. Pipeline-
  // ordered after score_player_injury per scoreOneSide flow at
  // process-games:L2197-L2298. score_trivial_line_cap is BOOLEAN in
  // pick_history (the others are NUMERIC); display layer renders it
  // as 1/0 same as the others — caller treats truthy=cap-fired.
  { col: "score_low_min_risk", label: "Low minutes risk" },          // D-136 Tier 2 #7
  { col: "score_blowout_risk", label: "Blowout risk" },              // D-137 Tier 2 #6
  { col: "score_line_movement", label: "Line movement" },            // D-139 Tier 2 #5
  { col: "score_minutes_volume", label: "Minutes volume" },          // May 4 megadeploy decompose
  { col: "score_minutes_stability", label: "Minutes stability" },    // May 4 megadeploy decompose
  { col: "score_trivial_line_penalty", label: "Trivial line" },      // §15.10 #8 Option C
  { col: "score_trivial_line_cap", label: "Trivial line cap" },      // §15.10 #8 Option C — BOOLEAN; truthy = cap fired
  // D-337 (May 27, 2026): MLB factor labels. MLB picks store all factor
  // scores in the `breakdown` JSONB only (not as top-level columns like
  // NBA). The scores-object construction below (lines ~271 and ~438) was
  // patched to fall back to breakdown[col] when row[col] is null, so
  // adding these labels makes them surface in the factor breakdown UI.
  // Source key names from supabase/functions/_shared/scoring_mlb_v2.ts.
  // Pipeline ordering follows: batter signals → pitcher signals →
  // matchup / context signals → environmental signals.
  // -- batter market signals
  { col: "score_batter_hit_rate", label: "Batter hit rate" },
  { col: "score_batter_form", label: "Batter form" },
  { col: "score_batter_form_power", label: "Batter form (power)" },
  { col: "score_batter_power_rate", label: "Batter power rate" },
  { col: "score_batter_babip", label: "Batter BABIP" },
  { col: "score_batter_xba", label: "Batter xBA" },
  { col: "score_batter_barrel_rate", label: "Barrel rate" },
  { col: "score_batter_exit_velo_trend", label: "Exit velocity trend" },
  { col: "score_batter_xslg_regression", label: "xSLG regression" },
  { col: "score_batter_vs_pitcher_hand_split", label: "Batter vs hand" },
  { col: "score_recent_at_bats", label: "Recent at-bats" },
  // -- pitcher signals
  { col: "score_pitcher_form", label: "Pitcher form" },
  { col: "score_pitcher_k_rate", label: "Pitcher K rate" },
  { col: "score_pitcher_xera_edge", label: "Pitcher xERA edge" },
  { col: "score_pitcher_baa", label: "Pitcher BAA" },
  { col: "score_pitcher_hr_rate", label: "Pitcher HR rate" },
  { col: "score_pitcher_hr_per_9", label: "Pitcher HR/9" },
  { col: "score_pitcher_pitch_mix_k", label: "Pitch mix (K)" },
  { col: "score_pitch_count_trend", label: "Pitch count trend" },
  { col: "score_rest_pitcher", label: "Pitcher rest" },
  { col: "score_handedness_matchup", label: "Handedness matchup" },
  { col: "score_opposing_pitcher_quality", label: "Opposing pitcher quality" },
  // -- team / matchup signals
  { col: "score_team_form", label: "Team form (L10)" },
  { col: "score_recent_run_diff", label: "Recent run differential" },
  { col: "score_h2h_recent", label: "Head-to-head (L10)" },
  { col: "score_offense_differential", label: "Offense differential" },
  { col: "score_pitching_matchup", label: "Pitching matchup" },
  { col: "score_lineup_consistency", label: "Lineup consistency" },
  { col: "score_lineup_vs_hand_split", label: "Lineup vs hand" },
  { col: "score_opposing_lineup_k", label: "Opposing lineup K" },
  // -- bullpen / catcher signals
  { col: "score_bullpen_quality", label: "Bullpen quality" },
  { col: "score_bullpen_strength", label: "Bullpen strength" },
  { col: "score_catcher_framing", label: "Catcher framing" },
  // -- environmental signals
  { col: "score_ballpark_factor", label: "Ballpark factor" },
  { col: "score_weather_wind", label: "Weather (wind)" },
  { col: "score_weather_temp", label: "Weather (temp)" },
  { col: "score_wind_direction_hr", label: "Wind direction (HR)" },
  { col: "score_umpire_k_zone", label: "Umpire K-zone" },
  // D-347 — 3 new batter factors
  { col: "score_lineup_spot", label: "Lineup batting order" },
  { col: "score_day_after_night_fatigue", label: "Day-after-night fatigue" },
  { col: "score_travel_getaway", label: "Travel / getaway day" },
  // D-348 — pitcher command trend (BB/9 recent vs season)
  { col: "score_pitcher_command_trend", label: "Pitcher command trend" },
  // D-349 — pitcher velocity + BAA vs handedness
  { col: "score_pitcher_velocity_trend", label: "Pitcher velocity trend" },
  { col: "score_pitcher_baa_vs_hand", label: "Pitcher BAA vs hand" },
  // D-354 — hitter streak fatigue + lineup K composition
  { col: "score_hitter_streak_fatigue", label: "Hitter streak fatigue" },
  { col: "score_lineup_k_composition", label: "Lineup K composition" },
  // ===========================================================================
  // D-676 — labels for every rebuilt MLB factor that lands in pick_history.breakdown.
  // Pre-D-676 FACTOR_LABELS was a single 77-entry global list that omitted every
  // D-658/D-660/D-661/D-663/D-664/D-666/D-668/D-669/D-671 factor → real fired
  // factors rendered as "missing" on the dashboard card. D-676 adds the missing
  // labels AND introduces MARKET_FACTOR_COLS below so each market's card sees
  // ONLY its own factors.
  // ===========================================================================
  // D-666 pitcher_strikeouts new
  { col: "score_pitcher_whiff_skill_v2", label: "Whiff skill" },
  { col: "score_pitch_type_matchup", label: "Pitch-type matchup" },
  // D-668 / D-669 / D-671 pitcher_outs durability + opponent-burden + new D-669/671
  { col: "score_pitcher_avg_ip", label: "Avg IP/start" },
  { col: "score_pitcher_recent_ip_trend", label: "Recent IP/start trend" },
  { col: "score_pitcher_volatility_v2", label: "Pitcher volatility" },
  { col: "score_pitcher_walk_efficiency", label: "Walk efficiency (BB/9)" },
  { col: "score_pitcher_recent_pitch_count", label: "Recent pitch count" },
  { col: "score_first_inning_trouble", label: "First-inning trouble" },
  { col: "score_bullpen_game_or_opener", label: "Bullpen game / opener" },
  { col: "score_own_pen_rest", label: "Own pen rest (L48h)" },
  { col: "score_game_script_risk", label: "Game-script risk" },
  { col: "score_opp_k_rate", label: "Opp K rate" },
  { col: "score_opp_obp_patience", label: "Opp OBP / patience" },
  { col: "score_opp_walk_rate", label: "Opp walk rate" },
  { col: "score_opp_pitch_grind", label: "Opp pitches/PA grind" },
  { col: "score_opp_chase_rate", label: "Opp chase rate" },
  // D-658 batter_runs_scored newly-wired
  { col: "score_batter_obp", label: "Batter OBP" },
  { col: "score_recent_run_form", label: "Recent run form" },
  { col: "score_opp_pitcher_pitchtype_quality", label: "Opp pitcher pitch-type quality" },
  // D-660 batter rbis/hr/tb extras
  { col: "score_batter_line_hit_rate", label: "Batter line hit rate" },
  // D-661 batter HR-gated pitcher GB/FB
  { col: "score_pitcher_gb_fb_rate", label: "Pitcher GB/FB rate" },
  // D-635 line-movement / sharp-money / rlm wrapper-injected
  { col: "score_line_movement_v2", label: "Line movement (v2)" },
  { col: "score_rlm_signal", label: "RLM signal" },
  // D-652 v3 game_side / game_total replacements (v3)
  { col: "score_team_offense_form_v3", label: "Team offense form (v3)" },
  { col: "score_team_run_prevention_form_v3", label: "Team run-prevention form (v3)" },
  { col: "score_sp_statcast_quality_v3", label: "SP Statcast quality (v3)" },
  { col: "score_bullpen_quality_v3", label: "Bullpen quality (v3)" },
  { col: "score_team_defense_oaa_v3", label: "Team defense OAA (v3)" },
  { col: "score_park_runs_v3", label: "Park runs (v3)" },
  { col: "score_lineup_confirmation_v3", label: "Lineup confirmation (v3)" },
  { col: "score_line_movement_v3", label: "Line movement (v3)" },
  { col: "score_sharp_money_v3", label: "Sharp money (v3)" },
  { col: "score_rlm_signal_v3", label: "RLM signal (v3)" },
  { col: "score_steam_v3", label: "Steam (v3)" },
  // D-663 handicapper v3 spread factors
  { col: "score_pitcher_gb_fb_rate_v3", label: "Pitcher GB/FB (v3)" },
  { col: "score_team_ops_v3", label: "Team OPS (v3)" },
  { col: "score_sp_ip_depth_v3", label: "SP IP depth (v3)" },
  { col: "score_blowout_tendency_v3", label: "Blowout tendency (v3)" },
  { col: "score_team_travel_flat_v3", label: "Team travel flatness (v3)" },
  // D-664 dequeued v3 spread factors
  { col: "score_team_iso_v3", label: "Team ISO (v3)" },
  { col: "score_pen_rest_v3", label: "Pen rest (v3)" },
  { col: "score_bob_quality_v3", label: "Back-of-bullpen (v3)" },
  { col: "score_sp_last3_form_v3", label: "SP last-3 form (v3)" },
  { col: "score_lineup_depth_v3", label: "Lineup depth (v3)" },
  // Game-side v2 also present in some live breakdowns
  { col: "score_k_matchup_v2", label: "K matchup (v2)" },
  { col: "score_team_offense_strength_v2", label: "Team offense strength (v2)" },
];

// ===========================================================================
// D-676 — per-market score_* cols map.
//
// Pre-D-676 FactorPanel iterated ALL 77 FACTOR_LABELS against every pick,
// counting non-relevant labels (NBA on MLB picks, batter on pitcher picks,
// etc.) as "missing." This map narrows each market's card to ONLY its
// emitted cols so "missing" actually means "the scorer didn't emit this for
// this pick" rather than "this label belongs to another market."
//
// Cols derived from per-market live-pick scans (2026-06-21 slate) — the
// empirical truth of what each scorer writes to breakdown.
// ===========================================================================
// D-678 CURATION — removed dead/intentional-zero factors from each market's
// inventory so the dashboard panel shows only factors that ACTUALLY fire on
// real picks. Removals classified per cause:
//   (e) INTENTIONAL ZERO (D-636 discipline pending D-549 r_residual):
//       score_line_movement_v2 + score_rlm_signal removed from ALL markets.
//       score_line_movement_v3 + score_sharp_money_v3 + score_rlm_signal_v3
//       + score_steam_v3 removed from game_side + game_total.
//   (c) MARKET-GATED HARDCODED 0 — factor's scorer hardcodes 0 because the
//       signal doesn't apply to this market:
//       batter_hits: power factors removed (barrel_rate, exit_velo_trend,
//       xslg_regression, form_power, power_rate, pitcher_gb_fb_rate,
//       pitcher_hr_per_9, pitcher_hr_rate, travel_getaway, weather_wind,
//       wind_direction_hr).
//       batter_rbis: score_batter_hit_rate, score_batter_form removed
//       (hardcoded 0 — rbis is power/situation, not hit-rate); travel_getaway,
//       wind_direction_hr removed (HR-only).
//       batter_hr: score_batter_hit_rate, score_batter_form, score_batter_babip,
//       score_batter_xba removed (contact factors hardcoded 0 on HR market);
//       travel_getaway removed.
//       batter_total_bases: same as rbis pattern (score_batter_hit_rate +
//       score_batter_form removed); travel_getaway + wind_direction_hr removed.
//       game_side: score_offense_differential removed (DB weight 0 per D-339);
//       score_ballpark_factor + score_weather_wind + score_weather_temp +
//       score_umpire_k_zone removed (factor body gated to totals-market only
//       per scoreGameMarket — fires 0 on side); score_team_travel_flat_v3
//       removed (rarely fires + sample dead).
//   STARVED-but-keep — factors at 1-25% nonzero are KEPT (they fire by design
//   only on extreme conditions / rare bins; the audit confirmed they CAN fire,
//   just not on most picks). Post-D-668 pitcher_outs starvation will self-heal
//   as post-deploy cohort dominates.
//
// Each removed factor is documented with cause + scorer line so we know WHY
// it was excluded. The standing health monitor (D-678 SHIP 5 RPC
// mlb_market_factor_health_24h) catches any factor in this map that drops to
// 0% over a 24h window so future regressions are visible immediately.
export const MARKET_FACTOR_COLS: Record<string, ReadonlyArray<string>> = {
  pitcher_outs: [
    "score_pitcher_avg_ip", "score_pitcher_recent_ip_trend", "score_pitcher_volatility_v2",
    "score_rest_pitcher", "score_pitcher_walk_efficiency", "score_pitcher_recent_pitch_count",
    "score_first_inning_trouble", "score_bullpen_game_or_opener", "score_own_pen_rest",
    "score_game_script_risk", "score_opp_k_rate", "score_opp_obp_patience",
    "score_opp_walk_rate", "score_opp_pitch_grind", "score_opp_chase_rate",
    "score_ballpark_factor", "score_weather_temp",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-689 RESTORED — gates widened in scoring_mlb_v2.ts (see d689 doc).
  ],
  pitcher_k: [
    // D-744 SHADOW_HELD (temporal-drift parity gap per D-740; still scored at current weights)
    "score_pitcher_k_rate", "score_pitcher_form",
    // D-744 EXCL_OTHER (not in D-742 fit; held at current weights)
    "score_opposing_lineup_k",
    // D-744 TUNED — D-742 OOS-fit non-zero weights
    "score_pitch_count_trend", "score_rest_pitcher",
    "score_ballpark_factor", "score_weather_temp",
    "score_pitcher_velocity_trend",
    // D-746 RESTORED — CEO logic-based weights (was D-745-hidden because D-744 set them to 0;
    // CEO decided handedness + umpire are real K drivers, xera/baa/framing secondary signals).
    // Weights now: handedness=0.5, umpire=0.5, xera=0.25, baa=0.25, framing=0.25.
    "score_handedness_matchup", "score_umpire_k_zone",
    "score_pitcher_xera_edge", "score_pitcher_baa", "score_catcher_framing",
    // D-744 EXCL_OTHER (still scored)
    "score_pitcher_command_trend", "score_lineup_k_composition",
    "score_pitch_type_matchup", "score_pitcher_pitch_mix_k", "score_pitcher_whiff_skill_v2",
    //
    // Prior removals preserved here for audit trail:
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-678 second-pass REMOVED (b) score_weather_wind (24h RPC 0% — bucket too tight).
    //   NOTE: D-744 RE-TUNED w_mlb_pitcher_weather_wind to -0.19 (TUNED); whether to
    //   add back to display is a follow-up CEO decision (not D-746 scope).
    // D-689 RESTORED weather_temp + umpire_k_zone (gates widened in scoring_mlb_v2.ts).
    // D-745 hid the 5 RESTORE_CANDIDATEs (D-744 zeros); D-746 restored both DB weights
    //   and display per CEO logic-based restore.
  ],
  batter_runs_scored: [
    // D-794 audit: dashboard reads MLB factor values from breakdown JSONB
    // (recommendations_cache lacks dedicated MLB factor columns; the lookup
    // in Dashboard.tsx line ~671 tries top-level then falls back to bd[col]).
    // Breakdown keys for runs_scored carry the `score_batter_*` prefix even
    // for fields whose pick_history column name doesn't (recent_at_bats →
    // bd.score_batter_recent_at_bats), so the config below uses breakdown
    // key names — NOT pick_history column names. D-794 fixed the SCORER's
    // return values to expose 5 dark-by-bug factors at pick_history top-level
    // for the OPTIMIZER; the dashboard read path is unchanged and the labels
    // below remain the same as pre-D-794.
    "score_batter_hit_rate", "score_batter_form", "score_batter_form_power",
    "score_batter_power_rate", "score_batter_babip", "score_batter_xba",
    "score_batter_barrel_rate", "score_batter_exit_velo_trend", "score_batter_xslg_regression",
    "score_batter_vs_pitcher_hand_split", "score_batter_recent_at_bats",
    "score_recent_run_form", "score_batter_obp",
    "score_opp_pitcher_pitchtype_quality", "score_opposing_pitcher_quality",
    "score_bullpen_quality", "score_ballpark_factor", "score_lineup_spot",
    // D-806 — 5 newly-wired runs_scored factors now displayed on the card.
    // The D-806 PART 3 audit found these were wired in scoring + persisting
    // in breakdown JSONB but NOT in the display config → user-invisible.
    "score_batter_xwoba", "score_batter_hard_hit",
    "score_pitcher_hard_contact_allowed", "score_pitcher_gb_fb_rate",
    "score_weather_temp",
    // D-807 — 2 high-value runs-specific factors. Lineup protection (avg OPS
    // of next 2 hitters batting behind) closes the D-806 PART 1 #1 missing
    // signal. Team offense (batter team OPS season) closes #3 — data already
    // existed in TeamSeasonContext but wasn't propagated to BatterScoringContext.
    "score_batter_lineup_protection", "score_batter_team_offense",
    // D-808 — full-stack completion: 8 deferred D-806 factors + sprint speed.
    // launch_angle + sweet_spot are extra-base quality contact signals; line_hit_rate
    // is the D-517 recent-line penalty; pitcher_baa_vs_hand is the handedness
    // matchup; hitter_streak_fatigue + day_after_night + travel_getaway are
    // fatigue signals; lineup_consistency is role stability; sprint_speed is
    // the baserunning signal (closes D-806 PART 1 #4 missing signal).
    "score_batter_launch_angle", "score_batter_sweet_spot",
    "score_batter_line_hit_rate", "score_pitcher_baa_vs_hand",
    "score_hitter_streak_fatigue", "score_lineup_consistency",
    "score_day_after_night_fatigue", "score_travel_getaway",
    "score_batter_sprint_speed",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-689 RESTORED form/form_power/babip (gates widened)
  ],
  batter_rbis: [
    // D-678 REMOVED (c) market-gated hardcoded 0: score_batter_hit_rate,
    // score_batter_form, score_travel_getaway, score_wind_direction_hr
    // D-678 second-pass REMOVED (c): score_pitcher_gb_fb_rate +
    // score_pitcher_hr_per_9 (24h RPC showed 0% on n=287 — HR-only factors)
    "score_batter_form_power",
    "score_batter_power_rate", "score_batter_babip", "score_batter_xba",
    "score_batter_barrel_rate", "score_batter_exit_velo_trend", "score_batter_xslg_regression",
    "score_batter_vs_pitcher_hand_split", "score_recent_at_bats",
    "score_batter_line_hit_rate", "score_opp_pitcher_pitchtype_quality",
    "score_opposing_pitcher_quality", "score_pitcher_baa_vs_hand",
    "score_pitcher_hr_rate",
    "score_handedness_matchup", "score_lineup_consistency", "score_lineup_spot",
    "score_bullpen_quality", "score_hitter_streak_fatigue",
    "score_day_after_night_fatigue",
    "score_ballpark_factor", "score_weather_wind", "score_weather_temp",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-689 RESTORED form_power/babip/handedness/day_after_night/weather_wind
  ],
  batter_hr: [
    // D-678 REMOVED (c) contact factors hardcoded 0 on HR-power market:
    // score_batter_hit_rate, score_batter_form, score_batter_babip,
    // score_batter_xba, score_travel_getaway
    "score_batter_form_power",
    "score_batter_power_rate",
    "score_batter_barrel_rate", "score_batter_exit_velo_trend", "score_batter_xslg_regression",
    "score_batter_vs_pitcher_hand_split", "score_recent_at_bats",
    "score_batter_line_hit_rate", "score_opp_pitcher_pitchtype_quality",
    "score_opposing_pitcher_quality", "score_pitcher_baa_vs_hand",
    "score_pitcher_gb_fb_rate", "score_pitcher_hr_per_9", "score_pitcher_hr_rate",
    "score_handedness_matchup", "score_lineup_consistency", "score_lineup_spot",
    "score_bullpen_quality", "score_hitter_streak_fatigue",
    "score_day_after_night_fatigue",
    "score_ballpark_factor", "score_weather_wind", "score_weather_temp",
    "score_wind_direction_hr",
    // D-816 — Close D-811 PART 3 finding: 5 D-797/D-803 cards that fire on
    // HR but were never in display config + new D-816 pull_rate card.
    // xwoba (post-D-815 ungate), launch_angle, sweet_spot, hard_hit, and
    // pitcher_hard_contact_allowed fire 16-96% on HR per D-811 audit; pull_rate
    // is the new D-816 HR-only factor (Baseball Savant batted-ball direction).
    "score_batter_xwoba", "score_batter_launch_angle", "score_batter_sweet_spot",
    "score_batter_hard_hit", "score_pitcher_hard_contact_allowed",
    "score_batter_pull_rate",
    // D-817 — pull × pull-side fence (directional park amplifier on pull_rate).
    "score_batter_pull_x_park_fence",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-689 RESTORED form_power/line_hit_rate/handedness/day_after_night/weather_wind/wind_direction_hr
  ],
  batter_total_bases: [
    // D-678 REMOVED (c) hit_rate + batter_form hardcoded 0 on tb;
    // travel_getaway + wind_direction_hr HR-only
    "score_batter_form_power",
    "score_batter_power_rate", "score_batter_babip", "score_batter_xba",
    "score_batter_barrel_rate", "score_batter_exit_velo_trend", "score_batter_xslg_regression",
    "score_batter_vs_pitcher_hand_split", "score_recent_at_bats",
    "score_batter_line_hit_rate", "score_opp_pitcher_pitchtype_quality",
    "score_opposing_pitcher_quality", "score_pitcher_baa_vs_hand",
    "score_pitcher_hr_rate",
    "score_handedness_matchup", "score_lineup_consistency", "score_lineup_spot",
    "score_bullpen_quality", "score_hitter_streak_fatigue",
    "score_day_after_night_fatigue",
    "score_ballpark_factor", "score_weather_wind", "score_weather_temp",
    // D-806 — D-797/D-803 factors now displayed on TB cards. Audit found
    // these were wired in scoring + persisting in breakdown but NOT in the
    // display config → user-invisible. Adds 6 factor cards to TB picks.
    "score_batter_xwoba", "score_batter_launch_angle", "score_batter_sweet_spot",
    "score_batter_hard_hit",
    "score_pitcher_hard_contact_allowed", "score_pitcher_gb_fb_rate",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-689 RESTORED babip/handedness/day_after_night/weather_wind
  ],
  batter_hits: [
    // D-678 REMOVED (c) power factors hardcoded 0 on contact-hits market:
    // score_batter_form_power, score_batter_power_rate, score_batter_barrel_rate,
    // score_batter_exit_velo_trend, score_batter_xslg_regression,
    // score_pitcher_gb_fb_rate, score_pitcher_hr_per_9, score_pitcher_hr_rate,
    // score_travel_getaway, score_weather_wind, score_wind_direction_hr
    "score_batter_hit_rate", "score_batter_form",
    "score_batter_babip", "score_batter_xba",
    "score_batter_vs_pitcher_hand_split", "score_recent_at_bats",
    "score_batter_line_hit_rate", "score_opp_pitcher_pitchtype_quality",
    "score_opposing_pitcher_quality", "score_pitcher_baa_vs_hand",
    "score_handedness_matchup", "score_lineup_consistency", "score_lineup_spot",
    "score_bullpen_quality", "score_hitter_streak_fatigue",
    "score_day_after_night_fatigue",
    "score_ballpark_factor", "score_weather_temp",
    // D-823 — close D-822 wired-but-not-displayed finding: xwoba fires 16/20 nz
    // on hits (D-797 gate includes "hits") but no card. Plus the 2 new D-823
    // ungates (hard_hit + pitcher_hard_contact_allowed for hits market).
    "score_batter_xwoba",
    "score_batter_hard_hit",
    "score_pitcher_hard_contact_allowed",
    // D-824 — hits-specific contact-rate / whiff-rate discriminator (the
    // "pull_rate equivalent" for hits). Sourced from Baseball Savant
    // plate-discipline leaderboard. High contact → favor OVER, high whiff → UNDER.
    "score_batter_contact_rate",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-689 RESTORED form/babip/handedness/day_after_night
  ],
  // D-689 RESTORED batter_strikeouts entirely — D-684 marked dormant, D-689
  // CEO §19.3 calls for restore + investigate why market produces 0 picks
  // (see d689 doc §SHIP 3 for investigation findings).
  batter_strikeouts: [
    "score_batter_hit_rate", "score_batter_form", "score_batter_form_power",
    "score_batter_babip", "score_batter_xba", "score_batter_vs_pitcher_hand_split",
    "score_recent_at_bats", "score_opposing_pitcher_quality",
    "score_ballpark_factor", "score_weather_temp",
  ],
  game_side: [
    "score_team_offense_form_v3", "score_team_run_prevention_form_v3",
    "score_sp_statcast_quality_v3", "score_bullpen_quality_v3", "score_team_defense_oaa_v3",
    "score_park_runs_v3", "score_lineup_confirmation_v3",
    // D-678 REMOVED (e) intentional 0 (D-636): score_line_movement_v3,
    // score_sharp_money_v3, score_rlm_signal_v3, score_steam_v3
    "score_pitcher_gb_fb_rate_v3", "score_team_ops_v3", "score_sp_ip_depth_v3",
    "score_blowout_tendency_v3",
    // D-678 REMOVED (c) team_travel_flat_v3 (rarely fires; sample 0% across 200 picks)
    "score_team_iso_v3", "score_pen_rest_v3", "score_bob_quality_v3",
    "score_sp_last3_form_v3", "score_lineup_depth_v3",
    "score_pitching_matchup", "score_lineup_vs_hand_split", "score_h2h_recent",
    // D-678 REMOVED (c) offense_differential (DB weight 0 per D-339);
    // ballpark_factor + weather_wind + weather_temp + umpire_k_zone gated to
    // totals-market only in scoreGameMarket — fire 0 on side
    "score_team_form", "score_recent_run_diff",
    "score_bullpen_strength",
    "score_team_offense_strength_v2",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-678 second-pass REMOVED (c) score_k_matchup_v2 (24h RPC 0% nonzero on
    // n=68 — K-matchup signal scored but hardcoded 0 on side market; lives
    // in scoring_mlb_v2 game_total branch only)
    // D-689 RESTORED lineup_confirmation_v3 (D-683b cron back; accumulating data),
    // pen_rest_v3 (D-689 SHIP 1B un-paused fetch-mlb-pitcher-pen-extras-daily cron),
    // h2h_recent (D-689 SHIP 1B un-paused refresh-historical-outcomes-mlb-daily)
  ],
  game_total: [
    "score_team_offense_form_v3", "score_team_run_prevention_form_v3",
    "score_sp_statcast_quality_v3", "score_bullpen_quality_v3", "score_team_defense_oaa_v3",
    "score_park_runs_v3", "score_lineup_confirmation_v3",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v3, score_sharp_money_v3,
    // score_rlm_signal_v3, score_steam_v3
    "score_pitcher_gb_fb_rate_v3", "score_team_ops_v3", "score_sp_ip_depth_v3",
    "score_blowout_tendency_v3",
    // D-678 REMOVED (c) team_travel_flat_v3 (rarely fires; sample 0% across 200 picks)
    "score_team_iso_v3", "score_pen_rest_v3", "score_bob_quality_v3",
    "score_sp_last3_form_v3", "score_lineup_depth_v3",
    "score_pitching_matchup", "score_lineup_vs_hand_split", "score_h2h_recent",
    // D-678 REMOVED (c) offense_differential (DB weight 0)
    "score_team_form", "score_recent_run_diff",
    "score_bullpen_strength", "score_ballpark_factor",
    "score_weather_wind", "score_weather_temp",
    "score_k_matchup_v2", "score_team_offense_strength_v2",
    // D-678 REMOVED (e) intentional 0: score_line_movement_v2, score_rlm_signal
    // D-678 second-pass REMOVED (b) score_umpire_k_zone (24h RPC 0% nonzero on
    // n=37 — bucket gate ±0.03 k_zone idx fires only on rare umps)
    // D-689 RESTORED team_form/weather_wind/weather_temp (gates widened)
  ],
};

// ===========================================================================
// D-676 — labelsForMarket helper. Returns the subset of FACTOR_LABELS whose
// cols are in MARKET_FACTOR_COLS[market]. Falls back to ALL labels (legacy
// behavior) for NBA picks or any market not in the map.
// ===========================================================================
export function labelsForMarket(
  market: string | null | undefined,
): { col: string; label: string }[] {
  if (!market) return FACTOR_LABELS;
  const cols = MARKET_FACTOR_COLS[market];
  if (!cols) return FACTOR_LABELS;
  const colSet = new Set<string>(cols);
  return FACTOR_LABELS.filter((l) => colSet.has(l.col));
}

interface RecommendationsResponse {
  success: boolean;
  generatedAt: string;
  gamesAnalyzed: number;
  propsAnalyzed: number;
  recommendations: Recommendation[];
  message?: string;
  error?: string;
}

interface LiveGame {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  homeScore: number | null;
  awayScore: number | null;
  status: "In Progress" | "Final" | "Scheduled";
}

interface LiveGamesResponse {
  success: boolean;
  games: LiveGame[];
  fetchedAt?: string;
}

const cacheKeyFor = (sport: Sport) => `betgenius_recommendations_${sport}`;

interface CachedData {
  data: RecommendationsResponse;
  timestamp: number;
}

export default function Dashboard() {
  const { session, isAdmin } = useAuthSession();
  // D-350 — non-admin (friend preview) users get read-only mode on expensive/destructive actions.
  const readOnly = !isAdmin;
  const readOnlyTip = "Preview mode — full access requires subscription";
  const userId = currentUserId(session);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RecommendationsResponse | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [loggingAll, setLoggingAll] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [liveGames, setLiveGames] = useState<LiveGame[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  // Selected sport (D-040 — sport selector now lives on Dashboard + Games as
  // a peer to the date toggle, not in Settings). Filters recommendations_cache
  // queries by sport so MLB doesn't surface on the NBA tab and vice versa.
  // SportSelector self-handles localStorage persistence; storage event
  // listener below covers cross-tab sync.
  const [sport, setSport] = useState<Sport>(() => readStoredSport());
  useEffect(() => {
    function handler(e: StorageEvent) {
      if (e.key !== "betgenius_user_sport" || e.newValue == null) return;
      setSport(e.newValue === "mlb" ? "mlb" : "nba");
    }
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // Sportsbooks the user has accounts at. Default Hard Rock Bet only. Settings
  // page (1abff58) writes to localStorage; we read on mount + listen for cross-
  // tab changes via the 'storage' event. Same-tab Dashboard re-mounts on nav
  // so its useState initializer picks up fresh values without explicit sync.
  const [userBooks, setUserBooks] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("betgenius_user_books");
      const arr = stored ? JSON.parse(stored) : null;
      return Array.isArray(arr) && arr.length > 0 ? arr : ["hardrockbet"];
    } catch { return ["hardrockbet"]; }
  });
  useEffect(() => {
    function handler(e: StorageEvent) {
      if (e.key !== "betgenius_user_books" || e.newValue == null) return;
      try {
        const arr = JSON.parse(e.newValue);
        if (Array.isArray(arr) && arr.length > 0) setUserBooks(arr);
      } catch { /* ignore malformed */ }
    }
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);
  const [loggedPicks, setLoggedPicks] = useState<Set<string>>(new Set());
  const [confidenceFilter, setConfidenceFilter] = useState<number>(60); // Default: show all 60+
  // §15.10 Critical #1 Phase 2 (May 12, 2026, CEO §19.3): top-level view mode.
  // 'kelly' is the default — only picks where computeKellyAction returns 'BET'.
  // 'all' surfaces every recommendation with the existing tier sub-filters.
  const [viewMode, setViewMode] = useState<"kelly" | "all">("kelly");

  // Mount-time hydration of loggedPicks from the bets table — last 24h of
  // bets for the placeholder user. Without this, loggedPicks resets on every
  // page refresh and "Log Bet" buttons render as if nothing was logged,
  // letting the user double-log if they click before checkDuplicateBet
  // returns. Re-runs whenever `data` changes (date toggle) so the matched
  // set covers the right slate.
  useEffect(() => {
    let cancelled = false;
    async function hydrateLoggedPicks() {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: bets, error } = await supabase
        .from("bets")
        .select("player_name,prop_type,line")
        .eq("user_id", userId)
        .gte("placed_at", since24h);
      if (error || !bets || cancelled) return;
      const keys = new Set<string>();
      for (const b of bets) {
        keys.add(`${b.player_name}-${b.prop_type}-${b.line}`);
      }
      // Replace, don't merge — keys outside the 24h window shouldn't linger.
      setLoggedPicks(keys);
    }
    hydrateLoggedPicks();
    return () => { cancelled = true; };
  }, [data]);
  const [gameFilter, setGameFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("time"); // "time" or "confidence"
  const [dateOffset, setDateOffset] = useState<number>(0); // 0=today, 1=tomorrow
  // D-165 (May 14, 2026): show only highest-confidence pick per (player, game_date)
  // by default. Toggle on to surface secondary markets.
  const [showSecondaryMarkets, setShowSecondaryMarkets] = useState<boolean>(false);
  const [cronProgress, setCronProgress] = useState<string | null>(null);

  // Fetch picks from recommendations_cache (populated by process-games cron)
  async function fetchFromCache(offset?: number) {
    const d = offset ?? dateOffset;
    try {
      // D-162: DST-safe ET game-date via shared helper. Pre-D-162 used raw -4h.
      const gameDate = etGameDateYmd(d);

      // D-214 Fix 6 — cron_progress is NBA-only orchestration today (per
      // D-213 finding: process-games-mlb has no game-level orchestration
      // writes). When sport=mlb, hide the counter rather than showing
      // stale NBA orchestration progress on the MLB tab.
      let total = 0;
      if (sport === "nba") {
        const { data: progressData } = await supabase
          .from("cron_progress")
          .select("*")
          .eq("game_date", gameDate);
        const completed = (progressData || []).filter((r: any) => r.status === "complete").length;
        total = (progressData || []).length;
        if (total > 0) {
          setCronProgress(completed + "/" + total + " games processed");
        } else {
          setCronProgress(null);
        }
      } else {
        // MLB tab: no per-game orchestration counter available yet.
        setCronProgress(null);
      }

      // Fetch ALL player props for the day (no confidence filter) — propsAnalyzed
      // reflects the full set scored by the algorithm. The conf>=60 filter is
      // applied below when building the visible recommendations array.
      // D-631 — read from base recommendations_cache (not the _sellable view).
      // The hide-via-sellable filter was based on -EV measured on broken
      // inputs (D-630 fixed weather 48%/Statcast 28% missing); the UI now
      // shows ALL scored markets and tags the unvalidated ones with a badge.
      // Removal-TODO of per-market UNVALIDATED tags tracked in framework §15
      // and gated on D-630b re-measurement.
      const { data: allPlayerProps, error: cacheError } = await supabase
        .from("recommendations_cache")
        .select("*")
        .eq("game_date", gameDate)
        .eq("sport", sport)
        .not("prop_type", "in", '("spread","game_total","h2h","spreads","totals")')
        .order("confidence", { ascending: false });

      // D-051: Game picks (spread + game_total) removed from Dashboard. Games
      // page (D-027) owns the spread/total view. Player props only here.
      if (cacheError || !allPlayerProps || allPlayerProps.length === 0) return false;

      // D-165: filter out secondary markets unless toggle is on. Done on the
      // raw rows so propsAnalyzed still counts the un-filtered universe.
      const playerPropsHigh = (allPlayerProps || []).filter((r: any) =>
        isRecommendationShownRow(r) &&
        (showSecondaryMarkets || !r.is_secondary_market)
      );

      const recs: Recommendation[] = playerPropsHigh.map((row: any) => {
        const scores: Record<string, number | null> = {};
        // D-337: top-level scores for NBA; fall back to breakdown JSONB for
        // MLB (which only stores factor scores inside `breakdown`, not as
        // top-level columns). Pre-D-337, MLB picks rendered "1 firing" because
        // FACTOR_LABELS keys were all null at top level.
        const bd = (row as any).breakdown || {};
        for (const { col } of FACTOR_LABELS) {
          const top = (row as any)[col];
          scores[col] = (top !== null && top !== undefined) ? top : (bd[col] ?? null);
        }
        return {
          playerName: row.player_name,
          team: row.team || "",
          opponent: row.opponent || "",
          propType: row.prop_type || "",
          // D-631 — surface mlb_market_type for the UNVALIDATED badge classifier.
          mlbMarketType: (row as any).mlb_market_type ?? null,
          line: row.line,
          pickSide: row.pick_side || "over",
          odds: row.odds || -110,
          confidence: row.confidence,
          verdict: row.verdict || "",
          hitRates: row.hit_rates_display || { l5: "N/A", l10: "N/A", season: "N/A" },
          gameTime: row.game_time || "",
          aiAnalysis: row.ai_analysis,
          breakdown: row.breakdown || {},
          scores,
          bookmaker: row.bookmaker ?? null,
          availableBooks: row.available_books ?? null,
          // D-164: unbettable juice flag — surface in UI warning indicator.
          unbettableJuiceFlag: row.unbettable_juice_flag ?? false,
          // D-165: same-player non-primary market — filtered by default.
          isSecondaryMarket: row.is_secondary_market ?? false,
          // D-166: coin-flip sanity flag — surface in UI indicator.
          coinFlipFlag: row.coin_flip_flag ?? false,
          // D-167: negative-factor stacking flag + raw count.
          negativeStackingFlag: row.negative_stacking_flag ?? false,
          negativeFactorCount: row.negative_factor_count ?? 0,
          recommendationShown: row.recommendation_shown ?? undefined,
          evPerUnit: row.ev_per_unit ?? bd.d691_ev_per_unit ?? null,
          edgeVsImplied: row.edge_vs_implied ?? bd.d691_edge_vs_implied ?? null,
          winProb: row.win_prob ?? bd.d691_win_prob ?? null,
        };
      });

      // D-236 — sport-aware games count. NBA uses cron_progress per-game
      // orchestration (already in `total`). MLB has no equivalent table,
      // so derive distinct game count from the recs_cache rows we just
      // loaded — every row carries game_id, so a Set of those = unique
      // games for the slate.
      // D-270-H1 (2026-05-19) — NBA fallback: when cron_progress hasn't been
      // seeded yet for this game_date (e.g. very early in the cron window, or
      // when rec_cache was populated by a re-run while cron_progress is
      // pending cleanup), the counter would render "Games Today: 0" while
      // picks are clearly visible (D-268 H1). Derive from distinct game_id
      // the same way MLB does whenever cron_progress.total = 0. Source of
      // truth for the "X/Y games processed" badge text remains cron_progress.
      const nbaDistinctGames = new Set((allPlayerProps || []).map((r: any) => r.game_id).filter(Boolean)).size;
      const gamesCount = sport === "mlb"
        ? nbaDistinctGames
        : (total > 0 ? total : nbaDistinctGames);

      const cacheResponse: RecommendationsResponse = {
        success: true,
        generatedAt: new Date().toISOString(),
        gamesAnalyzed: gamesCount,
        propsAnalyzed: (allPlayerProps || []).length,
        recommendations: recs,
      };

      setData(cacheResponse);
      setCachedAt(Date.now());
      return true;
    } catch (err) {
      console.error("[cache] Error fetching from cache:", err);
      return false;
    }
  }

  // Load from recommendations_cache on mount, fall back to localStorage.
  // Gated on session.access_token: post-RLS (D-041), unauthenticated reads of
  // recommendations_cache return 0 rows, so firing this effect before
  // useAuthSession resolves leaves Dashboard stuck on "Ready to Analyze".
  // Mirrors the Admin race fix (D-045).
  useEffect(() => {
    if (!session?.access_token) return;
    // Reset on sport / session change so a sport with no rows doesn't render
    // the previous sport's stale picks (D-049). fetchFromCache repopulates
    // when rows exist; otherwise the empty state renders correctly.
    setData(null);
    setCachedAt(null);
    async function loadOnMount() {
      const loaded = await fetchFromCache();
      if (!loaded) {
        // Fall back to localStorage cache
        try {
          const cached = localStorage.getItem(cacheKeyFor(sport));
          // Migration fallback: pre-D-046 the localStorage key was sport-agnostic
          // ("betgenius_recommendations"). Existing users have stale-but-same-day
          // NBA data under the legacy key. Read it as a one-time fallback so the
          // first reload after deploy doesn't show empty state.
          const legacyCached = !cached && sport === "nba"
            ? localStorage.getItem("betgenius_recommendations")
            : null;
          const cacheToUse = cached ?? legacyCached;
          if (cacheToUse) {
            const parsed = JSON.parse(cacheToUse) as CachedData;
            const today = new Date().toDateString();
            const cacheDay = new Date(parsed.timestamp).toDateString();
            if (today === cacheDay) {
              setData(parsed.data);
              setCachedAt(parsed.timestamp);
            }
          }
        } catch {
          // Ignore cache errors
        }
      }
      // D-353 — gate auto-mount fetchLiveGames behind readOnly check.
      // Closes the D-350 gap: button-click was gated but useEffect mount fired the
      // get-live-games edge function (Odds API credit burn) on every non-admin load.
      if (!readOnly) fetchLiveGames();
    }
    loadOnMount();

    // Auto-refresh from cache every 5 minutes
    const interval = setInterval(() => { fetchFromCache(); }, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport, session?.access_token]);

  // Refresh path: reads recommendations_cache directly (populated by the
  // process-games cron). Same query shape as fetchFromCache but parameterized
  // by offset and surfaces loading/error state to the buttons.
  async function fetchRecommendations(overrideDateOffset?: number) {
    const offset = overrideDateOffset ?? dateOffset;
    setLoading(true);
    setError(null);

    try {
      // Resolve target game_date in ET (matches fetchFromCache convention).
      // D-162: DST-safe ET game-date via shared helper.
      const gameDate = etGameDateYmd(offset);

      // Refresh cron progress badge.
      const { data: progressData } = await supabase
        .from("cron_progress")
        .select("*")
        .eq("game_date", gameDate);
      const completed = (progressData || []).filter((r: any) => r.status === "complete").length;
      const totalCronGames = (progressData || []).length;
      setCronProgress(totalCronGames > 0 ? completed + "/" + totalCronGames + " games processed" : null);

      // All player props (no confidence filter) so propsAnalyzed reflects the
      // full scored set. The conf>=60 cut is applied below for the cards.
      // D-631 — read base table (not _sellable). All markets surface; the
      // unvalidated ones get an UNVALIDATED badge on the card. See note
      // above at the first fetch + framework §15 D-631.
      const { data: allPlayerProps, error: cacheError } = await supabase
        .from("recommendations_cache")
        .select("*")
        .eq("game_date", gameDate)
        .eq("sport", sport)
        .not("prop_type", "in", '("spread","game_total","h2h","spreads","totals")')
        .order("confidence", { ascending: false });

      if (cacheError) {
        setError(cacheError.message || "Failed to read recommendations_cache");
        return;
      }

      // D-051: Game picks (spread + game_total) removed from Dashboard. Games
      // page (D-027) owns the spread/total view. Player props only here.
      const allPlayerPropsArr = allPlayerProps || [];
      // D-165: same filter as the cache-fast-path above.
      const playerPropsHigh = allPlayerPropsArr.filter((r: any) =>
        isRecommendationShownRow(r) &&
        (showSecondaryMarkets || !r.is_secondary_market)
      );

      if (allPlayerPropsArr.length === 0) {
        const label = offset === 0 ? "today" : offset === 1 ? "tomorrow" : "+" + offset + "d";
        setError("No cached picks for " + label + ". The cron may still be processing — check back in a few minutes.");
        return;
      }

      const recs: Recommendation[] = playerPropsHigh.map((row: any) => {
        const scores: Record<string, number | null> = {};
        // D-337: top-level scores for NBA; fall back to breakdown JSONB for
        // MLB (which only stores factor scores inside `breakdown`, not as
        // top-level columns). Pre-D-337, MLB picks rendered "1 firing" because
        // FACTOR_LABELS keys were all null at top level.
        const bd = (row as any).breakdown || {};
        for (const { col } of FACTOR_LABELS) {
          const top = (row as any)[col];
          scores[col] = (top !== null && top !== undefined) ? top : (bd[col] ?? null);
        }
        return {
          playerName: row.player_name,
          team: row.team || "",
          opponent: row.opponent || "",
          propType: row.prop_type || "",
          // D-631 — surface mlb_market_type for the UNVALIDATED badge classifier.
          mlbMarketType: (row as any).mlb_market_type ?? null,
          line: row.line,
          pickSide: row.pick_side || "over",
          odds: row.odds || -110,
          confidence: row.confidence,
          verdict: row.verdict || "",
          hitRates: row.hit_rates_display || { l5: "N/A", l10: "N/A", season: "N/A" },
          gameTime: row.game_time || "",
          aiAnalysis: row.ai_analysis,
          breakdown: row.breakdown || {},
          scores,
          bookmaker: row.bookmaker ?? null,
          availableBooks: row.available_books ?? null,
          // D-164: unbettable juice flag — surface in UI warning indicator.
          unbettableJuiceFlag: row.unbettable_juice_flag ?? false,
          // D-165: same-player non-primary market — filtered by default.
          isSecondaryMarket: row.is_secondary_market ?? false,
          // D-166: coin-flip sanity flag — surface in UI indicator.
          coinFlipFlag: row.coin_flip_flag ?? false,
          // D-167: negative-factor stacking flag + raw count.
          negativeStackingFlag: row.negative_stacking_flag ?? false,
          negativeFactorCount: row.negative_factor_count ?? 0,
          recommendationShown: row.recommendation_shown ?? undefined,
          evPerUnit: row.ev_per_unit ?? bd.d691_ev_per_unit ?? null,
          edgeVsImplied: row.edge_vs_implied ?? bd.d691_edge_vs_implied ?? null,
          winProb: row.win_prob ?? bd.d691_win_prob ?? null,
        };
      });

      // Derive metadata: distinct games from the FULL scored set (not the filtered visible one).
      const distinctGames = new Set(
        allPlayerPropsArr
          .map((r: any) => r.game_id)
          .filter((g: any) => g != null)
      );
      const newestCreatedAt = allPlayerPropsArr.reduce<string>((acc, row: any) => {
        const ts = (row.created_at as string | undefined) || "";
        return ts > acc ? ts : acc;
      }, "");

      const responseData: RecommendationsResponse = {
        success: true,
        generatedAt: newestCreatedAt || new Date().toISOString(),
        gamesAnalyzed: distinctGames.size,
        propsAnalyzed: allPlayerPropsArr.length,
        recommendations: recs,
      };

      setData(responseData);

      const nowMs = Date.now();
      setCachedAt(nowMs);
      try {
        localStorage.setItem(cacheKeyFor(sport), JSON.stringify({ data: responseData, timestamp: nowMs }));
      } catch {
        // Ignore storage errors
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch recommendations");
    } finally {
      setLoading(false);
    }
  }

  async function checkDuplicateBet(
    playerName: string,
    propType: string,
    line: number,
    pickSide: string
  ): Promise<boolean> {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from("bets")
        .select("id")
        .ilike("player_name", playerName)
        .eq("prop_type", propType.toLowerCase())
        .eq("line", line)
        .eq("pick_side", pickSide)
        .gte("placed_at", twentyFourHoursAgo)
        .limit(1);

      if (error) {
        console.error("Error checking for duplicate:", error);
        return false; // Allow insert on error
      }

      return (data?.length ?? 0) > 0;
    } catch {
      return false; // Allow insert on error
    }
  }

  async function handleLogAllPicks() {
    if (!recommendations.length) {
      console.log("[LogAllPicks] No recommendations to log");
      return;
    }

    setLoggingAll(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      console.log(`[LogAllPicks] Checking ${recommendations.length} picks for duplicates...`);

      // Check each pick for duplicates
      const betsToInsert: Array<{
        user_id: string;
        player_name: string;
        prop_type: string;
        line: number;
        pick_side: string;
        odds: number;
        stake: number;
        status: string;
      }> = [];
      let duplicatesSkipped = 0;
      const newLoggedPicks = new Set(loggedPicks);

      for (const rec of recommendations) {
        const pickKey = `${rec.playerName}-${rec.propType}-${rec.line}`;
        // Short-circuit using mount-time hydrated loggedPicks before issuing
        // a network call. Saves ~33 sequential round-trips on a normal slate.
        let isDuplicate = loggedPicks.has(pickKey);
        if (!isDuplicate) {
          isDuplicate = await checkDuplicateBet(rec.playerName, rec.propType, rec.line, rec.pickSide);
        }
        if (isDuplicate) {
          duplicatesSkipped++;
          newLoggedPicks.add(pickKey);
        } else {
          // §15.10 Critical #1 Phase 2 (CEO Q3 May 12): Log All Picks auto-fills
          // stake per Kelly action:
          //   BET         → Kelly's recommended stake (effective conf already
          //                 applied via computeKellyAction).
          //   SKIP_PRICE  → user's discretionary stake (default $5) — the math
          //                 says no edge at this price but the user wants the
          //                 row tracked.
          //   PASS_NO_EDGE → $0; logged for completeness, no stake recommended.
          // User can edit any stake in Tracker afterwards.
          const kellyBankroll = readBankroll();
          const kellyFracMode = readKellyFraction();
          const action = computeKellyAction({
            algoConfidence: rec.confidence,
            aiProse: rec.aiAnalysis,
            odds: rec.odds ?? -110,
            bankroll: kellyBankroll,
            fraction: kellyFracMode,
          });
          let stake: number;
          if (action.action === "BET") stake = action.stake;
          else if (action.action === "SKIP_PRICE") stake = readDiscretionaryStake();
          else stake = 0;
          betsToInsert.push({
            user_id: userId,
            player_name: rec.playerName,
            prop_type: rec.propType.toLowerCase(),
            line: rec.line,
            pick_side: rec.pickSide,
            odds: rec.odds ?? -110,
            stake,
            status: "pending",
          });
        }
      }

      console.log(`[LogAllPicks] ${betsToInsert.length} new picks, ${duplicatesSkipped} duplicates skipped`);

      if (betsToInsert.length === 0) {
        setLoggedPicks(newLoggedPicks);
        setSuccessMessage(`All ${duplicatesSkipped} picks were already logged`);
        setTimeout(() => setSuccessMessage(null), 4000);
        return;
      }

      const { data: insertedData, error: insertError } = await supabase
        .from("bets")
        .insert(betsToInsert)
        .select();

      if (insertError) {
        console.error("[LogAllPicks] Insert error:", insertError);
        setErrorMessage(`Failed to log picks: ${insertError.message}`);
        setTimeout(() => setErrorMessage(null), 5000);
      } else {
        console.log("[LogAllPicks] Success! Inserted:", insertedData);
        // Mark all as logged
        betsToInsert.forEach((bet) => {
          newLoggedPicks.add(`${bet.player_name}-${bet.prop_type}-${bet.line}`);
        });
        setLoggedPicks(newLoggedPicks);

        const message = duplicatesSkipped > 0
          ? `Logged ${betsToInsert.length} new picks (${duplicatesSkipped} duplicates skipped)`
          : `Logged ${betsToInsert.length} picks to tracker!`;
        setSuccessMessage(message);
        setTimeout(() => setSuccessMessage(null), 4000);
      }
    } catch (err) {
      console.error("[LogAllPicks] Unexpected error:", err);
      setErrorMessage("Failed to log picks - check console for details");
      setTimeout(() => setErrorMessage(null), 5000);
    } finally {
      setLoggingAll(false);
    }
  }

  async function fetchLiveGames() {
    setLiveLoading(true);
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke("get-live-games");
      if (fnError) {
        console.error("Live games error:", fnError.message);
        return;
      }
      const response = result as LiveGamesResponse;
      if (response?.success && response.games) {
        setLiveGames(response.games);
      }
    } catch (err) {
      console.error("Failed to fetch live games:", err);
    } finally {
      setLiveLoading(false);
    }
  }

  // D-060: stakeOverride is the user-confirmed stake from the
  // RecommendationCard's inline Kelly form. If 0 or undefined we fall
  // back to a $10 placeholder (legacy default) — but the inline UI now
  // requires user confirmation before reaching this fn, so a 0 stake
  // means user-explicitly-overrode-to-zero, which we still allow.
  async function handleLogSingleBet(rec: Recommendation, stakeOverride?: number): Promise<boolean> {
    const pickKey = `${rec.playerName}-${rec.propType}-${rec.line}`;

    // Already logged in UI state?
    if (loggedPicks.has(pickKey)) {
      console.log("[LogSingleBet] Already logged:", pickKey);
      return true;
    }

    try {
      console.log("[LogSingleBet] Checking for duplicate:", rec.playerName, rec.propType);

      // Check for duplicate in database
      const isDuplicate = await checkDuplicateBet(rec.playerName, rec.propType, rec.line, rec.pickSide);
      if (isDuplicate) {
        console.log("[LogSingleBet] Duplicate found in database");
        setErrorMessage("This bet is already logged");
        setTimeout(() => setErrorMessage(null), 4000);
        // Mark as logged in UI to prevent re-clicking
        setLoggedPicks((prev) => new Set(prev).add(pickKey));
        return false;
      }

      console.log("[LogSingleBet] Logging pick:", rec.playerName, rec.propType);

      const stake = typeof stakeOverride === "number" && stakeOverride >= 0 ? stakeOverride : 10.00;
      const betToInsert = {
        user_id: userId,
        player_name: rec.playerName,
        prop_type: rec.propType.toLowerCase(),
        line: rec.line,
        pick_side: rec.pickSide,
        odds: rec.odds ?? -110,
        stake,
        status: "pending",
      };

      const { error: insertError } = await supabase
        .from("bets")
        .insert(betToInsert);

      if (insertError) {
        console.error("[LogSingleBet] Insert error:", insertError);
        setErrorMessage(`Failed to log bet: ${insertError.message}`);
        setTimeout(() => setErrorMessage(null), 4000);
        return false;
      }

      console.log("[LogSingleBet] Success!");
      setLoggedPicks((prev) => new Set(prev).add(pickKey));
      return true;
    } catch (err) {
      console.error("[LogSingleBet] Unexpected error:", err);
      setErrorMessage("Failed to log bet");
      setTimeout(() => setErrorMessage(null), 4000);
      return false;
    }
  }

  // Live games are fetched on mount in the useEffect above

  const allRecommendations = data?.recommendations ?? [];

  // §15.10 Critical #1 Phase 2 (May 12, 2026): per-rec Kelly action — applies
  // AI verdict modifier from prose, runs Kelly with effective confidence, and
  // classifies into BET / SKIP_PRICE / PASS_NO_EDGE. Compute-on-render per CTO
  // call in /tmp/voice_reconciliation_spec_may12.md.
  const kellyBankrollLive = readBankroll();
  const kellyFractionLive = readKellyFraction();
  const kellyByRec = new Map<string, KellyActionResult>();
  for (const rec of allRecommendations) {
    const key = `${rec.playerName}__${rec.propType}__${rec.line}__${rec.pickSide}`;
    kellyByRec.set(key, computeKellyAction({
      algoConfidence: rec.confidence,
      aiProse: rec.aiAnalysis,
      odds: rec.odds ?? -110,
      bankroll: kellyBankrollLive,
      fraction: kellyFractionLive,
    }));
  }
  const kellyActionFor = (rec: Recommendation): KellyActionResult => {
    const key = `${rec.playerName}__${rec.propType}__${rec.line}__${rec.pickSide}`;
    return kellyByRec.get(key)!;
  };

  // Apply view mode (Kelly Picks vs All Picks), confidence filter, game filter, sort.
  const viewFiltered = viewMode === "kelly"
    ? allRecommendations.filter(rec => kellyActionFor(rec).action === "BET")
    : allRecommendations;
  const confFiltered = viewMode === "kelly"
    ? viewFiltered  // Kelly Picks tab ignores the tier sub-filter
    : viewFiltered.filter(rec => rec.confidence >= confidenceFilter);
  
  // Extract unique games for filter buttons
  const uniqueGames = Array.from(new Set(
    allRecommendations
      .filter(r => r.opponent && r.team)
      .map(r => {
        const teams = [r.team, r.opponent].sort();
        return teams.join(" vs ");
      })
  )).sort();
  
  const gameFiltered = gameFilter === "all" 
    ? confFiltered 
    : confFiltered.filter(rec => {
        const teams = [rec.team, rec.opponent].sort();
        return teams.join(" vs ") === gameFilter;
      });
  
  // D-256 (2026-05-19): chronological sort. Pre-D-256 used localeCompare on
  // raw game_time strings — broken for NBA "8:10 PM ET" format because
  // "10:00 PM ET" sorts BEFORE "8:00 PM ET" lexicographically ('1' < '8').
  // gameTimeMs returns epoch-ms for ISO 8601 (MLB) OR minute-of-day for
  // "H:MM AM/PM ET" (NBA). Within a single sport view scales are uniform.
  function gameTimeMs(s: string): number {
    if (!s) return Number.MAX_SAFE_INTEGER;
    const iso = new Date(s).getTime();
    if (!Number.isNaN(iso)) return iso;
    const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const mins = parseInt(m[2], 10);
      const ampm = m[3].toUpperCase();
      if (ampm === "PM" && h !== 12) h += 12;
      if (ampm === "AM" && h === 12) h = 0;
      return h * 60 + mins;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  const recommendations = [...gameFiltered].sort((a, b) => {
    if (sortBy === "time") {
      const tA = gameTimeMs(a.gameTime || "");
      const tB = gameTimeMs(b.gameTime || "");
      if (tA !== tB) return tA - tB;
      return b.confidence - a.confidence;
    }
    return b.confidence - a.confidence;
  });
  const lastAnalyzedTime = cachedAt ? new Date(cachedAt).toLocaleTimeString() : null;
  const hasData = data !== null;

  // D-258 (2026-05-19): filter labels aligned to production tier semantics
  // per _shared/scoring.ts getScoreLabel (90+ Elite / 80+ Strong / 70+ Good
  // / 60+ Lean / <60 Pass). Pre-D-258 labels "Strong 65+" and "Very Strong
  // 70+" used floor values that didn't match production tier boundaries,
  // creating subscriber confusion vs Performance + Landing copy.
  const filterOptions = [
    { label: "All (60+)",     value: 60, count: allRecommendations.filter(r => r.confidence >= 60).length },
    { label: "Good+ (70+)",   value: 70, count: allRecommendations.filter(r => r.confidence >= 70).length },
    { label: "Strong+ (80+)", value: 80, count: allRecommendations.filter(r => r.confidence >= 80).length },
    { label: "Elite (90+)",   value: 90, count: allRecommendations.filter(r => r.confidence >= 90).length },
  ];

  return (
    <div className="space-y-8">
      {/* Stats Bar - only show when we have data */}
      {hasData && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <StatCard label="Games Today" value={String(data?.gamesAnalyzed ?? 0)} />
          <StatCard label="Props Analyzed" value={String(data?.propsAnalyzed ?? 0)} />
          {/* §15.10 Critical #3 (May 12, 2026): count anchored to 65+ (not the
              currently-selected tab) so the headline doesn't inflate ~3x when
              the user is on the "All Picks 60+" tab.
              §15.10 Critical #4 (May 12, 2026): renamed "Strong Picks" →
              "Recommendations" — the verdict label "Strong Pick" now requires
              80+, so the old header text collided with the verdict threshold.
              The header is a volume metric (any tier worth surfacing), the
              verdict label is a quality metric; intentionally decoupled. */}
          <StatCard label="Recommendations" value={String(allRecommendations.filter(r => r.confidence >= 65).length)} highlight />
          {/* §15.10 Critical #1 Phase 2 (May 12, 2026): Bets count — number of
              picks where Kelly recommends a positive stake (action === 'BET').
              Sits next to Recommendations so subscribers see both the volume
              (algorithm output) and the bettable subset (Kelly verdict). */}
          <StatCard label="Bets" value={String(allRecommendations.filter(r => kellyActionFor(r).action === "BET").length)} highlight />
        </div>
      )}

      {/* Toggle row — always rendered so the user can switch sport / date /
          re-analyze even when there's no data. Previously gated on
          (hasData || loading || error) which trapped users in the empty
          state when sport=mlb returned 0 rows (D-048). */}
      <div className="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          {hasData && (
            <>
              <h2 className="text-lg font-medium text-zinc-200">{dateOffset === 0 ? "Today's" : "Tomorrow's"} Recommendations</h2>
              {lastAnalyzedTime && !loading && (
                <p className="text-xs text-zinc-500 mt-0.5">Last analyzed: {lastAnalyzedTime}{cronProgress ? ` • ${cronProgress}` : ""}</p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <SportSelector value={sport} onChange={setSport} />
          <button onClick={() => { setDateOffset(0); fetchRecommendations(0); }} className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${dateOffset === 0 ? "bg-emerald-600 text-white" : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>Today</button>
          <button onClick={() => { setDateOffset(1); fetchRecommendations(1); }} className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${dateOffset === 1 ? "bg-emerald-600 text-white" : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>Tomorrow</button>
          {!loading && !error && recommendations.length > 0 && (
            <button
              onClick={handleLogAllPicks}
              disabled={loggingAll || readOnly}
              title={readOnly ? readOnlyTip : undefined}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loggingAll ? "Logging..." : `Log All ${recommendations.length} Picks`}
            </button>
          )}
          <button
            onClick={() => fetchRecommendations()}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Analyzing..." : hasData ? "Re-analyze" : "Analyze"}
          </button>
        </div>
      </div>

      {/* Initial State - No Data Yet */}
      {!hasData && !loading && !error && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
          <div className="mb-6">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500/20 mb-4">
              <svg className="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-zinc-200 mb-2">Ready to Analyze</h2>
            <p className="text-zinc-500 text-sm">No picks yet for {dateOffset === 0 ? "today" : "tomorrow"} on the {sport === "mlb" ? "MLB" : "NBA"} slate. Use the toggles above to switch sport or date, or click below to fetch.</p>
          </div>
          <button
            onClick={() => fetchRecommendations()}
            className="px-8 py-3 text-base font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
          >
            {dateOffset === 0 ? "Analyze Today's Games" : "Analyze Tomorrow's Games"}
          </button>
        </div>
      )}

      {/* Today's Picks - show when we have data or are loading */}
      {(hasData || loading || error) && (
        <section>

        {/* §15.10 Critical #1 Phase 2 (May 12, 2026): top-level Kelly Picks /
            All Picks tabs. Kelly Picks is default — only shows picks where
            computeKellyAction returned BET. All Picks surfaces every
            recommendation regardless of Kelly verdict (tier sub-filters
            remain available in that view). */}
        {hasData && allRecommendations.length > 0 && !loading && (
          <div className="space-y-2 mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setViewMode("kelly")}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  viewMode === "kelly"
                    ? "bg-emerald-600 text-white"
                    : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                }`}
              >
                Kelly Picks ({allRecommendations.filter(r => kellyActionFor(r).action === "BET").length})
              </button>
              <button
                onClick={() => setViewMode("all")}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  viewMode === "all"
                    ? "bg-emerald-600 text-white"
                    : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                }`}
              >
                All Picks ({allRecommendations.length})
              </button>
            </div>

            {/* Tier sub-filter — only visible inside All Picks. Kelly Picks
                ignores the tier filter (the Kelly action floor handles it). */}
            {viewMode === "all" && (
            <div className="flex flex-wrap items-center gap-2">
              {filterOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setConfidenceFilter(option.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    confidenceFilter === option.value
                      ? "bg-emerald-600 text-white"
                      : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  {option.label} ({option.count})
                </button>
              ))}
            </div>
            )}
            {/* D-295 SHIP 2 (2026-05-23): coverage transparency. CEO
                observed "Dashboard shows ~4 games" at conf>=80 filter
                while cache had 11 games at 60+. Subscriber paying $99/mo
                couldn't tell whether slate was small OR filter was
                hiding picks. This sub-text makes that explicit. */}
            {viewMode === "all" && data && (
              <div className="text-xs text-zinc-500">
                Showing {confFiltered.length} pick{confFiltered.length === 1 ? "" : "s"} from{" "}
                {new Set(confFiltered.map(r => `${r.team} vs ${r.opponent}`)).size} of {data.gamesAnalyzed} game{data.gamesAnalyzed === 1 ? "" : "s"} today
                {confidenceFilter > 60 && allRecommendations.length > confFiltered.length && (
                  <> · {allRecommendations.length - confFiltered.length} more available at lower tiers</>
                )}
              </div>
            )}
            {/* Game Filter + Sort */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setGameFilter("all")}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  gameFilter === "all"
                    ? "bg-amber-600 text-white"
                    : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                }`}
              >
                All Games
              </button>
              {uniqueGames.map((game) => (
                <button
                  key={game}
                  onClick={() => setGameFilter(game)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    gameFilter === game
                      ? "bg-amber-600 text-white"
                      : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  {game.split(" vs ").map(t => t.split(" ").pop()).join(" vs ")}
                </button>
              ))}
              <span className="text-zinc-600 text-xs mx-1">|</span>
              <button
                onClick={() => setSortBy(sortBy === "time" ? "confidence" : "time")}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
              >
                Sort: {sortBy === "time" ? "⏰ Game Time" : "📊 Confidence"}
              </button>
              {/* D-165 (May 14, 2026): secondary-market toggle. Default OFF —
                  only the highest-confidence pick per (player, game_date)
                  renders. Toggle ON to surface correlated sibling markets. */}
              <button
                onClick={() => setShowSecondaryMarkets(s => !s)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  showSecondaryMarkets
                    ? "border border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/15"
                    : "border border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                }`}
                title="When OFF (default), same-player multiple-prop picks are deduped to the highest-confidence pick only. When ON, all markets per player are shown."
              >
                {showSecondaryMarkets ? "◆ All markets" : "◇ Primary only"}
              </button>
            </div>
          </div>
        )}

        {/* Success Toast */}
        {successMessage && (
          <div className="mb-4 rounded-lg bg-emerald-500/20 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-400 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {successMessage}
          </div>
        )}

        {/* Error Toast */}
        {errorMessage && (
          <div className="mb-4 rounded-lg bg-red-500/20 border border-red-500/30 px-4 py-3 text-sm text-red-400 flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            {errorMessage}
          </div>
        )}

        {loading && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mb-4" />
            <p className="text-zinc-400 text-sm">Analyzing today's games...</p>
            <p className="text-zinc-600 text-xs mt-1">This may take a minute</p>
          </div>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={() => fetchRecommendations()}
              className="mt-3 px-4 py-1.5 text-xs font-medium rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {!loading && !error && data?.message && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <p className="text-zinc-500 text-sm">{data.message}</p>
          </div>
        )}

        {!loading && !error && hasData && !data?.message && recommendations.length === 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            {allRecommendations.length > 0 ? (
              viewMode === "kelly" ? (
                /* §15.10 Critical #1 Phase 2 — empty Kelly Picks (CEO Q2:
                   show empty state, do NOT auto-switch to All Picks). */
                <>
                  <p className="text-zinc-500 text-sm">No bets meet Kelly criteria right now</p>
                  <p className="text-zinc-600 text-xs mt-1">
                    Either no picks cross the 60 effective-confidence floor, or
                    the available prices don't support an edge. Switch to All
                    Picks to see every algorithm recommendation.
                  </p>
                  <button
                    onClick={() => setViewMode("all")}
                    className="mt-3 px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    Switch to All Picks ({allRecommendations.length})
                  </button>
                </>
              ) : (
                <>
                  <p className="text-zinc-500 text-sm">No picks at {confidenceFilter}+ confidence</p>
                  <p className="text-zinc-600 text-xs mt-1">
                    Try a lower tier — {allRecommendations.length} picks available at 60+
                  </p>
                </>
              )
            ) : (
              <>
                <p className="text-zinc-500 text-sm">No strong picks found today</p>
                <p className="text-zinc-600 text-xs mt-1">Check back closer to game time</p>
              </>
            )}
          </div>
        )}

        {!loading && !error && recommendations.length > 0 && (
          <div className="grid gap-4">
            {recommendations.map((rec, i) => (
              <RecommendationCard
                key={`${rec.playerName}-${rec.propType}-${i}`}
                rec={rec}
                sport={sport}
                kellyAction={kellyActionFor(rec)}
                onLogBet={(stake) => handleLogSingleBet(rec, stake)}
                isLogged={loggedPicks.has(`${rec.playerName}-${rec.propType}-${rec.line}`)}
                userBooks={userBooks}
                readOnly={readOnly}
                readOnlyTip={readOnlyTip}
              />
            ))}
          </div>
        )}
        </section>
      )}

      {/* D-051: Game Picks Section removed. Spreads + totals live on the Games page. */}

      {/* Live Games Section */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-zinc-200">Live Games</h2>
          <button
            onClick={fetchLiveGames}
            disabled={liveLoading || readOnly}
            title={readOnly ? readOnlyTip : undefined}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {liveLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {liveLoading && liveGames.length === 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-amber-500 mb-3" />
            <p className="text-zinc-400 text-sm">Loading live scores...</p>
          </div>
        )}

        {!liveLoading && liveGames.length === 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <p className="text-zinc-500 text-sm">No live games right now</p>
          </div>
        )}

        {liveGames.length > 0 && (
          <div className="grid gap-3">
            {liveGames.map((game) => (
              <LiveGameCard key={game.id} game={game} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function LiveGameCard({ game }: { game: LiveGame }) {
  const gameTime = new Date(game.commenceTime).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  const statusColor =
    game.status === "Final" ? "text-zinc-500" :
    game.status === "In Progress" ? "text-amber-400" :
    "text-zinc-600";

  const borderColor =
    game.status === "In Progress" ? "border-l-amber-500" :
    game.status === "Final" ? "border-l-zinc-600" :
    "border-l-zinc-700";

  return (
    <div className={`rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 border-l-4 ${borderColor}`}>
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <div className="text-sm">
              <span className="text-zinc-300 font-medium">{game.awayTeam}</span>
              <span className="text-zinc-600 mx-2">@</span>
              <span className="text-zinc-300 font-medium">{game.homeTeam}</span>
            </div>
          </div>
          <p className="text-xs text-zinc-600 mt-1">{gameTime}</p>
        </div>

        <div className="text-right">
          {(game.awayScore !== null || game.homeScore !== null) ? (
            <div className="text-lg font-bold text-white">
              {game.awayScore ?? 0} - {game.homeScore ?? 0}
            </div>
          ) : (
            <div className="text-sm text-zinc-600">--</div>
          )}
          <p className={`text-xs font-medium ${statusColor}`}>
            {game.status === "In Progress" && "LIVE"}
            {game.status === "Final" && "FINAL"}
            {game.status === "Scheduled" && "SCHED"}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-4">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${highlight ? "text-emerald-400" : "text-white"}`}>
        {value}
      </p>
    </div>
  );
}

interface RecommendationCardProps {
  rec: Recommendation;
  // D-631 — sport drives the isMarketUnvalidated() classification.
  sport: Sport;
  kellyAction: KellyActionResult;
  onLogBet: (stake: number) => Promise<boolean>;
  isLogged: boolean;
  userBooks: string[];
  readOnly?: boolean;
  readOnlyTip?: string;
}


// Display-name overrides for common book keys. Anything not in the map gets
// title-cased with underscores → spaces. Regional Hard Rock variants
// (hardrockbet_fl, hardrockbet_az) collapse to "HRB FL" / "HRB AZ".
const BOOK_DISPLAY: Record<string, string> = {
  hardrockbet: "HRB",
  hardrockbet_fl: "HRB FL",
  hardrockbet_az: "HRB AZ",
  draftkings: "DK",
  fanduel: "FD",
  betmgm: "MGM",
  bovada: "Bovada",
  pointsbet: "PointsBet",
  fliff: "Fliff",
  ballybet: "Bally",
  betparx: "BetParx",
  betonlineag: "BetOnline",
  espnbet: "ESPN",
  betrivers: "BetRivers",
  williamhill_us: "Caesars",
  fanatics: "Fanatics",
};

function bookDisplayName(key: string): string {
  if (BOOK_DISPLAY[key]) return BOOK_DISPLAY[key];
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface BestPriceResult {
  hrb: AvailableBook | null;
  best: AvailableBook | null;
  deltaCents: number;
  isMaterial: boolean;
  sameLineCandidates: AvailableBook[];
  altLineCandidates: AvailableBook[];
}

function findBestPrice(rec: Recommendation): BestPriceResult | null {
  const books = rec.availableBooks;
  if (!books || books.length === 0) return null;

  // Only books offering the same side this pick is on.
  const sameSide = books.filter((b) => b.pick_side === rec.pickSide);
  if (sameSide.length === 0) return null;

  const sameLineCandidates = sameSide
    .filter((b) => b.line === rec.line)
    .slice()
    .sort((a, b) => b.odds - a.odds); // highest payout first

  const altLineCandidates = sameSide
    .filter((b) => b.line !== rec.line)
    .slice()
    .sort((a, b) => (a.line - b.line) || (b.odds - a.odds));

  // HRB resolution: explicit rec.bookmaker first, then any hardrockbet* fallback.
  const hrb =
    (rec.bookmaker
      ? sameLineCandidates.find((b) => b.bookmaker === rec.bookmaker)
      : null) ??
    sameLineCandidates.find((b) => b.bookmaker.startsWith("hardrockbet")) ??
    null;

  const best = sameLineCandidates.length > 0 ? sameLineCandidates[0] : null;

  let deltaCents = 0;
  if (hrb && best) deltaCents = best.odds - hrb.odds;

  return {
    hrb,
    best,
    deltaCents,
    isMaterial: Math.abs(deltaCents) >= 5,
    sameLineCandidates,
    altLineCandidates,
  };
}

function LineShoppingSection({ rec, userBooks }: { rec: Recommendation; userBooks: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const userBookSet = new Set(userBooks);
  const result = findBestPrice(rec);
  if (!result) return null;
  const { hrb, sameLineCandidates, altLineCandidates } = result;

  // Single-book case: no comparison possible.
  if (sameLineCandidates.length <= 1) {
    if (!hrb) return null;
    return (
      <div className="mt-3 pt-3 border-t border-zinc-800/50">
        <span className="text-[11px] text-zinc-500">
          {bookDisplayName(hrb.bookmaker)} only · no other books offer this line
        </span>
      </div>
    );
  }

  // User-aware best: highest odds among books the user has accounts at.
  // sameLineCandidates is already sorted by odds DESC inside findBestPrice.
  const userBest = sameLineCandidates.find((b) => userBookSet.has(b.bookmaker)) ?? null;
  const userBestIsHrb = !!(hrb && userBest && hrb.bookmaker === userBest.bookmaker);
  const userDeltaCents = (userBest && hrb) ? userBest.odds - hrb.odds : 0;
  const showInline = !!(userBest && hrb && !userBestIsHrb && Math.abs(userDeltaCents) >= 5);

  return (
    <div className="mt-3 pt-3 border-t border-zinc-800/50">
      <div className="flex items-center justify-between flex-wrap gap-2">
        {showInline ? (
          <span className="text-[11px] text-zinc-300">
            <span className="text-amber-400">↑</span>{" "}
            Better at <span className="font-semibold text-emerald-400">{bookDisplayName(userBest!.bookmaker)}</span>{" "}
            <span className="font-semibold text-emerald-400">{formatOdds(userBest!.odds)}</span>{" "}
            <span className="text-zinc-500">({userDeltaCents >= 0 ? "+" : ""}{userDeltaCents}¢)</span>
          </span>
        ) : (
          <span className="text-[11px] text-zinc-500">
            {userBestIsHrb && hrb ? `${bookDisplayName(hrb.bookmaker)} best at your books` :
             !userBest && hrb ? `${bookDisplayName(hrb.bookmaker)} only book in your set` :
             hrb ? `${bookDisplayName(hrb.bookmaker)} best at your books` :
             "Compare available books"}
          </span>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {expanded ? "Hide books ▲" : `Compare books (${sameLineCandidates.length}${altLineCandidates.length ? `+${altLineCandidates.length}` : ""}) ▼`}
        </button>
      </div>

      {expanded && (
        <div className="mt-2.5 space-y-2.5">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Same line ({rec.line})</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              {sameLineCandidates.map((b) => {
                const isHrb = hrb && b.bookmaker === hrb.bookmaker;
                const isUserBest = userBest && b.bookmaker === userBest.bookmaker;
                const isUserBook = userBookSet.has(b.bookmaker);
                const oddsClass =
                  isUserBest && !userBestIsHrb ? "text-emerald-400 font-semibold" :
                  isHrb ? "text-amber-300" :
                  isUserBook ? "text-zinc-300" :
                  "text-zinc-600";
                return (
                  <div
                    key={`${b.bookmaker}-${b.line}-${b.odds}`}
                    className={`flex items-baseline justify-between gap-2 ${isUserBook ? "" : "opacity-50"}`}
                  >
                    <span
                      className={`truncate ${isHrb ? "text-amber-300 font-medium" : isUserBook ? "text-zinc-400" : "text-zinc-600"}`}
                      title={b.bookmaker}
                    >
                      {bookDisplayName(b.bookmaker)}{isHrb ? " ★" : ""}
                      {!isUserBook && <span className="ml-1 text-[10px] text-zinc-600">✗</span>}
                    </span>
                    <span className={`tabular-nums ${oddsClass}`}>{formatOdds(b.odds)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {altLineCandidates.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Other lines</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                {altLineCandidates.map((b, idx) => {
                  const isUserBook = userBookSet.has(b.bookmaker);
                  return (
                    <div
                      key={`alt-${b.bookmaker}-${b.line}-${b.odds}-${idx}`}
                      className={`flex items-baseline justify-between gap-2 ${isUserBook ? "" : "opacity-50"}`}
                    >
                      <span className={`truncate ${isUserBook ? "text-zinc-400" : "text-zinc-600"}`} title={b.bookmaker}>
                        {bookDisplayName(b.bookmaker)}
                        {!isUserBook && <span className="ml-1 text-[10px] text-zinc-600">✗</span>}
                      </span>
                      <span className={`tabular-nums ${isUserBook ? "text-zinc-300" : "text-zinc-600"}`}>
                        <span className="text-zinc-500 mr-1">{b.line}</span>{formatOdds(b.odds)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="pt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
            <span>★ HRB · ✗ no account</span>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("bg:navigate", { detail: "settings" }))}
              className="text-zinc-400 hover:text-zinc-200 underline transition-colors"
            >
              Edit in Settings →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RecommendationCard({ rec, sport, kellyAction, onLogBet, isLogged, userBooks, readOnly = false, readOnlyTip = "" }: RecommendationCardProps) {
  // D-631 — surface "UNVALIDATED" tag for markets whose -EV verdict was
  // measured on broken pre-D-630 inputs. See src/lib/marketValidation.ts.
  const marketUnvalidated = isMarketUnvalidated(sport, rec.propType, rec.mlbMarketType);
  // D-635 — line movement caption ("opened -110 → now -120"). Reads
  // breakdown.lm_* fields written by applyLineMovementV2. Source-agnostic.
  const lineMovementCaption = getLineMovementCaption(rec.breakdown);
  // D-636 — sharp money badge (RLM proxy + steam). Weight 0; descriptive only.
  const sharpMoneyBadge = getSharpMoneyBadge(rec.breakdown);
  const [logging, setLogging] = useState(false);
  // D-655 SHIP 1 — factor expand/collapse state moved into shared FactorPanel.
  // D-060 — inline Kelly confirm flow. Click "Log Bet" → expand into a
  // small form with the Kelly-suggested stake prefilled + an editable
  // input + Confirm/Cancel. Avoids building a modal component.
  const [showStakeForm, setShowStakeForm] = useState(false);
  const [showKellyExplainer, setShowKellyExplainer] = useState(false);
  const [bankroll] = useState<number>(() => readBankroll());
  const kellyOdds = rec.odds ?? -110;
  // Compute breakdown eagerly so the caption can show raw vs capped
  // when the 5% cap binds — toggling Kelly Aggressiveness produces
  // visible changes in the raw number even when the capped final stays
  // at $50. Cheap synchronous compute, no I/O.
  const breakdown = kellyBreakdown({ confidence: rec.confidence, odds: kellyOdds, bankroll });
  // §15.10 Critical #1 Phase 2 (May 12, 2026): inline Kelly confirm form
  // pre-fills with the Kelly-action stake (already includes AI verdict
  // modifier + effective-confidence floor), not the algorithm-only Kelly.
  // For SKIP_PRICE / PASS_NO_EDGE actions the prefill is $0, but the user
  // can still override and bet anyway in the inline form.
  const suggestedStake = kellyAction.action === "BET" ? kellyAction.stake : 0;
  // Pre-cap suggested stake rounded to nearest $5 to match how the final
  // stake is rounded — ensures a clean "$90 → $50" pattern instead of
  // "$87.30 → $50".
  const preCapStake = Math.round(breakdown.preCappedStake / 5) * 5;
  const fractionLabel = breakdown.fractionMode.charAt(0).toUpperCase() + breakdown.fractionMode.slice(1);
  const [stakeInput, setStakeInput] = useState<string>(String(suggestedStake));
  // D-655 SHIP 1 — render factors with the same 3-bucket logic Games uses.
  // rec.scores carries flat columns from recommendations_cache; the FactorPanel
  // surfaces firing / evaluated-no-tilt / not-in-breakdown buckets so 0-tilt
  // factors and silent-empty breakdown gaps are both honest signal.
  const scoresLookup = (col: string): unknown =>
    rec.scores ? (rec.scores as Record<string, unknown>)[col] : undefined;

  function handleClick() {
    if (isLogged || logging) return;
    // D-350 — block log-bet trigger in read-only (friend preview) mode.
    if (readOnly) return;
    // D-060 — open inline confirm form instead of immediate log.
    setStakeInput(String(suggestedStake));
    setShowStakeForm(true);
  }

  async function handleConfirm() {
    if (logging) return;
    if (readOnly) return;  // D-350 defense-in-depth
    const n = parseFloat(stakeInput);
    const stake = Number.isFinite(n) && n >= 0 ? n : 0;
    setLogging(true);
    const ok = await onLogBet(stake);
    setLogging(false);
    if (ok) setShowStakeForm(false);
  }

  function handleCancel() {
    if (logging) return;
    setShowStakeForm(false);
  }
  // §15.10 Critical #4 (May 12, 2026): tier thresholds bumped to match
  // recalibrated verdict labels (90 Elite / 80 Strong / 70 Good / 60 Lean).
  const confidenceColor =
    rec.confidence >= 90 ? "text-amber-300 bg-amber-500/20 border-amber-500/30" :
    rec.confidence >= 80 ? "text-emerald-400 bg-emerald-500/20 border-emerald-500/30" :
    rec.confidence >= 70 ? "text-green-400 bg-green-500/20 border-green-500/30" :
    "text-yellow-400 bg-yellow-500/20 border-yellow-500/30";

  // Verdict-label color mapping. Recalibrated May 7 per CEO Option B
  // alongside getScoreLabel cutoffs (process-games:1210 + lib/confidence:101).
  const verdictColor =
    rec.verdict === "Elite Pick" ? "text-amber-300" :
    rec.verdict === "Strong Pick" ? "text-emerald-400" :
    rec.verdict === "Good Pick" ? "text-green-400" :
    "text-yellow-400";

  // D-266: extended game-pick prop types to cover MLB markets (h2h/spreads/totals).
  // These should not normally appear on Dashboard (filtered upstream) but the
  // isGamePick flag also drives the L5/L10/Season hide on PickCard.
  const isGamePick =
    rec.propType === "spread" || rec.propType === "game_total" ||
    rec.propType === "h2h" || rec.propType === "spreads" || rec.propType === "totals";
  const propLabel =
    rec.propType === "game_total" ? "Game Total" :
    rec.propType === "spread" ? "Spread" :
    rec.propType === "h2h" ? "Moneyline" :
    rec.propType === "spreads" ? "Run Line" :
    rec.propType === "totals" ? "Game Total" :
    rec.propType.charAt(0).toUpperCase() + rec.propType.slice(1);

  // §15.10 Critical #1 Phase 2 (May 12, 2026): Kelly headline takes over the
  // top of the card. Color + verb depends on action; the algorithm-level
  // verdict (Elite/Strong/Good/Lean) demotes to the context strip.
  const kellyHeadline =
    kellyAction.action === "BET"
      ? { text: `BET $${kellyAction.stake}`, color: "text-emerald-400", bg: "bg-emerald-500/15 border-emerald-500/40" }
      : kellyAction.action === "SKIP_PRICE"
        ? { text: "SKIP — Price too steep", color: "text-amber-300", bg: "bg-amber-500/10 border-amber-500/30" }
        : { text: "PASS — No edge", color: "text-zinc-400", bg: "bg-zinc-700/30 border-zinc-600/30" };
  const aiBadge =
    kellyAction.aiVerdict === "TAKE" ? { label: "AI: TAKE (+5)", color: "text-emerald-300" } :
    kellyAction.aiVerdict === "LEAN" ? { label: "AI: LEAN (+2)", color: "text-blue-300" } :
    kellyAction.aiVerdict === "FADE" ? { label: "AI: FADE (−5)", color: "text-red-300" } :
    null;

  return (
    <div className={`rounded-xl border ${isGamePick ? "border-blue-500/30 bg-blue-900/10" : "border-zinc-800 bg-zinc-900/50"} p-4`}>
      {/* Kelly verdict headline — final voice, top of every card. */}
      <div className={`rounded-lg border ${kellyHeadline.bg} px-3 py-2 mb-3 flex items-baseline justify-between gap-3 flex-wrap`}>
        <span className={`text-lg font-bold ${kellyHeadline.color} tracking-tight`}>{kellyHeadline.text}</span>
        <span className="text-[11px] text-zinc-400 tabular-nums">
          <span className="text-zinc-300">Algo {kellyAction.algoConfidence}</span>
          {aiBadge && <> · <span className={aiBadge.color}>{aiBadge.label}</span></>}
          {" · "}<span className="text-zinc-300">Eff {kellyAction.effectiveConfidence}</span>
          {kellyAction.action === "BET" && <> · <span className="text-emerald-300">{kellyAction.edgePercent.toFixed(1)}% edge</span></>}
          {rec.evPerUnit != null && rec.evPerUnit > 0 && (
            <> · <span className="text-emerald-300">+{rec.evPerUnit.toFixed(2)}u EV</span></>
          )}
        </span>
      </div>

      <div className="flex items-start justify-between gap-4">
        {/* Left: Player/Game Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {isGamePick && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium">{rec.propType === "spread" ? "SPREAD" : "TOTAL"}</span>}
            <h3 className="font-semibold text-white truncate">{rec.playerName}</h3>
            {!isGamePick && <span className="text-xs text-zinc-500">{rec.team}</span>}
            {rec.gameTime && (
              <span className="text-xs text-amber-400/80 font-medium">• {formatGameTime(rec.gameTime)}</span>
            )}
          </div>

          <div className="flex items-center gap-3 text-sm">
            {isGamePick ? (
              <>
                <span className="text-zinc-300">
                  {rec.propType === "spread" ? (
                    <><span className={rec.pickSide === "home" ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>{rec.pickSide === "home" ? "Home" : "Away"}</span> <span className="text-white font-medium">{rec.line > 0 ? "+" : ""}{rec.line}</span></>
                  ) : (
                    <><span className={rec.pickSide === "over" ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>{rec.pickSide === "over" ? "Over" : "Under"}</span> <span className="text-white font-medium">{rec.line}</span></>
                  )}
                </span>
                <span className="text-zinc-500">{formatOdds(rec.odds)}</span>
              </>
            ) : (
              <>
                <span className="text-zinc-300">
                  {propLabel} <span className={rec.pickSide === "under" ? "text-red-400 font-medium" : "text-emerald-400 font-medium"}>{rec.pickSide === "under" ? "U" : "O"}{rec.line}</span>
                </span>
                {/* D-631 — UNVALIDATED badge on previously-hidden markets. */}
                {marketUnvalidated && (
                  <span
                    className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300"
                    title="Unvalidated — this market's -EV verdict was measured on broken inputs (D-630 fixed weather/Statcast holes). Awaiting re-measurement on clean data."
                  >
                    Unvalidated
                  </span>
                )}
                <span className="text-zinc-500">{formatOdds(rec.odds)}</span>
                {rec.opponent && (
                  <span className="text-zinc-500">vs {rec.opponent}</span>
                )}
              </>
            )}
          </div>

          {/* D-635 — line-movement caption. Reads breakdown.lm_* fields
              (written by applyLineMovementV2). Hidden for no_data /
              no_movement / neutral magnitudes. Color-coded by direction. */}
          {lineMovementCaption.show && (
            <div
              className={`mt-1 text-[11px] font-medium ${
                lineMovementCaption.towardPick ? "text-emerald-400/90" : "text-red-400/90"
              }`}
              title="Line movement from earliest snapshot to latest. Source-agnostic — reads normalized cache_odds_snapshots."
            >
              {lineMovementCaption.caption}
            </div>
          )}
          {/* D-636 — sharp money badge (RLM proxy + steam). Weight 0;
              descriptive only. Reads rlm_ and steam_ breakdown fields. */}
          {sharpMoneyBadge.show && (
            <div className="mt-1">
              <span
                className={`inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  sharpMoneyBadge.favorsPick
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-red-500/40 bg-red-500/10 text-red-300"
                }`}
                title={sharpMoneyBadge.tooltip}
              >
                {sharpMoneyBadge.label}
              </span>
            </div>
          )}
        </div>

        {/* Right: Confidence Score */}
        <div className="text-right shrink-0">
          <div
            className={`inline-block px-3 py-1 rounded-lg border ${confidenceColor} font-bold text-lg`}
            title={kellyAction.aiVerdict === "FADE" && rec.confidence >= 70 ? "Tier label suppressed — Sonnet (AI Analysis) returns FADE on this pick. The Kelly headline above shows AI: FADE; see AI Analysis for reasoning." : undefined}
          >
            {rec.confidence}
          </div>
          {!(kellyAction.aiVerdict === "FADE" && rec.confidence >= 70) && (
            <p className={`text-xs mt-1 ${verdictColor} font-medium`}>{rec.verdict}</p>
          )}
          {/* D-164 (May 14, 2026): unbettable juice warning — under-side picks
              where the price exceeds tier breakeven (60+:-200, 70+:-250,
              80+:-300, 90+:-350). Doesn't hide the pick — informs subscribers
              the juice may not be worth it. */}
          {rec.unbettableJuiceFlag && (
            <p className="text-[10px] mt-1 text-amber-300/90 font-medium uppercase tracking-wide"
               title="Under-side juice exceeds tier breakeven — needs >70% WR to profit at this price.">
              ⚠ unbettable juice
            </p>
          )}
          {/* D-165 (May 14, 2026): secondary-market indicator (only renders
              when toggle is on). */}
          {rec.isSecondaryMarket && (
            <p className="text-[10px] mt-1 text-zinc-500 font-medium uppercase tracking-wide"
               title="Same player has a higher-confidence pick today. Toggle 'Show secondary markets' to see all.">
              ◇ secondary market
            </p>
          )}
          {/* D-166 (May 14, 2026): coin-flip sanity indicator — Elite conf
              but season hit rate near 50%. Signals possible factor pumping. */}
          {rec.coinFlipFlag && (
            <p className="text-[10px] mt-1 text-orange-300/90 font-medium uppercase tracking-wide"
               title="Season hit rate near 50% but pick is rated Elite — review confidence carefully.">
              ◎ coin-flip rate
            </p>
          )}
          {/* D-167 (May 14, 2026): negative-factor stacking warning — Failure
              Mode D. Elite confidence with 3+ factors negative. */}
          {rec.negativeStackingFlag && (
            <p className="text-[10px] mt-1 text-red-400/90 font-medium uppercase tracking-wide"
               title={`Confidence Elite but ${rec.negativeFactorCount ?? 0} factors negative — review.`}>
              ⛒ {rec.negativeFactorCount ?? 0} neg stack
            </p>
          )}
        </div>
      </div>

      {/* Line shopping — only player props (game picks have no available_books). */}
      <LineShoppingSection rec={rec} userBooks={userBooks} />

      {/* Hit Rates — hide for game picks (no player-level hit rates) */}
      {!isGamePick && (
        <div className="flex gap-4 mt-3 pt-3 border-t border-zinc-800/50">
          <HitRateChip label="L5" value={rec.hitRates.l5} />
          <HitRateChip label="L10" value={rec.hitRates.l10} />
          <HitRateChip label="Season" value={rec.hitRates.season} />
        </div>
      )}

      {/* AI Analysis */}
      {typeof rec.aiAnalysis === 'string' && rec.aiAnalysis.trim().length > 0 && (
        <div className="mt-3 pt-3 border-t border-zinc-800/50">
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-sm">✨</span>
            <span className="text-xs font-medium text-purple-400">AI Analysis</span>
          </div>
          <p className="text-xs text-zinc-400 leading-relaxed">{rec.aiAnalysis}</p>
        </div>
      )}

      {/* Factor breakdown — collapsible list of per-factor scores (non-zero only) */}
      {/* D-655 SHIP 1 — shared FactorPanel: firing + evaluated-no-tilt + missing buckets. */}
      {/* D-676 — pass per-market col set so pitcher_outs cards don't count NBA/batter labels as "missing." */}
      <div className="mt-3 pt-3 border-t border-zinc-800/50">
        <FactorPanel
          labels={FACTOR_LABELS}
          lookup={scoresLookup}
          marketCols={rec.mlbMarketType ? MARKET_FACTOR_COLS[rec.mlbMarketType] : undefined}
        />
      </div>

      {/* Log Bet Button → expands to inline Kelly confirm form (D-060) */}
      <div className="mt-3 pt-3 border-t border-zinc-800/50">
        {isLogged || !showStakeForm ? (
          <button
            onClick={handleClick}
            disabled={isLogged || logging || readOnly}
            title={readOnly ? readOnlyTip : undefined}
            className={`w-full rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isLogged
                ? "border-emerald-500/30 bg-emerald-500/20 text-emerald-400 cursor-default"
                : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white"
            }`}
          >
            {isLogged ? "Logged ✓" : "Log Bet"}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 text-xs">Stake $</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={stakeInput}
                onChange={(e) => setStakeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleConfirm(); if (e.key === "Escape") handleCancel(); }}
                disabled={logging}
                autoFocus
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-100 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:opacity-60"
              />
              <button
                onClick={handleConfirm}
                disabled={logging}
                className="rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-60 disabled:cursor-wait"
              >
                {logging ? "..." : "Confirm"}
              </button>
              <button
                onClick={handleCancel}
                disabled={logging}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-60"
              >
                ✕
              </button>
            </div>
            <p className="text-[10px] text-zinc-500 leading-snug">
              {suggestedStake > 0 ? (
                breakdown.capApplied ? (
                  // Cap binds: show raw → capped so toggling Aggressiveness produces
                  // visible movement in the raw number even when the capped final is
                  // pinned at the 5% bankroll ceiling.
                  <>{fractionLabel} Kelly: <span className="text-zinc-400 line-through">${preCapStake}</span> → capped at <span className="text-zinc-300 font-medium">${suggestedStake}</span> ({Math.round(MAX_BET_PCT * 100)}% of <span className="text-zinc-400">${bankroll.toFixed(0)}</span> bankroll) · </>
                ) : (
                  // Cap doesn't bind: single clean line, no cap mention.
                  <>{fractionLabel} Kelly: <span className="text-zinc-300 font-medium">${suggestedStake}</span> ({breakdown.rawStakePct.toFixed(2)}% of bankroll) · </>
                )
              ) : (
                <span className="text-amber-400/80">The price isn't good enough to justify a bet, even with this confidence. Override above if you still want to log it. </span>
              )}
              <button
                type="button"
                onClick={() => setShowKellyExplainer((v) => !v)}
                className="text-zinc-400 hover:text-zinc-200 underline-offset-2 hover:underline"
              >
                {showKellyExplainer ? "Hide math" : "Why?"}
              </button>
            </p>
            {showKellyExplainer && breakdown && (
              <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-2.5 text-[10px] text-zinc-400 leading-snug space-y-1">
                <div>Your confidence: <span className="text-zinc-200">{rec.confidence}</span></div>
                <div>Real win rate at this confidence: <span className="text-zinc-200">{Math.round(breakdown.probability * 100)}%</span></div>
                <div>This bet needs you to win <span className="text-zinc-200">{Math.round(breakdown.breakEvenProb * 100)}%</span> of the time to break even</div>
                <div className={breakdown.edgePct >= 0 ? "text-emerald-400" : "text-red-400"}>
                  Your edge: {breakdown.edgePct >= 0 ? "+" : ""}{breakdown.edgePct.toFixed(1)}%
                  {breakdown.edgePct >= 0 ? " (good value)" : " (the price is too high)"}
                </div>
                {breakdown.fullKellyPct > 0 && (
                  <div className="pt-1 border-t border-zinc-800/60">
                    {breakdown.capApplied ? (
                      <>
                        <div>{fractionLabel} Kelly recommends: <span className="text-zinc-200">{breakdown.rawStakePct.toFixed(1)}%</span> of bankroll = <span className="text-zinc-200">${preCapStake}</span></div>
                        <div>Capped at <span className="text-zinc-200">{Math.round(MAX_BET_PCT * 100)}%</span> of bankroll = <span className="text-zinc-200">${suggestedStake}</span> max</div>
                      </>
                    ) : (
                      <div>Suggested stake: <span className="text-zinc-200">{breakdown.rawStakePct.toFixed(2)}%</span> of bankroll = <span className="text-zinc-200">${suggestedStake}</span></div>
                    )}
                  </div>
                )}
                <div className="text-zinc-500/80 pt-1 border-t border-zinc-800/60">
                  Win rates come from how often picks at each confidence level have actually hit. Change your Kelly Aggressiveness in <span className="text-zinc-400">Settings</span>.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HitRateChip({ label, value }: { label: string; value: string }) {
  const numValue = parseInt(value);
  const color = numValue >= 70 ? "text-emerald-400" : numValue >= 50 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="text-xs">
      <span className="text-zinc-500">{label}: </span>
      <span className={color}>{value}</span>
    </div>
  );
}

function formatOdds(odds: number): string {
  return odds >= 0 ? `+${odds}` : String(odds);
}
