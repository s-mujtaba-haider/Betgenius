DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §3 — factor-outcome correlation. For each factor in the breakdown JSON,
  -- compute WR when factor is positive (+) vs negative (-). Signal = positive
  -- factor should yield higher WR than negative. Inverted = noise or anti-signal.
  -- Restrict to batter markets last 60d.
  RAISE NOTICE '[D-519 §3] factor → WR (60d batter picks). signal: WR(+) > WR(-)';
  FOR r IN
    WITH t AS (
      SELECT key, (value)::text AS v_text,
        (CASE WHEN (value::text) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (value::text)::numeric ELSE NULL END) AS v_num,
        hit
      FROM public.pick_history_real,
           LATERAL jsonb_each_text(breakdown) AS j(key, value)
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
        AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%'
        AND key LIKE 'score_%'
    )
    SELECT key,
      count(*) AS n_total,
      count(*) FILTER (WHERE v_num > 0) AS n_pos,
      ROUND(100.0 * count(*) FILTER (WHERE v_num > 0 AND hit)
            / NULLIF(count(*) FILTER (WHERE v_num > 0), 0), 2) AS wr_pos,
      count(*) FILTER (WHERE v_num < 0) AS n_neg,
      ROUND(100.0 * count(*) FILTER (WHERE v_num < 0 AND hit)
            / NULLIF(count(*) FILTER (WHERE v_num < 0), 0), 2) AS wr_neg,
      ROUND(100.0 * count(*) FILTER (WHERE v_num > 0 AND hit)
            / NULLIF(count(*) FILTER (WHERE v_num > 0), 0), 2) -
      ROUND(100.0 * count(*) FILTER (WHERE v_num < 0 AND hit)
            / NULLIF(count(*) FILTER (WHERE v_num < 0), 0), 2) AS edge_pp
    FROM t
    WHERE v_num IS NOT NULL
    GROUP BY key
    HAVING count(*) FILTER (WHERE v_num > 0) >= 50 AND count(*) FILTER (WHERE v_num < 0) >= 50
    ORDER BY edge_pp DESC NULLS LAST
  LOOP RAISE NOTICE '  factor=% n_pos=% WR(+)=% n_neg=% WR(-)=% edge_pp=%',
    r.key, r.n_pos, r.wr_pos, r.n_neg, r.wr_neg, r.edge_pp; END LOOP;

  -- §3b — also include the RAW signal features (last10_hit_rate, season_ba, etc.)
  -- Bucket by tercile or by threshold.
  RAISE NOTICE '[D-519 §3b] raw signal → WR (batter only, 60d):';
  FOR r IN
    WITH t AS (
      SELECT
        CASE WHEN (breakdown->>'last10_hit_rate_pct') ~ '^-?[0-9]+(\.[0-9]+)?$'
             THEN (breakdown->>'last10_hit_rate_pct')::numeric END AS l10,
        CASE WHEN (breakdown->>'season_hit_rate_pct') ~ '^-?[0-9]+(\.[0-9]+)?$'
             THEN (breakdown->>'season_hit_rate_pct')::numeric END AS sh,
        CASE WHEN (breakdown->>'statcast_brl_pa') ~ '^-?[0-9]+(\.[0-9]+)?$'
             THEN (breakdown->>'statcast_brl_pa')::numeric END AS brl_pa,
        CASE WHEN (breakdown->>'statcast_xba') ~ '^-?[0-9]+(\.[0-9]+)?$'
             THEN (breakdown->>'statcast_xba')::numeric END AS xba,
        CASE WHEN (breakdown->>'consecutive_starts') ~ '^-?[0-9]+(\.[0-9]+)?$'
             THEN (breakdown->>'consecutive_starts')::numeric END AS cs,
        hit
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
        AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%'
        AND breakdown IS NOT NULL
    )
    SELECT 'last10_hit_rate_pct' AS signal,
      count(*) FILTER (WHERE l10 >= 60) AS n_hi,
      ROUND(100.0 * count(*) FILTER (WHERE l10 >= 60 AND hit) / NULLIF(count(*) FILTER (WHERE l10 >= 60), 0), 2) AS wr_hi,
      count(*) FILTER (WHERE l10 < 40) AS n_lo,
      ROUND(100.0 * count(*) FILTER (WHERE l10 < 40 AND hit) / NULLIF(count(*) FILTER (WHERE l10 < 40), 0), 2) AS wr_lo
    FROM t WHERE l10 IS NOT NULL
    UNION ALL
    SELECT 'season_hit_rate_pct',
      count(*) FILTER (WHERE sh >= 50),
      ROUND(100.0 * count(*) FILTER (WHERE sh >= 50 AND hit) / NULLIF(count(*) FILTER (WHERE sh >= 50), 0), 2),
      count(*) FILTER (WHERE sh < 30),
      ROUND(100.0 * count(*) FILTER (WHERE sh < 30 AND hit) / NULLIF(count(*) FILTER (WHERE sh < 30), 0), 2)
    FROM t WHERE sh IS NOT NULL
    UNION ALL
    SELECT 'statcast_brl_pa',
      count(*) FILTER (WHERE brl_pa >= 10),
      ROUND(100.0 * count(*) FILTER (WHERE brl_pa >= 10 AND hit) / NULLIF(count(*) FILTER (WHERE brl_pa >= 10), 0), 2),
      count(*) FILTER (WHERE brl_pa < 4),
      ROUND(100.0 * count(*) FILTER (WHERE brl_pa < 4 AND hit) / NULLIF(count(*) FILTER (WHERE brl_pa < 4), 0), 2)
    FROM t WHERE brl_pa IS NOT NULL
    UNION ALL
    SELECT 'statcast_xba',
      count(*) FILTER (WHERE xba >= 0.275),
      ROUND(100.0 * count(*) FILTER (WHERE xba >= 0.275 AND hit) / NULLIF(count(*) FILTER (WHERE xba >= 0.275), 0), 2),
      count(*) FILTER (WHERE xba < 0.220),
      ROUND(100.0 * count(*) FILTER (WHERE xba < 0.220 AND hit) / NULLIF(count(*) FILTER (WHERE xba < 0.220), 0), 2)
    FROM t WHERE xba IS NOT NULL
  LOOP RAISE NOTICE '  signal=% n_high=% WR_high=% n_low=% WR_low=% delta_pp=%',
    r.signal, r.n_hi, r.wr_hi, r.n_lo, r.wr_lo, r.wr_hi - r.wr_lo; END LOOP;

  -- §4 weight vs signal strength — pull live weights for batter factors
  RAISE NOTICE '[D-519 §4] weights table for batter factors (live):';
  FOR r IN
    WITH w AS (SELECT * FROM public.algorithm_weights ORDER BY id LIMIT 1)
    SELECT key, value::numeric AS value FROM w, jsonb_each_text(to_jsonb(w)) AS j(key, value)
    WHERE key LIKE 'w_mlb_batter_%' OR key IN ('w_mlb_pitcher_hr_per_9','w_mlb_lineup_spot',
                                                'w_mlb_bullpen_quality','w_mlb_park_hr_factor',
                                                'w_mlb_wind_direction_hr','w_mlb_pitcher_baa_vs_hand',
                                                'w_l5','w_l10')
    ORDER BY value::numeric DESC NULLS LAST
  LOOP RAISE NOTICE '  %=%', r.key, r.value; END LOOP;
END $$;
