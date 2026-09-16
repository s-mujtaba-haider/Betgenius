-- D-532 SHIP 2 — Build the REAL training corpus MV (organic process-games-mlb
-- resolved picks). Parallel to d366_factor_scores; same schema for compat.
--
-- Source rows: pick_history WHERE is_synthetic=false AND sport='mlb'
--              AND voided IS NOT TRUE AND hit IS NOT NULL AND breakdown IS NOT NULL
-- Score extraction: from `breakdown ->> 'score_*'` (NOT
-- `ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_*'` — that path is
-- synth-only because organic ai_analysis is Sonnet prose text, while
-- post-D-379 organic breakdown JSONB holds the score_* keys directly).
--
-- Rollback: DROP MATERIALIZED VIEW IF EXISTS public.d532_factor_scores_real;
DROP MATERIALIZED VIEW IF EXISTS public.d532_factor_scores_real;

CREATE MATERIALIZED VIEW public.d532_factor_scores_real AS
SELECT
  id, prop_type, mlb_market_type,
  confidence::numeric AS confidence, hit, game_date,

  -- 13 D-362 score columns (extracted from breakdown JSONB)
  COALESCE((breakdown ->> 'score_pitcher_xera_edge')::numeric, 0)           AS s_pitcher_xera_edge,
  COALESCE((breakdown ->> 'score_pitcher_baa')::numeric, 0)                  AS s_pitcher_baa,
  COALESCE((breakdown ->> 'score_catcher_framing')::numeric, 0)              AS s_catcher_framing,
  COALESCE((breakdown ->> 'score_pitcher_pitch_mix_k')::numeric, 0)          AS s_pitcher_pitch_mix_k,
  COALESCE((breakdown ->> 'score_batter_xba')::numeric, 0)                   AS s_batter_xba,
  COALESCE((breakdown ->> 'score_batter_exit_velo_trend')::numeric, 0)       AS s_batter_exit_velo_trend,
  COALESCE((breakdown ->> 'score_batter_barrel_rate')::numeric, 0)           AS s_batter_barrel_rate,
  COALESCE((breakdown ->> 'score_batter_xslg_regression')::numeric, 0)       AS s_batter_xslg_regression,
  COALESCE((breakdown ->> 'score_batter_babip')::numeric, 0)                 AS s_batter_babip,
  COALESCE((breakdown ->> 'score_batter_vs_pitcher_hand_split')::numeric, 0) AS s_batter_vs_pitcher_hand_split,
  COALESCE((breakdown ->> 'score_bullpen_quality')::numeric, 0)              AS s_bullpen_quality,
  COALESCE((breakdown ->> 'score_wind_direction_hr')::numeric, 0)            AS s_wind_direction_hr,
  COALESCE((breakdown ->> 'score_pitcher_hr_per_9')::numeric, 0)             AS s_pitcher_hr_per_9,

  -- 25 D-340 unique score columns
  COALESCE((breakdown ->> 'score_pitcher_k_rate')::numeric, 0)               AS s_pitcher_k_rate,
  COALESCE((breakdown ->> 'score_pitcher_form')::numeric, 0)                 AS s_pitcher_form,
  COALESCE((breakdown ->> 'score_opposing_lineup_k')::numeric, 0)            AS s_opposing_lineup_k,
  COALESCE((breakdown ->> 'score_pitch_count_trend')::numeric, 0)            AS s_pitch_count_trend,
  COALESCE((breakdown ->> 'score_rest_pitcher')::numeric, 0)                 AS s_rest_pitcher,
  COALESCE((breakdown ->> 'score_handedness_matchup')::numeric, 0)           AS s_handedness_matchup,
  COALESCE((breakdown ->> 'score_ballpark_factor')::numeric, 0)              AS s_ballpark_factor,
  COALESCE((breakdown ->> 'score_weather_wind')::numeric, 0)                 AS s_weather_wind,
  COALESCE((breakdown ->> 'score_weather_temp')::numeric, 0)                 AS s_weather_temp,
  COALESCE((breakdown ->> 'score_umpire_k_zone')::numeric, 0)                AS s_umpire_k_zone,
  COALESCE((breakdown ->> 'score_batter_hit_rate')::numeric, 0)              AS s_batter_hit_rate,
  COALESCE((breakdown ->> 'score_batter_form')::numeric, 0)                  AS s_batter_form,
  COALESCE((breakdown ->> 'score_opposing_pitcher_quality')::numeric, 0)     AS s_opposing_pitcher_quality,
  COALESCE((breakdown ->> 'score_recent_at_bats')::numeric, 0)               AS s_recent_at_bats,
  COALESCE((breakdown ->> 'score_lineup_consistency')::numeric, 0)           AS s_lineup_consistency,
  COALESCE((breakdown ->> 'score_batter_power_rate')::numeric, 0)            AS s_batter_power_rate,
  COALESCE((breakdown ->> 'score_batter_form_power')::numeric, 0)            AS s_batter_form_power,
  COALESCE((breakdown ->> 'score_pitcher_hr_rate')::numeric, 0)              AS s_pitcher_hr_rate,
  COALESCE((breakdown ->> 'score_offense_differential')::numeric, 0)         AS s_offense_differential,
  COALESCE((breakdown ->> 'score_pitching_matchup')::numeric, 0)             AS s_pitching_matchup,
  COALESCE((breakdown ->> 'score_bullpen_strength')::numeric, 0)             AS s_bullpen_strength,
  COALESCE((breakdown ->> 'score_recent_run_diff')::numeric, 0)              AS s_recent_run_diff,
  COALESCE((breakdown ->> 'score_h2h_recent')::numeric, 0)                   AS s_h2h_recent,
  COALESCE((breakdown ->> 'score_team_form')::numeric, 0)                    AS s_team_form,
  COALESCE((breakdown ->> 'score_lineup_vs_hand_split')::numeric, 0)         AS s_lineup_vs_hand_split,

  -- D-376 fraw columns. These are synth-side audit fields not populated
  -- on organic; we coalesce to 0 so the d376-style FROZEN_AT_ZERO math
  -- yields no delta for organic — which is correct because those weights
  -- are still at 0 in production. Organic picks contribute baseline only.
  COALESCE((breakdown ->> 'fraw_weather_wind')::numeric, 0)                  AS f_weather_wind,
  COALESCE((breakdown ->> 'fraw_wind_direction_hr')::numeric, 0)             AS f_wind_direction_hr,
  COALESCE((breakdown ->> 'fraw_pitcher_hr_per_9')::numeric, 0)              AS f_pitcher_hr_per_9,
  COALESCE((breakdown ->> 'fraw_offense_differential')::numeric, 0)          AS f_offense_differential

FROM public.pick_history
WHERE is_synthetic = false
  AND sport = 'mlb'
  AND voided IS NOT TRUE
  AND hit IS NOT NULL
  AND breakdown IS NOT NULL;

CREATE INDEX idx_d532_fs_market    ON public.d532_factor_scores_real (mlb_market_type);
CREATE INDEX idx_d532_fs_game_date ON public.d532_factor_scores_real (game_date);
GRANT SELECT ON public.d532_factor_scores_real TO service_role, authenticated;

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-532 §F: d532_factor_scores_real MV smoke ========';
  FOR r IN
    SELECT
      count(*) AS rows,
      count(DISTINCT mlb_market_type) AS markets,
      min(game_date)::text AS oldest,
      max(game_date)::text AS newest,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS overall_wr,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 70),0), 1) AS wr_at_70,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 80),0), 1) AS wr_at_80
    FROM public.d532_factor_scores_real
  LOOP RAISE NOTICE '[D-532 §F.1] rows=% markets=% oldest=% newest=% wr=% wr@70=% wr@80=%',
    r.rows, r.markets, r.oldest, r.newest, r.overall_wr, r.wr_at_70, r.wr_at_80; END LOOP;

  -- Per-market breakdown
  FOR r IN
    SELECT mlb_market_type AS market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS wr,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 70),0), 1) AS wr_70,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 80),0), 1) AS wr_80
    FROM public.d532_factor_scores_real
    GROUP BY mlb_market_type ORDER BY n DESC
  LOOP RAISE NOTICE '[D-532 §F.2] market=% n=% wr=% wr_70=% wr_80=%',
    r.market, r.n, r.wr, r.wr_70, r.wr_80; END LOOP;
END $$;
