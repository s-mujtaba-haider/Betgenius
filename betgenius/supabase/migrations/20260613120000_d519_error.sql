DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §0 sample size
  RAISE NOTICE '[D-519 §0] sample sizes for resolved picks with projection data (60d):';
  FOR r IN
    SELECT mlb_market_type,
      count(*) AS total,
      count(*) FILTER (WHERE breakdown ? 'projected_stat') AS has_proj,
      count(*) FILTER (WHERE actual_value IS NOT NULL) AS has_actual,
      count(*) FILTER (WHERE breakdown ? 'projected_stat' AND actual_value IS NOT NULL) AS both
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
      AND hit IS NOT NULL
    GROUP BY mlb_market_type ORDER BY total DESC
  LOOP RAISE NOTICE '  market=% total=% has_proj=% has_actual=% both=%',
    r.mlb_market_type, r.total, r.has_proj, r.has_actual, r.both; END LOOP;

  -- §1 MAE + bias by market (player markets only — game markets don't have stat actuals same way)
  RAISE NOTICE '[D-519 §1] projection error by market — MAE + bias (60d, batter+pitcher):';
  FOR r IN
    SELECT mlb_market_type,
      count(*) AS n,
      ROUND(avg(abs((breakdown->>'projected_stat')::numeric - actual_value))::numeric, 3) AS mae,
      ROUND(avg((breakdown->>'projected_stat')::numeric - actual_value)::numeric, 3) AS bias,
      ROUND(avg((breakdown->>'projected_stat')::numeric)::numeric, 3) AS avg_projected,
      ROUND(avg(actual_value)::numeric, 3) AS avg_actual,
      ROUND(avg(line)::numeric, 3) AS avg_line
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
      AND hit IS NOT NULL
      AND breakdown ? 'projected_stat'
      AND actual_value IS NOT NULL
      AND mlb_market_type IN ('batter_total_bases','batter_hits','batter_rbis',
                              'batter_runs_scored','batter_strikeouts','batter_hr',
                              'pitcher_k','pitcher_outs')
    GROUP BY mlb_market_type ORDER BY mae DESC
  LOOP RAISE NOTICE '  market=% n=% MAE=% bias=% avg_proj=% avg_actual=% avg_line=%',
    r.mlb_market_type, r.n, r.mae, r.bias, r.avg_projected, r.avg_actual, r.avg_line; END LOOP;

  -- §1b — bias by pick_side (over/under) — is the model systematically wrong about overs vs unders?
  RAISE NOTICE '[D-519 §1b] bias by market x pick_side (positive bias = over-projecting):';
  FOR r IN
    SELECT mlb_market_type, pick_side,
      count(*) AS n,
      ROUND(avg(abs((breakdown->>'projected_stat')::numeric - actual_value))::numeric, 3) AS mae,
      ROUND(avg((breakdown->>'projected_stat')::numeric - actual_value)::numeric, 3) AS bias,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
      AND hit IS NOT NULL
      AND breakdown ? 'projected_stat'
      AND actual_value IS NOT NULL
      AND mlb_market_type IN ('batter_total_bases','batter_hits','batter_rbis',
                              'batter_runs_scored','batter_strikeouts','batter_hr',
                              'pitcher_k','pitcher_outs')
    GROUP BY mlb_market_type, pick_side
    ORDER BY mlb_market_type, pick_side
  LOOP RAISE NOTICE '  market=% side=% n=% MAE=% bias=% WR=%',
    r.mlb_market_type, r.pick_side, r.n, r.mae, r.bias, r.wr; END LOOP;

  -- §1c — how often does projection point the RIGHT direction?
  -- For OVER picks: did projection > line? For UNDER: did projection < line?
  RAISE NOTICE '[D-519 §1c] projection direction accuracy (did projection agree with pick_side?):';
  FOR r IN
    SELECT mlb_market_type,
      count(*) AS n,
      count(*) FILTER (WHERE
        (pick_side='over'  AND (breakdown->>'projected_stat')::numeric > line)
        OR
        (pick_side='under' AND (breakdown->>'projected_stat')::numeric < line)
      ) AS proj_agrees,
      ROUND(100.0 * count(*) FILTER (WHERE
        (pick_side='over'  AND (breakdown->>'projected_stat')::numeric > line)
        OR
        (pick_side='under' AND (breakdown->>'projected_stat')::numeric < line)
      ) / NULLIF(count(*), 0), 2) AS pct_proj_agrees,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr_actual
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
      AND hit IS NOT NULL
      AND breakdown ? 'projected_stat'
      AND mlb_market_type LIKE 'batter_%'
    GROUP BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% proj_agrees=% pct_agrees=% WR_actual=%',
    r.mlb_market_type, r.n, r.proj_agrees, r.pct_proj_agrees, r.wr_actual; END LOOP;
END $$;
