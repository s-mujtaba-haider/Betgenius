-- D-509 SHIP 2 verify, step 3: query rec_cache for cluster vs non-cluster
-- AFTER the trigger completes. Cluster = conf>=80 OVER (odds>=150 OR game_total).
-- Should see ZERO non-carve-out cluster picks.
DO $$
DECLARE r RECORD; v_today TEXT; v_picks_written INT;
        v_cluster_count INT; v_cluster_capped_count INT;
        v_rbi_count INT; v_hr_count INT;
        v_elite_strong_count INT; v_under_elite_count INT;
        v_body TEXT; v_status INT;
BEGIN
  SET LOCAL statement_timeout TO '180s';
  PERFORM pg_sleep(100);

  v_today := to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYY-MM-DD');

  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
    INTO v_body, v_status FROM net._http_response WHERE id = 12946;
  RAISE NOTICE '[D-509 step3] trigger response status=%', v_status;
  IF v_body IS NOT NULL THEN
    RAISE NOTICE '  body[0..400]=%', substring(v_body, 1, 400);
  END IF;

  -- §a Cluster: conf>=80 OVER picks NEWLY written today
  --     (a1) odds>=150 in batter/pitcher markets
  RAISE NOTICE '[D-509 step3] §a1 NEW conf>=80 OVER odds>=150 picks (cluster, excl rbi/HR):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=v_today::DATE
      AND created_at > NOW() - INTERVAL '5 minutes'
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type NOT IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% n=% min_c=% max_c=% (should be 0 picks above conf=75)',
    r.mlb_market_type, r.n, r.min_c, r.max_c; END LOOP;

  --     (a2) game_total OVER conf>=80 (any odds, no carve-outs)
  RAISE NOTICE '[D-509 step3] §a2 NEW game_total OVER conf>=80 (cluster, any odds):';
  FOR r IN
    SELECT count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=v_today::DATE
      AND created_at > NOW() - INTERVAL '5 minutes'
      AND pick_side='over' AND confidence >= 80
      AND mlb_market_type='game_total'
  LOOP RAISE NOTICE '  n=% min_c=% max_c=% (should be 0 above conf=75)', r.n, r.min_c, r.max_c; END LOOP;

  -- §b CARVE-OUTS: batter_rbis + batter_hr conf>=80 OVER odds>=150 (must NOT be capped)
  RAISE NOTICE '[D-509 step3] §b CARVE-OUTS (batter_rbis + batter_hr) conf>=80 OVER odds>=150:';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=v_today::DATE
      AND created_at > NOW() - INTERVAL '5 minutes'
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
      AND mlb_market_type IN ('batter_rbis','batter_hr')
    GROUP BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% min_c=% max_c=% (carve-out → should preserve conf 80+)',
    r.mlb_market_type, r.n, r.min_c, r.max_c; END LOOP;

  -- §c NON-CLUSTER samples (must be untouched)
  --     - ELITE/STRONG favorites (UNDER, or odds<150 OVER not game_total)
  RAISE NOTICE '[D-509 step3] §c NON-CLUSTER ELITE/STRONG samples (must NOT be capped):';
  FOR r IN
    SELECT mlb_market_type, pick_side,
           CASE WHEN odds < 0 THEN 'favorite' WHEN odds < 150 THEN '+100..149' ELSE '+150+' END AS odds_band,
           count(*) AS n, min(confidence) AS min_c, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=v_today::DATE
      AND created_at > NOW() - INTERVAL '5 minutes'
      AND confidence >= 80
      AND NOT (
        pick_side='over' AND (
          (odds >= 150 AND mlb_market_type NOT IN ('batter_rbis','batter_hr'))
          OR mlb_market_type='game_total'
        )
      )
    GROUP BY mlb_market_type, pick_side, odds_band
    ORDER BY n DESC LIMIT 15
  LOOP RAISE NOTICE '  market=% side=% band=% n=% min_c=% max_c=%',
    r.mlb_market_type, r.pick_side, r.odds_band, r.n, r.min_c, r.max_c; END LOOP;

  -- §d total written + error count
  SELECT count(*) INTO v_picks_written FROM public.pick_history
   WHERE created_at > NOW() - INTERVAL '5 minutes' AND is_synthetic=false;
  RAISE NOTICE '[D-509 step3] §d total NEW picks last 5min = %', v_picks_written;

  RAISE NOTICE '[D-509 step3] §e error_log last 5 min (process-games-mlb):';
  FOR r IN
    SELECT created_at, error_type, left(error_message, 200) AS msg
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '5 minutes'
      AND function_name='process-games-mlb'
      AND error_type NOT IN ('checkpoint')
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% type=% msg=%', r.created_at, r.error_type, r.msg; END LOOP;
END $$;
