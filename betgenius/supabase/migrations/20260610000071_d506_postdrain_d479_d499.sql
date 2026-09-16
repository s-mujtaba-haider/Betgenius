-- D-506 post-drain — refresh D-479 cap verify + D-499 watch on fresh data.

DO $$
DECLARE r RECORD; v_pre_n BIGINT; v_pre_wr NUMERIC; v_post_n BIGINT; v_post_wr NUMERIC;
        v_cap_count BIGINT; v_total_real BIGINT; v_max_resolved DATE;
BEGIN
  SELECT count(*), max(game_date) INTO v_total_real, v_max_resolved
  FROM public.pick_history_real WHERE is_synthetic = false;
  RAISE NOTICE '[D-506 post-drain] pick_history_real total=% max_game_date=%',
    v_total_real, v_max_resolved;

  -- D-479 BEFORE
  RAISE NOTICE '[D-506 post-drain] D-479 BEFORE (game_date<2026-06-08, MLB, GOOD-tier OVER >=+100):';
  FOR r IN
    SELECT count(*) AS n, count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND confidence BETWEEN 65 AND 79
      AND pick_side='over' AND odds>=100 AND game_date<DATE '2026-06-08' AND hit IS NOT NULL
  LOOP RAISE NOTICE '  n=% wins=% wr=% units=%', r.n, r.wins, r.wr, r.units; END LOOP;

  -- D-479 AFTER (the key check)
  RAISE NOTICE '[D-506 post-drain] D-479 AFTER (game_date>=2026-06-08, MLB, GOOD-tier OVER >=+100):';
  FOR r IN
    SELECT count(*) AS n, count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND confidence BETWEEN 65 AND 79
      AND pick_side='over' AND odds>=100 AND game_date>=DATE '2026-06-08' AND hit IS NOT NULL
  LOOP RAISE NOTICE '  n=% wins=% wr=%', r.n, r.wins, r.wr; END LOOP;

  -- D-479 cap-firing audit (no GOOD-tier longshot OVERs should exist post-6/8)
  SELECT count(*) INTO v_cap_count FROM public.pick_history_real
   WHERE sport='mlb' AND is_synthetic=false AND confidence BETWEEN 70 AND 79
     AND pick_side='over' AND odds>=100 AND game_date>=DATE '2026-06-08';
  RAISE NOTICE '[D-506 post-drain] D-479 cap-firing audit: %  (should be 0)', v_cap_count;

  -- D-499 baseline
  SELECT count(*), ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2)
    INTO v_pre_n, v_pre_wr
    FROM public.pick_history_real
   WHERE sport='mlb' AND is_synthetic=false AND confidence>=60
     AND game_date BETWEEN DATE '2026-05-11' AND DATE '2026-06-09' AND hit IS NOT NULL;
  RAISE NOTICE '[D-506 post-drain] D-499 PRE-baseline (MLB conf>=60, 30d pre-apply): n=% wr=%',
    v_pre_n, v_pre_wr;

  -- D-499 post-apply sample
  SELECT count(*), ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2)
    INTO v_post_n, v_post_wr
    FROM public.pick_history_real
   WHERE sport='mlb' AND is_synthetic=false AND confidence>=60
     AND game_date>=DATE '2026-06-10' AND hit IS NOT NULL;
  RAISE NOTICE '[D-506 post-drain] D-499 POST-apply sample (MLB conf>=60, gd>=6/10): n=% wr=%',
    v_post_n, v_post_wr;

  IF v_post_n >= 50 AND v_pre_wr IS NOT NULL AND v_post_wr IS NOT NULL
     AND v_post_wr < (v_pre_wr - 5) THEN
    RAISE NOTICE '[D-506 post-drain] D-499 ROLLBACK TRIGGERED — % vs % (n=%)', v_post_wr, v_pre_wr, v_post_n;
  ELSIF v_post_n >= 50 THEN
    RAISE NOTICE '[D-506 post-drain] D-499 within band — no rollback signal (n=%)', v_post_n;
  ELSIF v_post_n >= 30 THEN
    RAISE NOTICE '[D-506 post-drain] D-499 early signal (n=% < 50 firm)', v_post_n;
  ELSE
    RAISE NOTICE '[D-506 post-drain] D-499 still too-early (n=% < 30)', v_post_n;
  END IF;

  -- Per-day breakdown of post-apply
  RAISE NOTICE '[D-506 post-drain] D-499 post-apply per-day MLB conf>=60:';
  FOR r IN
    SELECT game_date, count(*) AS n,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr
    FROM public.pick_history_real
   WHERE sport='mlb' AND is_synthetic=false AND confidence>=60
     AND game_date>=DATE '2026-06-10' AND hit IS NOT NULL
   GROUP BY game_date ORDER BY game_date
  LOOP RAISE NOTICE '  gd=% n=% wr=%', r.game_date, r.n, r.wr; END LOOP;
END $$;
