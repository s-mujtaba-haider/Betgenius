-- D-406 SHIP 1 — add confidence_pre_cap column + update upsert RPC to persist it.
--
-- WHY: D-405 SHIP 1 identified the D-140 trivial-line cap (scoring_mlb_v2.ts:1544
-- for MLB batter, :521 for pitcher_k; scoring.ts:1144 Layer 2 for NBA) as a
-- structural compression that snaps conf >65 to exactly 65 on HR-OVER picks.
-- The data needed to validate cap-modification proposals exists only at scoring
-- time — once written to pick_history, the post-cap confidence is the only
-- signal. The pre-cap value is lost.
--
-- This migration adds a `confidence_pre_cap` NUMERIC column to pick_history.
-- SHIP 2 of D-406 will modify the scoring functions to capture confidence
-- BEFORE the D-140 cap fires and pass it through the existing upsert_pick_history
-- RPC payload. Existing rows have confidence_pre_cap = NULL (not backfilled —
-- the pre-cap value cannot be reconstructed from stored data for pre-D-379
-- picks because their breakdown JSONB is NULL).
--
-- For MLB: confidence_pre_cap = the value of `confidence` immediately before
-- the D-140 cap check at line 521 (pitcher_k) and 1544 (batter market). For
-- game-side / game-total markets the cap doesn't fire (no `line<=0.5` predicate
-- match), so confidence_pre_cap = confidence.
--
-- For NBA: confidence_pre_cap = the value of `finalScore` immediately before
-- the Layer-2 D-140 cap at scoring.ts:1144. The Layer-1 cap (calculateConfidenceScore
-- line 911) fires earlier in the pipeline; its effect is INCLUDED in the captured
-- value (post-Layer-1, pre-Layer-2). This is the meaningful "pre-cap" because
-- Layer 2 is what fires on the suppressed HR-OVER pattern. Full Layer-1+Layer-2
-- cap-free tracking would require parallel-track refactoring of scoreOneSide and
-- is deferred to a separate D-batch if the NBA cap is empirically problematic.
--
-- NO scoring math changes. Pure additive instrumentation. Final confidence
-- column behavior is byte-identical to pre-D-406.
--
-- ROLLBACK:
--   1. Re-apply 20260531000006_d379_breakdown_column.sql (recreates upsert RPC
--      without the confidence_pre_cap column).
--   2. ALTER TABLE pick_history DROP COLUMN IF EXISTS confidence_pre_cap;

BEGIN;

-- 1) Add the column (idempotent).
ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS confidence_pre_cap NUMERIC;

COMMENT ON COLUMN public.pick_history.confidence_pre_cap IS
'D-406: pre-cap confidence captured at scoring time, BEFORE the D-140 trivial-line
cap (scoring_mlb_v2.ts:521 pitcher_k; :1544 batter market; scoring.ts:1144 NBA
Layer 2) and any subsequent clamp. For markets where the cap doesn''t fire (no
line<=0.5 predicate match), equals confidence. NULL for pre-D-406 rows
(unreconstructable). Used by D-405 follow-up analyses to identify cap-suppressed
picks without lossy back-computation.';

-- 2) Regenerate upsert_pick_history RPC with confidence_pre_cap added.
-- Diff vs 20260531000006: added confidence_pre_cap to INSERT columns + VALUES
-- + ON CONFLICT DO UPDATE SET.
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
    -- D-406 SHIP 1 — persist pre-cap confidence for cap-modification analysis.
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
    rec.mlb_market_type, COALESCE(rec.is_mlb_beta, FALSE), COALESCE(rec.mlb_beta_resolved_picks, 0),
    rec.breakdown,
    rec.confidence_pre_cap
  )
  ON CONFLICT (player_name, prop_type, line, pick_side, game_time) DO UPDATE SET
    odds = EXCLUDED.odds,
    confidence = EXCLUDED.confidence,
    verdict = EXCLUDED.verdict,
    ai_analysis = EXCLUDED.ai_analysis,
    confidence_pre_tier_aware = EXCLUDED.confidence_pre_tier_aware,
    ai_verdict = EXCLUDED.ai_verdict,
    breakdown = EXCLUDED.breakdown,
    confidence_pre_cap = EXCLUDED.confidence_pre_cap
  RETURNING id INTO result_id;

  RETURN result_id;
END $$;

GRANT EXECUTE ON FUNCTION public.upsert_pick_history(JSONB) TO service_role, authenticated;

COMMENT ON FUNCTION public.upsert_pick_history(JSONB) IS
'D-406 SHIP 1 — extends D-379 with confidence_pre_cap column. Captures
pre-D-140-cap confidence at scoring time to enable cap-modification analysis
without lossy reconstruction.';

COMMIT;
