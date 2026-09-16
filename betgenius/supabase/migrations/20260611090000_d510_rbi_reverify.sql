DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-510 §a] D-509 cluster slice (batter_rbis, conf>=80, OVER, odds>=+150, resolved):';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           count(*) FILTER (WHERE hit IS FALSE) AS losses,
           count(*) FILTER (WHERE hit IS NULL AND resolved_at IS NOT NULL) AS pushes,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0
                          ELSE 0 END)::NUMERIC, 2) AS units,
           ROUND(100.0 * SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                                  WHEN hit IS FALSE THEN -1.0
                                  ELSE 0 END) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS roi_pct,
           ROUND(avg(odds), 1) AS avg_odds
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type='batter_rbis'
      AND pick_side='over' AND odds >= 150
      AND confidence >= 80
      AND hit IS NOT NULL
  LOOP RAISE NOTICE '  n=% wins=% losses=% pushes=% WR=% units=% ROI=% avg_odds=%',
    r.n, r.wins, r.losses, r.pushes, r.wr, r.units, r.roi_pct, r.avg_odds; END LOOP;

  RAISE NOTICE '[D-510 §b] +100..149 band (sanity — same slice except odds):';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           count(*) FILTER (WHERE hit IS FALSE) AS losses,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0
                          ELSE 0 END)::NUMERIC, 2) AS units,
           ROUND(100.0 * SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                                  WHEN hit IS FALSE THEN -1.0
                                  ELSE 0 END) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS roi_pct,
           ROUND(avg(odds), 1) AS avg_odds
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type='batter_rbis'
      AND pick_side='over' AND odds BETWEEN 100 AND 149
      AND confidence >= 80
      AND hit IS NOT NULL
  LOOP RAISE NOTICE '  n=% wins=% losses=% WR=% units=% ROI=% avg_odds=%',
    r.n, r.wins, r.losses, r.wr, r.units, r.roi_pct, r.avg_odds; END LOOP;

  -- BE rate at +150+ avg odds (for context)
  RAISE NOTICE '[D-510 §c] BE-rate context at avg odds:';
  RAISE NOTICE '  at +150: BE = 100/(100+150) = 40%%';
  RAISE NOTICE '  at +200: BE = 100/(100+200) = 33.3%%';
  RAISE NOTICE '  at +300: BE = 100/(100+300) = 25%%';

  -- §d break it down by odds sub-band so we can see where the bleed is
  RAISE NOTICE '[D-510 §d] odds sub-bands within +150+ (where is the bleed?):';
  FOR r IN
    SELECT CASE WHEN odds < 200 THEN '+150..199'
                WHEN odds < 300 THEN '+200..299'
                WHEN odds < 500 THEN '+300..499'
                ELSE '+500+' END AS band,
           count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units,
           ROUND(100.0 * SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                                  WHEN hit IS FALSE THEN -1.0
                                  ELSE 0 END) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS roi_pct,
           ROUND(avg(odds), 1) AS avg_odds
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type='batter_rbis'
      AND pick_side='over' AND odds >= 150
      AND confidence >= 80
      AND hit IS NOT NULL
    GROUP BY band ORDER BY band
  LOOP RAISE NOTICE '  band=% n=% wins=% WR=% units=% ROI=% avg_odds=%',
    r.band, r.n, r.wins, r.wr, r.units, r.roi_pct, r.avg_odds; END LOOP;

  -- §e ELITE (90+) vs STRONG (80-89) split within +150+
  RAISE NOTICE '[D-510 §e] ELITE (90+) vs STRONG (80-89) within +150+:';
  FOR r IN
    SELECT CASE WHEN confidence >= 90 THEN 'ELITE_90+'
                ELSE 'STRONG_80-89' END AS tier,
           count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units,
           ROUND(100.0 * SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                                  WHEN hit IS FALSE THEN -1.0
                                  ELSE 0 END) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS roi_pct
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type='batter_rbis'
      AND pick_side='over' AND odds >= 150
      AND confidence >= 80
      AND hit IS NOT NULL
    GROUP BY tier ORDER BY tier
  LOOP RAISE NOTICE '  tier=% n=% wins=% WR=% units=% ROI=%',
    r.tier, r.n, r.wins, r.wr, r.units, r.roi_pct; END LOOP;
END $$;
