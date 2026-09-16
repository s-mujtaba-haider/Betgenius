-- D-446 — URGENT FIX: restore correct ON CONFLICT clause on upsert_pick_history
-- while preserving the D-406 confidence_pre_cap column additions.
--
-- ROOT CAUSE (per d440_live_verification.md):
-- D-379 SHIP 2's INITIAL migration (20260531000006, in git) created
-- upsert_pick_history with WRONG ON CONFLICT:
--   (player_name, prop_type, line, pick_side, game_time)
-- which matches no unique constraint on pick_history. Same-day FIX
-- migration 20260531000007_d379_fix_upsert_rpc.sql corrected to:
--   (player_name, prop_type, line, game_date) WHERE is_synthetic = false
-- and was APPLIED to live DB but NEVER COMMITTED to git.
--
-- D-406 SHIP 1 (2026-06-04) read 20260531000006 from git as template,
-- added confidence_pre_cap to INSERT VALUES + DO UPDATE SET, but PRESERVED
-- its WRONG ON CONFLICT clause. The new RPC applied cleanly (CREATE OR
-- REPLACE FUNCTION succeeds at SQL-parse time) but every INSERT fails at
-- RUNTIME with Postgres error 42P10:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Impact (D-440 audit): 9,781 rpc_failed errors over 17h, 0 post-deploy
-- pick_history rows, 605 rec_cache rows (rec_cache write path unaffected),
-- silent loss of MLB pick_history audit data, breakdown JSONB, and
-- confidence_pre_cap values.
--
-- THIS MIGRATION:
-- 1. Regenerates upsert_pick_history with the CORRECT ON CONFLICT clause
--    (matching the existing partial unique index pick_history_production_natural_uniq
--    per D-390 / migration 20260506000003).
-- 2. PRESERVES the D-406 confidence_pre_cap column in INSERT columns + VALUES
--    + DO UPDATE SET (with COALESCE so prior values aren't clobbered).
-- 3. PRESERVES the D-379 breakdown column in INSERT + DO UPDATE SET.
-- 4. Faithfully ports the D-204 DO UPDATE SET clauses (matches the
--    20260531000007_d379_fix_upsert_rpc.sql shape; only delta vs that
--    migration is the confidence_pre_cap column in INSERT VALUES + DO UPDATE).
--
-- NO column changes. NO schema changes. The confidence_pre_cap column
-- (added by 20260604000001_d406_confidence_pre_cap.sql) is preserved.
--
-- VERIFICATION (per D-446 SHIP 2):
-- - error_log rpc_failed count drops to ~0 on next cron tick
-- - new pick_history rows accumulate post-fix
-- - confidence_pre_cap populates on those rows
-- - breakdown JSONB has ~68 keys on those rows
-- - rec_cache write path unchanged (was always working)
--
-- ROLLBACK:
-- Reapply 20260604000001_d406_confidence_pre_cap.sql (the broken version).
-- This restores 42P10 failures. Only roll back if THIS migration introduces
-- a new failure mode.

BEGIN;

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
    confidence_pre_tier_aware,
    ai_verdict,
    score_pitcher_k_rate, score_pitcher_form, score_opposing_lineup_k,
    score_handedness_matchup, score_pitch_count_trend, score_rest_pitcher,
    score_ballpark_factor, score_weather_wind, score_weather_temp,
    score_umpire_k_zone, score_lineup_consistency,
    mlb_market_type, is_mlb_beta, mlb_beta_resolved_picks,
    breakdown,
    -- D-446: preserve D-406 confidence_pre_cap column.
    confidence_pre_cap
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
    COALESCE(rec.is_synthetic, FALSE), COALESCE(rec.sport, 'nba'),
    rec.confidence_pre_tier_aware,
    rec.ai_verdict,
    rec.score_pitcher_k_rate, rec.score_pitcher_form, rec.score_opposing_lineup_k,
    rec.score_handedness_matchup, rec.score_pitch_count_trend, rec.score_rest_pitcher,
    rec.score_ballpark_factor, rec.score_weather_wind, rec.score_weather_temp,
    rec.score_umpire_k_zone, rec.score_lineup_consistency,
    rec.mlb_market_type, COALESCE(rec.is_mlb_beta, TRUE), COALESCE(rec.mlb_beta_resolved_picks, 0),
    rec.breakdown,
    rec.confidence_pre_cap
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
    -- D-379 NEW
    breakdown = COALESCE(EXCLUDED.breakdown, pick_history.breakdown),
    -- D-446: preserve D-406 confidence_pre_cap on UPDATE path.
    confidence_pre_cap = COALESCE(EXCLUDED.confidence_pre_cap, pick_history.confidence_pre_cap)
  RETURNING id INTO result_id;

  RETURN result_id;
END $$;

GRANT EXECUTE ON FUNCTION public.upsert_pick_history(JSONB) TO service_role, authenticated;

COMMENT ON FUNCTION public.upsert_pick_history(JSONB) IS
'D-446 (2026-06-04 evening) — restores correct ON CONFLICT clause
(player_name, prop_type, line, game_date) WHERE is_synthetic = false
that was broken by the D-406 migration (20260604000001) which read the
in-git but-broken 20260531000006 as template, missing the never-committed
fix migration 20260531000007. Preserves D-204 DO UPDATE SET clauses +
D-379 breakdown column + D-406 confidence_pre_cap column. See
docs/loop/reports/d440_live_verification.md for root cause and
docs/loop/reports/d446_migration_built.md for fix details.';

COMMIT;
