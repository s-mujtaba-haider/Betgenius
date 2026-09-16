-- D-379 SHIP 2 — persist per-factor breakdown on live MLB picks.
--
-- WHY: production MLB picks have ai_analysis as plain text (Sonnet narrative)
-- with NO factor_breakdown nested JSON. The d366/d372/d376 optimizer MV expects
-- per-factor scores extractable as `ai_analysis::jsonb -> 'factor_breakdown'`
-- — which fails on plain text. Synthetic backfills work because d359-mint-props
-- writes ai_analysis as a JSON string containing factor_breakdown.
--
-- FIX: add a dedicated `breakdown` JSONB column to pick_history. Update
-- upsert_pick_history RPC to write it. Process-games-mlb's 3 hist_payload
-- writers will pass `breakdown: result.breakdown` (separate edit). The
-- d366_factor_scores MV is refreshed to read from breakdown column first
-- with COALESCE fallback to ai_analysis.factor_breakdown for synthetic rows.
--
-- ROLLBACK:
--   1. DROP MATERIALIZED VIEW IF EXISTS public.d366_factor_scores;
--      then re-apply 20260530000001_d372_refresh_mv_and_split.sql (recreates
--      the original MV without the breakdown column).
--   2. ALTER FUNCTION upsert_pick_history → drop the breakdown column from
--      INSERT VALUES list (re-apply 20260517000015_d204_upsert_pick_history_with_mlb.sql).
--   3. ALTER TABLE public.pick_history DROP COLUMN IF EXISTS breakdown;

BEGIN;

-- 1) Add the breakdown column (idempotent)
ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS breakdown JSONB;

COMMENT ON COLUMN public.pick_history.breakdown IS
'D-379: per-factor scoring breakdown JSONB. Populated on live picks by
process-games-mlb (from result.breakdown). Synthetic backfills continue
to embed factor_breakdown inside ai_analysis as JSON. The d366_factor_scores
MV COALESCEs across both sources.';

-- 2) Regenerate upsert_pick_history with breakdown column added.
--    Diff vs 20260517000015 (D-204): added `breakdown` to INSERT column list
--    + VALUES + DO UPDATE SET.
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
    -- D-379 SHIP 2 — persist per-factor breakdown on live writes
    breakdown
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
    rec.breakdown
  )
  ON CONFLICT (player_name, prop_type, line, pick_side, game_time) DO UPDATE SET
    odds = EXCLUDED.odds,
    confidence = EXCLUDED.confidence,
    verdict = EXCLUDED.verdict,
    ai_analysis = EXCLUDED.ai_analysis,
    confidence_pre_tier_aware = EXCLUDED.confidence_pre_tier_aware,
    ai_verdict = EXCLUDED.ai_verdict,
    breakdown = EXCLUDED.breakdown
  RETURNING id INTO result_id;

  RETURN result_id;
END $$;

GRANT EXECUTE ON FUNCTION public.upsert_pick_history(JSONB) TO service_role, authenticated;

COMMENT ON FUNCTION public.upsert_pick_history(JSONB) IS
'D-379 SHIP 2 — regenerated to include `breakdown` JSONB column. Live picks
from process-games-mlb pass result.breakdown via the payload; the column
now persists it. Synthetic mints continue to embed factor_breakdown inside
ai_analysis. The d366_factor_scores MV COALESCEs across both sources.';

-- 3) Refresh d366_factor_scores MV to read from breakdown column first,
--    fall back to ai_analysis.factor_breakdown for synthetic legacy rows.
DROP MATERIALIZED VIEW IF EXISTS public.d366_factor_scores;

CREATE MATERIALIZED VIEW public.d366_factor_scores AS
SELECT
  id, prop_type, confidence::numeric AS confidence, hit, backfill_run_id,

  -- 13 D-362 score columns (COALESCE: breakdown column → ai_analysis.factor_breakdown → 0)
  COALESCE(NULLIF(breakdown ->> 'score_pitcher_xera_edge', '')::numeric,           (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_xera_edge')::numeric, 0) AS s_pitcher_xera_edge,
  COALESCE(NULLIF(breakdown ->> 'score_pitcher_baa', '')::numeric,                  (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_baa')::numeric, 0) AS s_pitcher_baa,
  COALESCE(NULLIF(breakdown ->> 'score_catcher_framing', '')::numeric,              (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_catcher_framing')::numeric, 0) AS s_catcher_framing,
  COALESCE(NULLIF(breakdown ->> 'score_pitcher_pitch_mix_k', '')::numeric,          (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_pitch_mix_k')::numeric, 0) AS s_pitcher_pitch_mix_k,
  COALESCE(NULLIF(breakdown ->> 'score_batter_xba', '')::numeric,                   (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_xba')::numeric, 0) AS s_batter_xba,
  COALESCE(NULLIF(breakdown ->> 'score_batter_exit_velo_trend', '')::numeric,       (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_exit_velo_trend')::numeric, 0) AS s_batter_exit_velo_trend,
  COALESCE(NULLIF(breakdown ->> 'score_batter_barrel_rate', '')::numeric,           (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_barrel_rate')::numeric, 0) AS s_batter_barrel_rate,
  COALESCE(NULLIF(breakdown ->> 'score_batter_xslg_regression', '')::numeric,       (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_xslg_regression')::numeric, 0) AS s_batter_xslg_regression,
  COALESCE(NULLIF(breakdown ->> 'score_batter_babip', '')::numeric,                 (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_babip')::numeric, 0) AS s_batter_babip,
  COALESCE(NULLIF(breakdown ->> 'score_batter_vs_pitcher_hand_split', '')::numeric, (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_vs_pitcher_hand_split')::numeric, 0) AS s_batter_vs_pitcher_hand_split,
  COALESCE(NULLIF(breakdown ->> 'score_bullpen_quality', '')::numeric,              (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_bullpen_quality')::numeric, 0) AS s_bullpen_quality,
  COALESCE(NULLIF(breakdown ->> 'score_wind_direction_hr', '')::numeric,            (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_wind_direction_hr')::numeric, 0) AS s_wind_direction_hr,
  COALESCE(NULLIF(breakdown ->> 'score_pitcher_hr_per_9', '')::numeric,             (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_hr_per_9')::numeric, 0) AS s_pitcher_hr_per_9,

  -- 25 D-340 unique score columns
  COALESCE(NULLIF(breakdown ->> 'score_pitcher_k_rate', '')::numeric,               (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_k_rate')::numeric, 0) AS s_pitcher_k_rate,
  COALESCE(NULLIF(breakdown ->> 'score_pitcher_form', '')::numeric,                 (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_form')::numeric, 0) AS s_pitcher_form,
  COALESCE(NULLIF(breakdown ->> 'score_opposing_lineup_k', '')::numeric,            (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_opposing_lineup_k')::numeric, 0) AS s_opposing_lineup_k,
  COALESCE(NULLIF(breakdown ->> 'score_pitch_count_trend', '')::numeric,            (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitch_count_trend')::numeric, 0) AS s_pitch_count_trend,
  COALESCE(NULLIF(breakdown ->> 'score_rest_pitcher', '')::numeric,                 (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_rest_pitcher')::numeric, 0) AS s_rest_pitcher,
  COALESCE(NULLIF(breakdown ->> 'score_handedness_matchup', '')::numeric,           (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_handedness_matchup')::numeric, 0) AS s_handedness_matchup,
  COALESCE(NULLIF(breakdown ->> 'score_ballpark_factor', '')::numeric,              (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_ballpark_factor')::numeric, 0) AS s_ballpark_factor,
  COALESCE(NULLIF(breakdown ->> 'score_weather_wind', '')::numeric,                 (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_weather_wind')::numeric, 0) AS s_weather_wind,
  COALESCE(NULLIF(breakdown ->> 'score_weather_temp', '')::numeric,                 (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_weather_temp')::numeric, 0) AS s_weather_temp,
  COALESCE(NULLIF(breakdown ->> 'score_umpire_k_zone', '')::numeric,                (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_umpire_k_zone')::numeric, 0) AS s_umpire_k_zone,
  COALESCE(NULLIF(breakdown ->> 'score_batter_hit_rate', '')::numeric,              (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_hit_rate')::numeric, 0) AS s_batter_hit_rate,
  COALESCE(NULLIF(breakdown ->> 'score_batter_form', '')::numeric,                  (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_form')::numeric, 0) AS s_batter_form,
  COALESCE(NULLIF(breakdown ->> 'score_opposing_pitcher_quality', '')::numeric,     (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_opposing_pitcher_quality')::numeric, 0) AS s_opposing_pitcher_quality,
  COALESCE(NULLIF(breakdown ->> 'score_recent_at_bats', '')::numeric,               (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_recent_at_bats')::numeric, 0) AS s_recent_at_bats,
  COALESCE(NULLIF(breakdown ->> 'score_lineup_consistency', '')::numeric,           (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_lineup_consistency')::numeric, 0) AS s_lineup_consistency,
  COALESCE(NULLIF(breakdown ->> 'score_batter_power_rate', '')::numeric,            (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_power_rate')::numeric, 0) AS s_batter_power_rate,
  COALESCE(NULLIF(breakdown ->> 'score_batter_form_power', '')::numeric,            (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_batter_form_power')::numeric, 0) AS s_batter_form_power,
  COALESCE(NULLIF(breakdown ->> 'score_pitcher_hr_rate', '')::numeric,              (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitcher_hr_rate')::numeric, 0) AS s_pitcher_hr_rate,
  COALESCE(NULLIF(breakdown ->> 'score_offense_differential', '')::numeric,         (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_offense_differential')::numeric, 0) AS s_offense_differential,
  COALESCE(NULLIF(breakdown ->> 'score_pitching_matchup', '')::numeric,             (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_pitching_matchup')::numeric, 0) AS s_pitching_matchup,
  COALESCE(NULLIF(breakdown ->> 'score_bullpen_strength', '')::numeric,             (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_bullpen_strength')::numeric, 0) AS s_bullpen_strength,
  COALESCE(NULLIF(breakdown ->> 'score_recent_run_diff', '')::numeric,              (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_recent_run_diff')::numeric, 0) AS s_recent_run_diff,
  COALESCE(NULLIF(breakdown ->> 'score_h2h_recent', '')::numeric,                   (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_h2h_recent')::numeric, 0) AS s_h2h_recent,
  COALESCE(NULLIF(breakdown ->> 'score_team_form', '')::numeric,                    (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_team_form')::numeric, 0) AS s_team_form,
  COALESCE(NULLIF(breakdown ->> 'score_lineup_vs_hand_split', '')::numeric,         (ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_lineup_vs_hand_split')::numeric, 0) AS s_lineup_vs_hand_split,

  -- D-376 fraw columns (added in 20260531000005)
  COALESCE(NULLIF(breakdown ->> 'fraw_weather_wind', '')::numeric,         (ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_weather_wind')::numeric, 0) AS f_weather_wind,
  COALESCE(NULLIF(breakdown ->> 'fraw_wind_direction_hr', '')::numeric,    (ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_wind_direction_hr')::numeric, 0) AS f_wind_direction_hr,
  COALESCE(NULLIF(breakdown ->> 'fraw_pitcher_hr_per_9', '')::numeric,     (ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_pitcher_hr_per_9')::numeric, 0) AS f_pitcher_hr_per_9,
  COALESCE(NULLIF(breakdown ->> 'fraw_offense_differential', '')::numeric, (ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_offense_differential')::numeric, 0) AS f_offense_differential

FROM public.pick_history
WHERE backfill_run_id IN (
  '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f',  -- D-358
  '949a88e7-1c20-43e9-a674-ef90e9035f8b',  -- D-359
  'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef',  -- D-360-FIX
  '61ff4c15-4678-4691-865c-264712fed0ca',  -- D-363
  '75bb70d1-6578-4c1f-a637-6f20ea158ce3'   -- D-368
)
  AND hit IS NOT NULL
  AND ai_analysis IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_d366_fs_run_id    ON public.d366_factor_scores (backfill_run_id);
CREATE INDEX IF NOT EXISTS idx_d366_fs_prop_type ON public.d366_factor_scores (prop_type);
GRANT SELECT ON public.d366_factor_scores TO service_role, authenticated;

COMMIT;
