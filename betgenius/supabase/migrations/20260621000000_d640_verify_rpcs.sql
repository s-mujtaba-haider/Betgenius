-- D-640 — Verify RPCs for the next-day pass.
-- Each function returns a single results row covering one verify item.
-- VOLATILE + SECURITY DEFINER + SET LOCAL statement_timeout='180s' so
-- analytical queries against pick_history don't hit PostgREST's
-- gateway timeout.
-- Rollback: DROP each at end of session via 20260621001000.

-- ── V1 — D-635 line movement: distinct + active rates on POST-DEPLOY picks
CREATE OR REPLACE FUNCTION public.d640_v1_line_movement()
RETURNS TABLE (
  n_rows                  BIGINT,
  n_with_lm_magnitude     BIGINT,
  distinct_magnitudes     BIGINT,
  distinct_delta_odds     BIGINT,
  distinct_lm_directions  BIGINT,
  n_strong                BIGINT,
  n_moderate              BIGINT,
  n_mild                  BIGINT,
  n_neutral               BIGINT,
  n_no_movement           BIGINT,
  n_no_data               BIGINT,
  n_applied_lm_score_nonzero BIGINT,
  n_raw_lm_score_nonzero  BIGINT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT breakdown
    FROM public.pick_history
    WHERE sport = 'mlb'
      AND COALESCE(is_synthetic, FALSE) = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND created_at > '2026-06-20 12:00:00'::timestamptz
      AND breakdown IS NOT NULL
      AND breakdown ? 'lm_magnitude'
  )
  SELECT
    COUNT(*),
    SUM(CASE WHEN breakdown ? 'lm_magnitude' THEN 1 ELSE 0 END),
    COUNT(DISTINCT (breakdown->>'lm_magnitude')),
    COUNT(DISTINCT (breakdown->>'lm_delta_odds')),
    COUNT(DISTINCT (breakdown->>'lm_toward_pick')),
    SUM(CASE WHEN breakdown->>'lm_magnitude' = 'strong'      THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'lm_magnitude' = 'moderate'    THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'lm_magnitude' = 'mild'        THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'lm_magnitude' = 'neutral'     THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'lm_magnitude' = 'no_movement' THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'lm_magnitude' = 'no_data'     THEN 1 ELSE 0 END),
    SUM(CASE WHEN (breakdown->>'score_line_movement_v2') IS NOT NULL
             AND jsonb_typeof(breakdown->'score_line_movement_v2') = 'number'
             AND (breakdown->>'score_line_movement_v2')::numeric <> 0 THEN 1 ELSE 0 END),
    SUM(CASE WHEN (breakdown->>'lm_raw_score') IS NOT NULL
             AND jsonb_typeof(breakdown->'lm_raw_score') = 'number'
             AND (breakdown->>'lm_raw_score')::numeric <> 0 THEN 1 ELSE 0 END)
  FROM base;
END $$;
GRANT EXECUTE ON FUNCTION public.d640_v1_line_movement() TO service_role;

-- ── V2 — D-636 sharp money: distinct + applied=0 confirmation
CREATE OR REPLACE FUNCTION public.d640_v2_sharp_money()
RETURNS TABLE (
  n_rows                       BIGINT,
  n_with_rlm_status            BIGINT,
  distinct_rlm_statuses        BIGINT,
  distinct_n_books             BIGINT,
  distinct_avg_delta           BIGINT,
  n_rlm_toward_pick            BIGINT,
  n_rlm_away                   BIGINT,
  n_single_side_only           BIGINT,
  n_no_data                    BIGINT,
  n_steam_detected             BIGINT,
  n_applied_rlm_score_nonzero  BIGINT,
  n_raw_rlm_score_nonzero      BIGINT,
  n_ai_mentions_signal         BIGINT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT breakdown, ai_analysis
    FROM public.pick_history
    WHERE sport = 'mlb'
      AND COALESCE(is_synthetic, FALSE) = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND created_at > '2026-06-20 12:00:00'::timestamptz
      AND breakdown IS NOT NULL
      AND breakdown ? 'rlm_status'
  )
  SELECT
    COUNT(*),
    SUM(CASE WHEN breakdown ? 'rlm_status' THEN 1 ELSE 0 END),
    COUNT(DISTINCT (breakdown->>'rlm_status')),
    COUNT(DISTINCT (breakdown->>'rlm_n_books')),
    COUNT(DISTINCT (breakdown->>'rlm_avg_odds_delta')),
    SUM(CASE WHEN breakdown->>'rlm_status' = 'rlm_toward_pick'    THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'rlm_status' = 'rlm_away_from_pick' THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'rlm_status' = 'single_side_only'   THEN 1 ELSE 0 END),
    SUM(CASE WHEN breakdown->>'rlm_status' = 'no_data'            THEN 1 ELSE 0 END),
    SUM(CASE WHEN (breakdown->>'steam_detected')::text = 'true'   THEN 1 ELSE 0 END),
    SUM(CASE WHEN (breakdown->>'score_rlm_signal') IS NOT NULL
             AND jsonb_typeof(breakdown->'score_rlm_signal') = 'number'
             AND (breakdown->>'score_rlm_signal')::numeric <> 0 THEN 1 ELSE 0 END),
    SUM(CASE WHEN (breakdown->>'rlm_raw_score') IS NOT NULL
             AND jsonb_typeof(breakdown->'rlm_raw_score') = 'number'
             AND (breakdown->>'rlm_raw_score')::numeric <> 0 THEN 1 ELSE 0 END),
    SUM(CASE WHEN ai_analysis IS NOT NULL
             AND (LOWER(ai_analysis) LIKE '%line move%'
              OR  LOWER(ai_analysis) LIKE '%ticked toward%'
              OR  LOWER(ai_analysis) LIKE '%reverse line%'
              OR  LOWER(ai_analysis) LIKE '%sharp action%'
              OR  LOWER(ai_analysis) LIKE '%steam%'
              OR  LOWER(ai_analysis) LIKE '%rlm%') THEN 1 ELSE 0 END)
  FROM base;
END $$;
GRANT EXECUTE ON FUNCTION public.d640_v2_sharp_money() TO service_role;

-- ── V3 — D-637 lineup watcher health + lineup_spot null rate
CREATE OR REPLACE FUNCTION public.d640_v3_lineup_watcher()
RETURNS TABLE (
  n_log_rows_today            BIGINT,
  n_games_confirmed_today     BIGINT,
  total_scratched_picks       BIGINT,
  total_voided_history        BIGINT,
  n_rescore_invoked           BIGINT,
  picks_post_confirm_n        BIGINT,
  picks_post_confirm_null_ls  BIGINT,
  picks_post_confirm_pct_null NUMERIC,
  voided_today_n              BIGINT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_first_confirm timestamptz;
BEGIN
  SET LOCAL statement_timeout = '180s';
  SELECT MIN(confirmed_at) INTO v_first_confirm
  FROM public.lineup_confirmation_log
  WHERE game_date = CURRENT_DATE OR confirmed_at > NOW() - INTERVAL '24 hours';
  RETURN QUERY
  WITH log AS (
    SELECT * FROM public.lineup_confirmation_log
    WHERE confirmed_at > NOW() - INTERVAL '24 hours'
  ),
  agg_log AS (
    SELECT
      COUNT(*)                            AS n_log_rows_today,
      COUNT(DISTINCT game_pk)             AS n_games_confirmed_today,
      COALESCE(SUM(n_scratched_picks),0)  AS total_scratched_picks,
      COALESCE(SUM(n_voided_history),0)   AS total_voided_history,
      SUM(CASE WHEN rescore_invoked THEN 1 ELSE 0 END) AS n_rescore_invoked
    FROM log
  ),
  post_confirm AS (
    SELECT
      COUNT(*) AS picks_post_confirm_n,
      SUM(CASE WHEN (breakdown->>'lineup_spot') IS NULL
                 OR jsonb_typeof(breakdown->'lineup_spot') = 'null'
                THEN 1 ELSE 0 END) AS picks_post_confirm_null_ls
    FROM public.pick_history
    WHERE sport = 'mlb'
      AND mlb_market_type IN ('batter_hr','batter_rbis','batter_runs_scored',
                              'batter_hits','batter_total_bases','batter_strikeouts')
      AND COALESCE(is_synthetic, FALSE) = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND created_at > COALESCE(v_first_confirm, NOW() - INTERVAL '24 hours')
      AND breakdown IS NOT NULL
  ),
  voided AS (
    SELECT COUNT(*) AS voided_today_n
    FROM public.pick_history
    WHERE sport = 'mlb'
      AND voided = TRUE
      AND resolved_at > NOW() - INTERVAL '24 hours'
  )
  SELECT
    al.n_log_rows_today,
    al.n_games_confirmed_today,
    al.total_scratched_picks,
    al.total_voided_history,
    al.n_rescore_invoked,
    pc.picks_post_confirm_n,
    pc.picks_post_confirm_null_ls,
    ROUND(100.0 * pc.picks_post_confirm_null_ls / NULLIF(pc.picks_post_confirm_n, 0), 1),
    v.voided_today_n
  FROM agg_log al CROSS JOIN post_confirm pc CROSS JOIN voided v;
END $$;
GRANT EXECUTE ON FUNCTION public.d640_v3_lineup_watcher() TO service_role;

-- ── V4 — D-630 carryover: weather + Statcast pct_active on new picks
CREATE OR REPLACE FUNCTION public.d640_v4_d630_carryover()
RETURNS TABLE (
  market                            TEXT,
  n                                 BIGINT,
  pct_score_weather_temp            NUMERIC,
  pct_score_weather_wind            NUMERIC,
  pct_score_batter_barrel_rate      NUMERIC,
  pct_score_batter_xslg_regression  NUMERIC,
  pct_score_batter_exit_velo_trend  NUMERIC
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  SELECT
    ph.mlb_market_type AS market,
    COUNT(*) AS n,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(ph.breakdown->'score_weather_temp')='number'
        AND (ph.breakdown->>'score_weather_temp')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_weather_temp,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(ph.breakdown->'score_weather_wind')='number'
        AND (ph.breakdown->>'score_weather_wind')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_weather_wind,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(ph.breakdown->'score_batter_barrel_rate')='number'
        AND (ph.breakdown->>'score_batter_barrel_rate')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_batter_barrel_rate,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(ph.breakdown->'score_batter_xslg_regression')='number'
        AND (ph.breakdown->>'score_batter_xslg_regression')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_batter_xslg_regression,
    ROUND(100.0 * AVG(CASE WHEN jsonb_typeof(ph.breakdown->'score_batter_exit_velo_trend')='number'
        AND (ph.breakdown->>'score_batter_exit_velo_trend')::numeric <> 0 THEN 1.0 ELSE 0 END), 1) AS pct_score_batter_exit_velo_trend
  FROM public.pick_history ph
  WHERE ph.mlb_market_type IN ('batter_hr','batter_rbis','batter_total_bases','batter_hits','batter_runs_scored','pitcher_outs','game_total')
    AND COALESCE(ph.is_synthetic, FALSE) = FALSE
    AND COALESCE(ph.voided, FALSE) = FALSE
    AND ph.created_at > '2026-06-20 12:00:00'::timestamptz
    AND ph.breakdown IS NOT NULL
  GROUP BY ph.mlb_market_type
  ORDER BY ph.mlb_market_type;
END $$;
GRANT EXECUTE ON FUNCTION public.d640_v4_d630_carryover() TO service_role;

-- ── V5 — Weather scoreboard coverage diagnose (root-cause D-630-WX)
CREATE OR REPLACE FUNCTION public.d640_v5_weather_coverage(p_days INT DEFAULT 7)
RETURNS TABLE (
  game_date     DATE,
  n_total       BIGINT,
  n_indoor      BIGINT,
  n_outdoor     BIGINT,
  n_outdoor_no_weather BIGINT,
  pct_outdoor_no_weather NUMERIC
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '120s';
  RETURN QUERY
  SELECT
    sb.game_date,
    COUNT(*)                                                            AS n_total,
    SUM(CASE WHEN LOWER(COALESCE(sb.weather_condition,''))='indoor'  THEN 1 ELSE 0 END) AS n_indoor,
    SUM(CASE WHEN LOWER(COALESCE(sb.weather_condition,''))<>'indoor' THEN 1 ELSE 0 END) AS n_outdoor,
    SUM(CASE WHEN LOWER(COALESCE(sb.weather_condition,''))<>'indoor'
              AND sb.weather_wind_speed IS NULL AND sb.weather_wind_dir_deg IS NULL
              AND sb.weather_temp_f IS NULL
              THEN 1 ELSE 0 END)                                       AS n_outdoor_no_weather,
    ROUND(100.0 * SUM(CASE WHEN LOWER(COALESCE(sb.weather_condition,''))<>'indoor'
                       AND sb.weather_wind_speed IS NULL AND sb.weather_wind_dir_deg IS NULL
                       AND sb.weather_temp_f IS NULL
                       THEN 1 ELSE 0 END)
                / NULLIF(SUM(CASE WHEN LOWER(COALESCE(sb.weather_condition,''))<>'indoor' THEN 1 ELSE 0 END), 0), 1) AS pct_outdoor_no_weather
  FROM public.cache_mlb_game_scoreboard sb
  WHERE sb.game_date >= (CURRENT_DATE - p_days) AND sb.game_date <= CURRENT_DATE + 1
  GROUP BY sb.game_date
  ORDER BY sb.game_date DESC;
END $$;
GRANT EXECUTE ON FUNCTION public.d640_v5_weather_coverage(INT) TO service_role;

-- ── V6 — Cron health (D-617/619/620): dead-hours skip + hash-skip telemetry
CREATE OR REPLACE FUNCTION public.d640_v6_cron_health()
RETURNS TABLE (
  metric  TEXT,
  value   TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  SELECT 'cron_jobs_active'::TEXT,
         (SELECT COUNT(*)::TEXT FROM cron.job WHERE active = TRUE);
  RETURN QUERY
  SELECT ('cron_job_'||jobname)::TEXT,
         (active::TEXT || ' / sched=' || schedule)
  FROM cron.job
  WHERE jobname IN (
    'snapshot-odds-writer-30min',
    'lineup-confirmation-watcher-10min',
    'process-games-mlb-5min',
    'fetch-odds-mlb-30min',
    'fetch-weather-hourly',
    'fetch-weather-1h',
    'fetch-weather-mlb-hourly',
    'fetch-weather-mlb-1h'
  );
END $$;
GRANT EXECUTE ON FUNCTION public.d640_v6_cron_health() TO service_role;
