-- D-505 SHIP 3 — ELITE/STRONG longshot-OVER cluster diagnosis.
-- pick_history_real (resolved real picks) ends 2026-05-29 due to a
-- resolution stall (see d505_d479_verify.md). Using all available
-- resolved data.
DO $$
DECLARE
  v_n BIGINT; v_w BIGINT; v_roi NUMERIC;
  r RECORD;
BEGIN
  -- =================================================================
  -- The cluster: ELITE (conf >= 90) + STRONG (conf 80-89) OVER picks
  -- at odds >= +100 (longshot definition).
  -- =================================================================
  SELECT count(*), count(*) FILTER (WHERE hit),
         sum(CASE WHEN hit THEN
               CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
             ELSE -1.0 END)
    INTO v_n, v_w, v_roi
   FROM public.pick_history_real
   WHERE confidence >= 80
     AND pick_side = 'over' AND odds >= 100
     AND is_synthetic = false;
  RAISE NOTICE '[D-505 ELITE/STRONG] conf>=80 OVER +100 (all sports, all-time): n=% wins=% WR=%pct ROI/$1=%u (%pct of stakes)',
    v_n, v_w,
    ROUND(CASE WHEN v_n>0 THEN v_w*100.0/v_n ELSE 0 END, 2),
    ROUND(COALESCE(v_roi,0), 2),
    ROUND(CASE WHEN v_n>0 THEN COALESCE(v_roi,0)*100.0/v_n ELSE 0 END, 2);

  -- Pivot by tier
  RAISE NOTICE '[D-505 ELITE/STRONG] by tier (ELITE=90+ vs STRONG=80-89):';
  FOR r IN
    SELECT
      CASE WHEN confidence >= 90 THEN 'ELITE (90+)' ELSE 'STRONG (80-89)' END AS tier,
      count(*) AS n,
      count(*) FILTER (WHERE hit) AS wins,
      ROUND(count(*) FILTER (WHERE hit) * 100.0 / NULLIF(count(*),0), 2) AS wr,
      ROUND(sum(CASE WHEN hit THEN
            CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
          ELSE -1.0 END)::numeric, 2) AS roi_u,
      ROUND(sum(CASE WHEN hit THEN
            CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
          ELSE -1.0 END)::numeric * 100.0 / NULLIF(count(*),0), 2) AS roi_pct
    FROM public.pick_history_real
    WHERE confidence >= 80 AND pick_side='over' AND odds >= 100
      AND is_synthetic = false
    GROUP BY tier
  LOOP
    RAISE NOTICE '  %  n=% wins=% WR=%pct ROI=%u (%pct)', r.tier, r.n, r.wins, r.wr, r.roi_u, r.roi_pct;
  END LOOP;

  -- Pivot by sport
  RAISE NOTICE '[D-505 ELITE/STRONG] by sport:';
  FOR r IN
    SELECT sport, count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(count(*) FILTER (WHERE hit) * 100.0 / NULLIF(count(*),0), 2) AS wr,
           ROUND(sum(CASE WHEN hit THEN
                 CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
               ELSE -1.0 END)::numeric * 100.0 / NULLIF(count(*),0), 2) AS roi_pct
    FROM public.pick_history_real
    WHERE confidence >= 80 AND pick_side='over' AND odds >= 100
      AND is_synthetic = false
    GROUP BY sport
  LOOP
    RAISE NOTICE '  sport=% n=% wins=% WR=%pct ROI=%pct', r.sport, r.n, r.wins, r.wr, r.roi_pct;
  END LOOP;

  -- Pivot by odds band
  RAISE NOTICE '[D-505 ELITE/STRONG] by odds band (+100 to +200, +200+):';
  FOR r IN
    SELECT
      CASE
        WHEN odds BETWEEN 100 AND 149 THEN '+100..+149'
        WHEN odds BETWEEN 150 AND 199 THEN '+150..+199'
        WHEN odds BETWEEN 200 AND 299 THEN '+200..+299'
        WHEN odds >= 300 THEN '+300+'
        ELSE 'other'
      END AS odds_band,
      count(*) AS n,
      count(*) FILTER (WHERE hit) AS wins,
      ROUND(count(*) FILTER (WHERE hit) * 100.0 / NULLIF(count(*),0), 2) AS wr,
      ROUND(sum(CASE WHEN hit THEN
            CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
          ELSE -1.0 END)::numeric * 100.0 / NULLIF(count(*),0), 2) AS roi_pct
    FROM public.pick_history_real
    WHERE confidence >= 80 AND pick_side='over' AND odds >= 100
      AND is_synthetic = false
    GROUP BY odds_band ORDER BY odds_band
  LOOP
    RAISE NOTICE '  band=% n=% wins=% WR=%pct ROI=%pct', r.odds_band, r.n, r.wins, r.wr, r.roi_pct;
  END LOOP;

  -- Pivot by mlb_market_type (when sport=mlb) to find which market is bleeding
  RAISE NOTICE '[D-505 ELITE/STRONG] by mlb_market_type:';
  FOR r IN
    SELECT COALESCE(mlb_market_type, prop_type) AS market,
           count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(count(*) FILTER (WHERE hit) * 100.0 / NULLIF(count(*),0), 2) AS wr,
           ROUND(sum(CASE WHEN hit THEN
                 CASE WHEN odds > 0 THEN odds::numeric/100.0 ELSE 100.0/abs(odds::numeric) END
               ELSE -1.0 END)::numeric * 100.0 / NULLIF(count(*),0), 2) AS roi_pct
    FROM public.pick_history_real
    WHERE confidence >= 80 AND pick_side='over' AND odds >= 100
      AND is_synthetic = false
    GROUP BY market ORDER BY n DESC
  LOOP
    RAISE NOTICE '  market=% n=% wins=% WR=%pct ROI=%pct', r.market, r.n, r.wins, r.wr, r.roi_pct;
  END LOOP;

  -- Show sample of 10 losers
  RAISE NOTICE '[D-505 ELITE/STRONG] sample of 10 losers:';
  FOR r IN
    SELECT id, sport, player_name, prop_type, line, odds, confidence, actual_value, game_date
    FROM public.pick_history_real
    WHERE confidence >= 80 AND pick_side='over' AND odds >= 100
      AND is_synthetic = false AND hit = false
    ORDER BY random() LIMIT 10
  LOOP
    RAISE NOTICE '  % %  conf=% prop=% line=% odds=+% actual=% date=%',
      r.sport, COALESCE(r.player_name, '<null>'), r.confidence,
      r.prop_type, r.line, r.odds, COALESCE(r.actual_value::text, '<null>'), r.game_date;
  END LOOP;
END $$;
