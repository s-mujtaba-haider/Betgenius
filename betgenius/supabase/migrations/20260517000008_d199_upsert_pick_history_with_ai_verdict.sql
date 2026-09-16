-- D-199 — regenerate upsert_pick_history RPC to include ai_verdict column.
-- §1.17 audit on the RPC writer path.
--
-- Behavior preservation:
--   - ai_verdict is NULLable; existing callers that omit the field write NULL
--     (correct for current write path until process-games/analyze-pick are
--     updated to send parsed verdict; D-199 SQL backfill catches historical).
--   - DO UPDATE SET uses COALESCE(EXCLUDED.ai_verdict, pick_history.ai_verdict)
--     to preserve prior value when caller omits (mirrors D-177-B pattern).
--
-- Rollback: re-apply migration 20260517000005_d198_upsert_pick_history_with_tier_aware.sql.

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
    -- D-199 (Batch 2 Task 2.1): structured AI verdict.
    ai_verdict
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
    rec.confidence_pre_tier_aware,
    rec.ai_verdict
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
    -- D-199 COALESCE preserves prior verdict when caller omits.
    ai_verdict = COALESCE(EXCLUDED.ai_verdict, pick_history.ai_verdict)
  RETURNING id INTO result_id;

  RETURN result_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_pick_history(JSONB) IS
  'D-199 (May 17 2026): extends D-198 with ai_verdict column. NULLable TEXT; COALESCE on DO UPDATE preserves prior value when caller omits.';

COMMIT;
