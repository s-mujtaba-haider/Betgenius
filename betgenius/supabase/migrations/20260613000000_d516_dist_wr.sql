DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  -- §1 CEILING DISTRIBUTION — today, real picks
  RAISE NOTICE '[D-516 §1a] confidence distribution today (MLB real, non-syn):';
  FOR r IN
    SELECT
      CASE WHEN confidence = 100 THEN 'eq_100'
           WHEN confidence BETWEEN 95 AND 99 THEN '95-99'
           WHEN confidence BETWEEN 90 AND 94 THEN '90-94'
           WHEN confidence BETWEEN 85 AND 89 THEN '85-89'
           WHEN confidence BETWEEN 80 AND 84 THEN '80-84'
           WHEN confidence BETWEEN 70 AND 79 THEN '70-79'
           ELSE '<70' END AS band,
      count(*) AS n,
      ROUND(100.0 * count(*) / SUM(count(*)) OVER (), 2) AS pct
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE
    GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% pct=%', r.band, r.n, r.pct; END LOOP;

  RAISE NOTICE '[D-516 §1b] confidence distribution last 7 days (MLB real, non-syn):';
  FOR r IN
    SELECT
      CASE WHEN confidence = 100 THEN 'eq_100'
           WHEN confidence BETWEEN 95 AND 99 THEN '95-99'
           WHEN confidence BETWEEN 90 AND 94 THEN '90-94'
           WHEN confidence BETWEEN 85 AND 89 THEN '85-89'
           WHEN confidence BETWEEN 80 AND 84 THEN '80-84'
           WHEN confidence BETWEEN 70 AND 79 THEN '70-79'
           ELSE '<70' END AS band,
      count(*) AS n,
      ROUND(100.0 * count(*) / SUM(count(*)) OVER (), 2) AS pct
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date BETWEEN
        (NOW() AT TIME ZONE 'America/New_York')::DATE - 7
        AND (NOW() AT TIME ZONE 'America/New_York')::DATE
    GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% pct=%', r.band, r.n, r.pct; END LOOP;

  -- Per-market distribution
  RAISE NOTICE '[D-516 §1c] today conf>=90 by market:';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           count(*) FILTER (WHERE confidence = 100) AS at_100
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE
      AND confidence >= 90
    GROUP BY mlb_market_type ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% n_conf90plus=% n_at_100=%',
    r.mlb_market_type, r.n, r.at_100; END LOOP;

  -- §3 WR by confidence band on pick_history_real
  RAISE NOTICE '[D-516 §3a] WR by confidence band — pick_history_real, MLB (resolved):';
  FOR r IN
    SELECT
      CASE WHEN confidence = 100 THEN 'eq_100'
           WHEN confidence BETWEEN 95 AND 99 THEN '95-99'
           WHEN confidence BETWEEN 90 AND 94 THEN '90-94'
           WHEN confidence BETWEEN 85 AND 89 THEN '85-89'
           WHEN confidence BETWEEN 80 AND 84 THEN '80-84'
           WHEN confidence BETWEEN 70 AND 79 THEN '70-79'
           ELSE '<70' END AS band,
      count(*) AS n,
      count(*) FILTER (WHERE hit) AS wins,
      ROUND(100.0 * count(*) FILTER (WHERE hit)
            / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS wr,
      ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                     WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units,
      ROUND(100.0 * SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                             WHEN hit IS FALSE THEN -1.0
                             ELSE 0 END) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS roi_pct,
      ROUND(avg(odds), 0) AS avg_odds
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
    GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% wins=% WR=% units=% ROI=% avg_odds=%',
    r.band, r.n, r.wins, r.wr, r.units, r.roi_pct, r.avg_odds; END LOOP;

  -- Per-market 100-conf vs 80-89 (does ceiling win more than middle within same market?)
  RAISE NOTICE '[D-516 §3b] MLB WR per market: 100 vs 80-89:';
  FOR r IN
    SELECT mlb_market_type,
           CASE WHEN confidence = 100 THEN 'eq_100'
                WHEN confidence BETWEEN 80 AND 89 THEN '80-89'
                ELSE 'other' END AS band,
           count(*) AS n,
           ROUND(100.0 * count(*) FILTER (WHERE hit)
                 / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
      AND (confidence = 100 OR confidence BETWEEN 80 AND 89)
    GROUP BY mlb_market_type, band
  LOOP RAISE NOTICE '  market=% band=% n=% WR=%',
    r.mlb_market_type, r.band, r.n, r.wr; END LOOP;

  RAISE NOTICE '[D-516 ctx] NOW UTC=% ET=% today_ET=%',
    NOW(), (NOW() AT TIME ZONE 'America/New_York'),
    (NOW() AT TIME ZONE 'America/New_York')::DATE;
END $$;
