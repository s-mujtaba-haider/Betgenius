-- D-214 Fix 5 — MLB pick quarantine audit columns + rescore preservation.
--
-- Today's MLB Beta picks were generated against degraded factor data
-- (4 of 5 cache tables empty pending first cron tick post-deploy). D-214
-- Fix 4 populated the caches. This migration prepares pick_history to
-- track the pre-fix / post-fix audit trail when rescoring.
--
-- New columns:
--   confidence_pre_d214_fix INT  — snapshot of original confidence before rescore
--   is_d214_quarantined     BOOLEAN  — TRUE when pick was scored against degraded data
--   quarantine_reason       TEXT  — human-readable label for downstream filters
--
-- All NULLable; NBA writers and unaffected MLB picks remain NULL.
--
-- §1.17 audit: upsert_pick_history RPC updated to surface the 3 new
-- columns. Backfill-bdl direct POST is NBA-only, unaffected.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS confidence_pre_d214_fix INTEGER,
  ADD COLUMN IF NOT EXISTS is_d214_quarantined     BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quarantine_reason       TEXT;

CREATE INDEX IF NOT EXISTS idx_ph_d214_quarantined
  ON public.pick_history (sport, is_d214_quarantined, game_date)
  WHERE is_d214_quarantined = TRUE;

COMMENT ON COLUMN public.pick_history.confidence_pre_d214_fix IS
  'D-214 Fix 5 — snapshot of confidence BEFORE D-214 rescore. NULL for picks not affected by D-204 cache-empty period (i.e., not generated 2026-05-17 + earlier).';
COMMENT ON COLUMN public.pick_history.is_d214_quarantined IS
  'D-214 Fix 5 — TRUE when pick was scored against degraded MLB factor data (4 of 5 cache tables empty 2026-05-17 → 2026-05-18 backfill). Exclude from Beta calibration baseline.';
COMMENT ON COLUMN public.pick_history.quarantine_reason IS
  'D-214 Fix 5 — free-text reason (e.g., "D-214 cache infrastructure failure — picks generated against degraded factor data").';

-- Regen upsert_pick_history RPC with the 3 new columns. Per §1.17 audit,
-- both INSERT VALUES and DO UPDATE SET clauses extended. All 3 NULLable
-- with COALESCE on UPDATE so non-MLB writers don't overwrite quarantine
-- state.
CREATE OR REPLACE FUNCTION public.upsert_pick_history(payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rec       public.pick_history;
  result_id UUID;
BEGIN
  rec := jsonb_populate_record(NULL::public.pick_history, payload);

  INSERT INTO public.pick_history (
    player_name, team, opponent, game_time, game_date, is_home,
    prop_type, line, pick_side, odds,
    season_avg, recent_avg, floor_val, ceiling_val,
    l5_hit_count, l10_hit_count, season_hit_pct,
    is_b2b, rest_days, minutes_l5_avg, minutes_l10_avg, minutes_trend,
    opp_ppg_allowed,
    score_l5, score_l10, score_season, score_floor_ceiling, score_recent_form,
    score_home_away, score_rest, score_b2b, score_minutes_trend, score_pace,
    score_opp_defense, score_z_score, score_role_change, score_vig_filter,
    score_usg_rate, score_regression, score_market_conf, score_home_away_split,
    score_minutes_floor, score_consistency, score_prop_type_penalty,
    score_stale_data, score_player_injury,
    score_trivial_line_penalty, score_trivial_line_cap,
    score_minutes_volume, score_minutes_stability,
    score_low_min_risk, score_blowout_risk, score_line_movement,
    unbettable_juice_flag, is_secondary_market,
    coin_flip_flag, negative_stacking_flag, negative_factor_count,
    projected_stat, stat_stdev, z_score, per_minute_rate, projected_minutes,
    teammate_injuries_count, usage_boost,
    confidence, verdict, ai_analysis,
    source, recommendation_shown,
    is_synthetic, sport,
    confidence_pre_tier_aware, ai_verdict,
    score_pitcher_k_rate, score_pitcher_form, score_opposing_lineup_k,
    score_handedness_matchup, score_pitch_count_trend, score_rest_pitcher,
    score_ballpark_factor, score_weather_wind, score_weather_temp,
    score_umpire_k_zone, score_lineup_consistency,
    mlb_market_type, is_mlb_beta, mlb_beta_resolved_picks,
    score_batter_hit_rate, score_batter_form,
    score_opposing_pitcher_quality, score_recent_at_bats,
    score_offense_differential, score_pitching_matchup,
    score_bullpen_strength, score_recent_run_diff,
    score_h2h_recent, score_team_form,
    score_batter_power_rate, score_batter_form_power, score_pitcher_hr_rate,
    -- D-214 Fix 5 new columns
    confidence_pre_d214_fix, is_d214_quarantined, quarantine_reason
  ) VALUES (
    rec.player_name, rec.team, rec.opponent, rec.game_time, rec.game_date, rec.is_home,
    rec.prop_type, rec.line, rec.pick_side, rec.odds,
    rec.season_avg, rec.recent_avg, rec.floor_val, rec.ceiling_val,
    rec.l5_hit_count, rec.l10_hit_count, rec.season_hit_pct,
    rec.is_b2b, rec.rest_days, rec.minutes_l5_avg, rec.minutes_l10_avg, rec.minutes_trend,
    rec.opp_ppg_allowed,
    rec.score_l5, rec.score_l10, rec.score_season, rec.score_floor_ceiling, rec.score_recent_form,
    rec.score_home_away, rec.score_rest, rec.score_b2b, rec.score_minutes_trend, rec.score_pace,
    rec.score_opp_defense, rec.score_z_score, rec.score_role_change, rec.score_vig_filter,
    rec.score_usg_rate, rec.score_regression, rec.score_market_conf, rec.score_home_away_split,
    rec.score_minutes_floor, rec.score_consistency, rec.score_prop_type_penalty,
    rec.score_stale_data, rec.score_player_injury,
    rec.score_trivial_line_penalty, rec.score_trivial_line_cap,
    rec.score_minutes_volume, rec.score_minutes_stability,
    COALESCE(rec.score_low_min_risk, 0),
    COALESCE(rec.score_blowout_risk, 0),
    COALESCE(rec.score_line_movement, 0),
    COALESCE(rec.unbettable_juice_flag, FALSE),
    COALESCE(rec.is_secondary_market, FALSE),
    COALESCE(rec.coin_flip_flag, FALSE),
    COALESCE(rec.negative_stacking_flag, FALSE),
    COALESCE(rec.negative_factor_count, 0),
    rec.projected_stat, rec.stat_stdev, rec.z_score, rec.per_minute_rate, rec.projected_minutes,
    rec.teammate_injuries_count, rec.usage_boost,
    rec.confidence, rec.verdict, rec.ai_analysis,
    COALESCE(rec.source, 'process-games'), rec.recommendation_shown,
    COALESCE(rec.is_synthetic, false), COALESCE(rec.sport, 'nba'),
    rec.confidence_pre_tier_aware, rec.ai_verdict,
    rec.score_pitcher_k_rate, rec.score_pitcher_form, rec.score_opposing_lineup_k,
    rec.score_handedness_matchup, rec.score_pitch_count_trend, rec.score_rest_pitcher,
    rec.score_ballpark_factor, rec.score_weather_wind, rec.score_weather_temp,
    rec.score_umpire_k_zone, rec.score_lineup_consistency,
    rec.mlb_market_type,
    COALESCE(rec.is_mlb_beta, true),
    rec.mlb_beta_resolved_picks,
    rec.score_batter_hit_rate, rec.score_batter_form,
    rec.score_opposing_pitcher_quality, rec.score_recent_at_bats,
    rec.score_offense_differential, rec.score_pitching_matchup,
    rec.score_bullpen_strength, rec.score_recent_run_diff,
    rec.score_h2h_recent, rec.score_team_form,
    rec.score_batter_power_rate, rec.score_batter_form_power, rec.score_pitcher_hr_rate,
    rec.confidence_pre_d214_fix,
    COALESCE(rec.is_d214_quarantined, FALSE),
    rec.quarantine_reason
  )
  ON CONFLICT (player_name, prop_type, line, game_date) WHERE is_synthetic = false
  DO UPDATE SET
    team = EXCLUDED.team, opponent = EXCLUDED.opponent, game_time = EXCLUDED.game_time,
    is_home = EXCLUDED.is_home, pick_side = EXCLUDED.pick_side, odds = EXCLUDED.odds,
    season_avg = EXCLUDED.season_avg, recent_avg = EXCLUDED.recent_avg,
    floor_val = EXCLUDED.floor_val, ceiling_val = EXCLUDED.ceiling_val,
    l5_hit_count = EXCLUDED.l5_hit_count, l10_hit_count = EXCLUDED.l10_hit_count,
    season_hit_pct = EXCLUDED.season_hit_pct,
    is_b2b = EXCLUDED.is_b2b, rest_days = EXCLUDED.rest_days,
    minutes_l5_avg = EXCLUDED.minutes_l5_avg, minutes_l10_avg = EXCLUDED.minutes_l10_avg,
    minutes_trend = EXCLUDED.minutes_trend, opp_ppg_allowed = EXCLUDED.opp_ppg_allowed,
    score_l5 = EXCLUDED.score_l5, score_l10 = EXCLUDED.score_l10,
    score_season = EXCLUDED.score_season, score_floor_ceiling = EXCLUDED.score_floor_ceiling,
    score_recent_form = EXCLUDED.score_recent_form, score_home_away = EXCLUDED.score_home_away,
    score_rest = EXCLUDED.score_rest, score_b2b = EXCLUDED.score_b2b,
    score_minutes_trend = EXCLUDED.score_minutes_trend, score_pace = EXCLUDED.score_pace,
    score_opp_defense = EXCLUDED.score_opp_defense, score_z_score = EXCLUDED.score_z_score,
    score_role_change = EXCLUDED.score_role_change, score_vig_filter = EXCLUDED.score_vig_filter,
    score_usg_rate = EXCLUDED.score_usg_rate, score_regression = EXCLUDED.score_regression,
    score_market_conf = EXCLUDED.score_market_conf, score_home_away_split = EXCLUDED.score_home_away_split,
    score_minutes_floor = EXCLUDED.score_minutes_floor, score_consistency = EXCLUDED.score_consistency,
    score_prop_type_penalty = EXCLUDED.score_prop_type_penalty,
    score_stale_data = EXCLUDED.score_stale_data, score_player_injury = EXCLUDED.score_player_injury,
    score_trivial_line_penalty = EXCLUDED.score_trivial_line_penalty,
    score_trivial_line_cap = EXCLUDED.score_trivial_line_cap,
    score_minutes_volume = EXCLUDED.score_minutes_volume,
    score_minutes_stability = EXCLUDED.score_minutes_stability,
    score_low_min_risk = COALESCE(EXCLUDED.score_low_min_risk, pick_history.score_low_min_risk),
    score_blowout_risk = COALESCE(EXCLUDED.score_blowout_risk, pick_history.score_blowout_risk),
    score_line_movement = COALESCE(EXCLUDED.score_line_movement, pick_history.score_line_movement),
    unbettable_juice_flag = COALESCE(EXCLUDED.unbettable_juice_flag, pick_history.unbettable_juice_flag),
    is_secondary_market = COALESCE(EXCLUDED.is_secondary_market, pick_history.is_secondary_market),
    coin_flip_flag = COALESCE(EXCLUDED.coin_flip_flag, pick_history.coin_flip_flag),
    negative_stacking_flag = COALESCE(EXCLUDED.negative_stacking_flag, pick_history.negative_stacking_flag),
    negative_factor_count = COALESCE(EXCLUDED.negative_factor_count, pick_history.negative_factor_count),
    projected_stat = EXCLUDED.projected_stat, stat_stdev = EXCLUDED.stat_stdev,
    z_score = EXCLUDED.z_score, per_minute_rate = EXCLUDED.per_minute_rate,
    projected_minutes = EXCLUDED.projected_minutes,
    teammate_injuries_count = EXCLUDED.teammate_injuries_count,
    usage_boost = EXCLUDED.usage_boost,
    confidence = EXCLUDED.confidence, verdict = EXCLUDED.verdict,
    ai_analysis = EXCLUDED.ai_analysis, source = EXCLUDED.source,
    recommendation_shown = EXCLUDED.recommendation_shown, sport = EXCLUDED.sport,
    confidence_pre_tier_aware = COALESCE(EXCLUDED.confidence_pre_tier_aware, pick_history.confidence_pre_tier_aware),
    ai_verdict = COALESCE(EXCLUDED.ai_verdict, pick_history.ai_verdict),
    score_pitcher_k_rate = COALESCE(EXCLUDED.score_pitcher_k_rate, pick_history.score_pitcher_k_rate),
    score_pitcher_form = COALESCE(EXCLUDED.score_pitcher_form, pick_history.score_pitcher_form),
    score_opposing_lineup_k = COALESCE(EXCLUDED.score_opposing_lineup_k, pick_history.score_opposing_lineup_k),
    score_handedness_matchup = COALESCE(EXCLUDED.score_handedness_matchup, pick_history.score_handedness_matchup),
    score_pitch_count_trend = COALESCE(EXCLUDED.score_pitch_count_trend, pick_history.score_pitch_count_trend),
    score_rest_pitcher = COALESCE(EXCLUDED.score_rest_pitcher, pick_history.score_rest_pitcher),
    score_ballpark_factor = COALESCE(EXCLUDED.score_ballpark_factor, pick_history.score_ballpark_factor),
    score_weather_wind = COALESCE(EXCLUDED.score_weather_wind, pick_history.score_weather_wind),
    score_weather_temp = COALESCE(EXCLUDED.score_weather_temp, pick_history.score_weather_temp),
    score_umpire_k_zone = COALESCE(EXCLUDED.score_umpire_k_zone, pick_history.score_umpire_k_zone),
    score_lineup_consistency = COALESCE(EXCLUDED.score_lineup_consistency, pick_history.score_lineup_consistency),
    mlb_market_type = COALESCE(EXCLUDED.mlb_market_type, pick_history.mlb_market_type),
    is_mlb_beta = COALESCE(EXCLUDED.is_mlb_beta, pick_history.is_mlb_beta),
    mlb_beta_resolved_picks = COALESCE(EXCLUDED.mlb_beta_resolved_picks, pick_history.mlb_beta_resolved_picks),
    score_batter_hit_rate = COALESCE(EXCLUDED.score_batter_hit_rate, pick_history.score_batter_hit_rate),
    score_batter_form = COALESCE(EXCLUDED.score_batter_form, pick_history.score_batter_form),
    score_opposing_pitcher_quality = COALESCE(EXCLUDED.score_opposing_pitcher_quality, pick_history.score_opposing_pitcher_quality),
    score_recent_at_bats = COALESCE(EXCLUDED.score_recent_at_bats, pick_history.score_recent_at_bats),
    score_offense_differential = COALESCE(EXCLUDED.score_offense_differential, pick_history.score_offense_differential),
    score_pitching_matchup = COALESCE(EXCLUDED.score_pitching_matchup, pick_history.score_pitching_matchup),
    score_bullpen_strength = COALESCE(EXCLUDED.score_bullpen_strength, pick_history.score_bullpen_strength),
    score_recent_run_diff = COALESCE(EXCLUDED.score_recent_run_diff, pick_history.score_recent_run_diff),
    score_h2h_recent = COALESCE(EXCLUDED.score_h2h_recent, pick_history.score_h2h_recent),
    score_team_form = COALESCE(EXCLUDED.score_team_form, pick_history.score_team_form),
    score_batter_power_rate = COALESCE(EXCLUDED.score_batter_power_rate, pick_history.score_batter_power_rate),
    score_batter_form_power = COALESCE(EXCLUDED.score_batter_form_power, pick_history.score_batter_form_power),
    score_pitcher_hr_rate = COALESCE(EXCLUDED.score_pitcher_hr_rate, pick_history.score_pitcher_hr_rate),
    -- D-214 Fix 5 — COALESCE preserves quarantine fields on rescore (rescore writers omit these)
    confidence_pre_d214_fix = COALESCE(EXCLUDED.confidence_pre_d214_fix, pick_history.confidence_pre_d214_fix),
    is_d214_quarantined = COALESCE(EXCLUDED.is_d214_quarantined, pick_history.is_d214_quarantined),
    quarantine_reason = COALESCE(EXCLUDED.quarantine_reason, pick_history.quarantine_reason)
  RETURNING id INTO result_id;

  RETURN result_id;
END;
$$;

-- Quarantine today's MLB Beta picks. Preserves pre-fix confidence in
-- confidence_pre_d214_fix for audit. The next process-games-mlb cron
-- tick will rescore with full cache data via upsert_pick_history,
-- updating confidence in-place; is_d214_quarantined stays TRUE as
-- audit trail so Beta calibration excludes these from rolling-30d
-- baseline calcs.
UPDATE public.pick_history
SET
  confidence_pre_d214_fix = confidence,
  is_d214_quarantined = TRUE,
  quarantine_reason = 'D-214 cache infrastructure failure — picks generated against degraded MLB factor data 2026-05-17'
WHERE sport = 'mlb'
  AND source = 'process-games-mlb'
  AND game_date = '20260517'
  AND is_mlb_beta = TRUE
  AND is_d214_quarantined IS DISTINCT FROM TRUE;

DO $$
DECLARE
  q_count INT;
BEGIN
  SELECT COUNT(*) INTO q_count FROM public.pick_history
    WHERE is_d214_quarantined = TRUE;
  RAISE NOTICE 'D-214 Fix 5 VERIFY: % picks quarantined', q_count;
END $$;

COMMIT;
