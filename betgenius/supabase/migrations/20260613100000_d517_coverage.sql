DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- §a Coverage on pick_history_real last 60 days
  RAISE NOTICE '[D-517 §a] last10_hit_rate_pct coverage on batter markets, real picks last 60d:';
  FOR r IN
    SELECT
      mlb_market_type,
      count(*) AS total,
      count(*) FILTER (WHERE breakdown ? 'last10_hit_rate_pct') AS has_l10,
      count(*) FILTER (WHERE breakdown ? 'season_hit_rate_pct')  AS has_season_hr,
      count(*) FILTER (WHERE breakdown IS NULL) AS null_breakdown
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
      AND mlb_market_type IN ('batter_total_bases','batter_hits','batter_rbis',
                              'batter_runs_scored','batter_strikeouts','batter_hr')
    GROUP BY mlb_market_type ORDER BY total DESC
  LOOP RAISE NOTICE '  market=% total=% has_l10=% has_season=% null_breakdown=%',
    r.mlb_market_type, r.total, r.has_l10, r.has_season_hr, r.null_breakdown; END LOOP;

  -- §b Distribution of last10_hit_rate_pct
  RAISE NOTICE '[D-517 §b] distribution of last10_hit_rate_pct values (real batter picks, 60d):';
  FOR r IN
    SELECT
      CASE
        WHEN (breakdown->>'last10_hit_rate_pct')::numeric < 30 THEN '<30'
        WHEN (breakdown->>'last10_hit_rate_pct')::numeric < 40 THEN '30-39'
        WHEN (breakdown->>'last10_hit_rate_pct')::numeric < 50 THEN '40-49'
        WHEN (breakdown->>'last10_hit_rate_pct')::numeric < 60 THEN '50-59'
        WHEN (breakdown->>'last10_hit_rate_pct')::numeric < 70 THEN '60-69'
        ELSE '70+' END AS l10_band,
      count(*) AS n
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
      AND mlb_market_type LIKE 'batter_%'
      AND breakdown ? 'last10_hit_rate_pct'
    GROUP BY l10_band ORDER BY l10_band
  LOOP RAISE NOTICE '  l10_band=% n=%', r.l10_band, r.n; END LOOP;

  -- §c also confirm: do unresolved picks also have it?
  RAISE NOTICE '[D-517 §c] coverage on resolved-only (has hit) vs unresolved:';
  FOR r IN
    SELECT
      CASE WHEN hit IS NOT NULL THEN 'resolved' ELSE 'unresolved' END AS resolved_state,
      count(*) AS total,
      count(*) FILTER (WHERE breakdown ? 'last10_hit_rate_pct') AS has_l10
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
      AND mlb_market_type LIKE 'batter_%'
    GROUP BY resolved_state
  LOOP RAISE NOTICE '  state=% total=% has_l10=%',
    r.resolved_state, r.total, r.has_l10; END LOOP;
END $$;
