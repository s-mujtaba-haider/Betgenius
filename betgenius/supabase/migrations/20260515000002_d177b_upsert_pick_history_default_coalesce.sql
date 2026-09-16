-- D-177-B — upsert_pick_history RPC NULL-on-NOT-NULL-with-default fix
--
-- Discovered during D-177-A live smoke test (May 15-16, 2026). When a caller's
-- payload omits one of the columns added in D-164/D-165/D-166/D-167
-- (unbettable_juice_flag, is_secondary_market, coin_flip_flag,
-- negative_stacking_flag, negative_factor_count), jsonb_populate_record
-- populates `rec.column` as NULL even though the column has
-- `NOT NULL DEFAULT FALSE/0`.
--
-- The D-172a RPC's INSERT explicit column list includes these new columns
-- referencing `rec.column`, so the NULL flows through and the INSERT fails
-- with 23502 (null_value_in_not_null_violating_constraint).
--
-- Direct PostgREST POSTs (which OMIT the column from the JSON entirely)
-- correctly trigger the column DEFAULT — proved by smoke test. The bug is
-- specific to the RPC path: rec.X is always populated (as NULL) regardless
-- of payload, and the explicit column list propagates that NULL.
--
-- Fix: COALESCE every NOT-NULL-DEFAULT column in both INSERT VALUES and
-- DO UPDATE SET. is_secondary_market in particular is intentionally
-- trigger-maintained (D-165), so callers never send it; COALESCE preserves
-- the trigger's value on UPDATE and the column default on INSERT.
--
-- Affected columns wrapped with COALESCE:
--   is_secondary_market     COALESCE → FALSE   (trigger-maintained anyway)
--   unbettable_juice_flag   COALESCE → FALSE
--   coin_flip_flag          COALESCE → FALSE
--   negative_stacking_flag  COALESCE → FALSE
--   negative_factor_count   COALESCE → 0
--
-- For DO UPDATE SET on is_secondary_market: use `pick_history.is_secondary_market`
-- (preserve existing value if EXCLUDED is NULL). This keeps the trigger-set
-- value across re-upserts that don't carry the flag.
--
-- Rollback: re-run D-172a's RPC body (rollback removes the COALESCE wrappers).

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
    is_synthetic, sport
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
    -- D-177-B: COALESCE the new May-13/14 NOT-NULL-DEFAULT columns so that
    -- payloads omitting them fall back to defaults (FALSE/0) rather than
    -- failing the INSERT with 23502.
    rec.score_low_min_risk, rec.score_blowout_risk, rec.score_line_movement,
    COALESCE(rec.unbettable_juice_flag, FALSE),
    COALESCE(rec.is_secondary_market, FALSE),
    COALESCE(rec.coin_flip_flag, FALSE),
    COALESCE(rec.negative_stacking_flag, FALSE),
    COALESCE(rec.negative_factor_count, 0),
    rec.projected_stat, rec.stat_stdev, rec.z_score, rec.per_minute_rate, rec.projected_minutes,
    rec.teammate_injuries_count, rec.usage_boost,
    rec.confidence, rec.verdict, rec.ai_analysis,
    COALESCE(rec.source, 'process-games'), rec.recommendation_shown,
    COALESCE(rec.is_synthetic, false), COALESCE(rec.sport, 'nba')
  )
  ON CONFLICT (player_name, prop_type, line, game_date) WHERE is_synthetic = false
  DO UPDATE SET
    team = EXCLUDED.team,
    opponent = EXCLUDED.opponent,
    game_time = EXCLUDED.game_time,
    is_home = EXCLUDED.is_home,
    pick_side = EXCLUDED.pick_side,
    odds = EXCLUDED.odds,
    season_avg = EXCLUDED.season_avg,
    recent_avg = EXCLUDED.recent_avg,
    floor_val = EXCLUDED.floor_val,
    ceiling_val = EXCLUDED.ceiling_val,
    l5_hit_count = EXCLUDED.l5_hit_count,
    l10_hit_count = EXCLUDED.l10_hit_count,
    season_hit_pct = EXCLUDED.season_hit_pct,
    is_b2b = EXCLUDED.is_b2b,
    rest_days = EXCLUDED.rest_days,
    minutes_l5_avg = EXCLUDED.minutes_l5_avg,
    minutes_l10_avg = EXCLUDED.minutes_l10_avg,
    minutes_trend = EXCLUDED.minutes_trend,
    opp_ppg_allowed = EXCLUDED.opp_ppg_allowed,
    score_l5 = EXCLUDED.score_l5,
    score_l10 = EXCLUDED.score_l10,
    score_season = EXCLUDED.score_season,
    score_floor_ceiling = EXCLUDED.score_floor_ceiling,
    score_recent_form = EXCLUDED.score_recent_form,
    score_home_away = EXCLUDED.score_home_away,
    score_rest = EXCLUDED.score_rest,
    score_b2b = EXCLUDED.score_b2b,
    score_minutes_trend = EXCLUDED.score_minutes_trend,
    score_pace = EXCLUDED.score_pace,
    score_opp_defense = EXCLUDED.score_opp_defense,
    score_z_score = EXCLUDED.score_z_score,
    score_role_change = EXCLUDED.score_role_change,
    score_vig_filter = EXCLUDED.score_vig_filter,
    score_usg_rate = EXCLUDED.score_usg_rate,
    score_regression = EXCLUDED.score_regression,
    score_market_conf = EXCLUDED.score_market_conf,
    score_home_away_split = EXCLUDED.score_home_away_split,
    score_minutes_floor = EXCLUDED.score_minutes_floor,
    score_consistency = EXCLUDED.score_consistency,
    score_prop_type_penalty = EXCLUDED.score_prop_type_penalty,
    score_stale_data = EXCLUDED.score_stale_data,
    score_player_injury = EXCLUDED.score_player_injury,
    score_trivial_line_penalty = EXCLUDED.score_trivial_line_penalty,
    score_trivial_line_cap = EXCLUDED.score_trivial_line_cap,
    score_minutes_volume = EXCLUDED.score_minutes_volume,
    score_minutes_stability = EXCLUDED.score_minutes_stability,
    score_low_min_risk = EXCLUDED.score_low_min_risk,
    score_blowout_risk = EXCLUDED.score_blowout_risk,
    score_line_movement = EXCLUDED.score_line_movement,
    -- D-177-B: COALESCE the EXCLUDED value with the existing row's value, so
    -- payloads that omit the flag preserve what's already in the row (which
    -- for is_secondary_market is the D-165 trigger-maintained value).
    unbettable_juice_flag = COALESCE(EXCLUDED.unbettable_juice_flag, pick_history.unbettable_juice_flag),
    is_secondary_market = COALESCE(EXCLUDED.is_secondary_market, pick_history.is_secondary_market),
    coin_flip_flag = COALESCE(EXCLUDED.coin_flip_flag, pick_history.coin_flip_flag),
    negative_stacking_flag = COALESCE(EXCLUDED.negative_stacking_flag, pick_history.negative_stacking_flag),
    negative_factor_count = COALESCE(EXCLUDED.negative_factor_count, pick_history.negative_factor_count),
    projected_stat = EXCLUDED.projected_stat,
    stat_stdev = EXCLUDED.stat_stdev,
    z_score = EXCLUDED.z_score,
    per_minute_rate = EXCLUDED.per_minute_rate,
    projected_minutes = EXCLUDED.projected_minutes,
    teammate_injuries_count = EXCLUDED.teammate_injuries_count,
    usage_boost = EXCLUDED.usage_boost,
    confidence = EXCLUDED.confidence,
    verdict = EXCLUDED.verdict,
    ai_analysis = EXCLUDED.ai_analysis,
    source = EXCLUDED.source,
    recommendation_shown = EXCLUDED.recommendation_shown,
    sport = EXCLUDED.sport
  RETURNING id INTO result_id;

  RETURN result_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_pick_history(JSONB) IS
  'D-177-B (May 15-16 2026): COALESCE the May-13/14 NOT-NULL-DEFAULT flag/count columns so payloads omitting them fall back to defaults rather than 23502. is_secondary_market in particular is D-165 trigger-maintained — callers never send it, COALESCE preserves the trigger value. Builds on D-172a (full column set).';

COMMIT;
