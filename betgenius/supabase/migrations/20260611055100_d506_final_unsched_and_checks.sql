-- D-506 SHIP 3c + SHIP 4 — final unschedule + D-479 verify + D-499 watch
-- + 5 spot-checks. Pending was 320 when this ran; the regular crons
-- (jobid 1/2/3) will drain the tail along with daily new picks.

-- 1. Unschedule the round-3 backfill cron
SELECT cron.unschedule('resolve-picks-d506-backfill-r3');

DO $$
DECLARE r RECORD; v_pending BIGINT;
        v_pre_n BIGINT; v_pre_wr NUMERIC; v_post_n BIGINT; v_post_wr NUMERIC;
        v_cap_audit BIGINT; v_max_real DATE; v_real_total BIGINT;
BEGIN
  -- final pending + real freshness
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  SELECT count(*), max(game_date) INTO v_real_total, v_max_real
    FROM public.pick_history_real WHERE is_synthetic = false;
  RAISE NOTICE '[D-506 FINAL] pending=% real_total=% real_max_gd=%',
    v_pending, v_real_total, v_max_real;

  -- 2. D-479 BEFORE
  RAISE NOTICE '[D-506 FINAL] D-479 BEFORE (gd<6/8, MLB, GOOD-tier OVER >=+100):';
  FOR r IN
    SELECT count(*) AS n, count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr,
           ROUND(SUM(CASE WHEN hit THEN (odds*1.0/100.0)
                          WHEN hit IS FALSE THEN -1.0 ELSE 0 END)::NUMERIC, 2) AS units
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND confidence BETWEEN 65 AND 79
      AND pick_side='over' AND odds>=100 AND game_date<DATE '2026-06-08' AND hit IS NOT NULL
  LOOP RAISE NOTICE '  n=% wins=% wr=% units=%', r.n, r.wins, r.wr, r.units; END LOOP;

  -- 3. D-479 AFTER (the key check)
  RAISE NOTICE '[D-506 FINAL] D-479 AFTER (gd>=6/8, MLB, GOOD-tier OVER >=+100):';
  FOR r IN
    SELECT count(*) AS n, count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND confidence BETWEEN 65 AND 79
      AND pick_side='over' AND odds>=100 AND game_date>=DATE '2026-06-08' AND hit IS NOT NULL
  LOOP RAISE NOTICE '  n=% wins=% wr=%', r.n, r.wins, r.wr; END LOOP;

  -- 4. D-479 cap-firing audit
  SELECT count(*) INTO v_cap_audit FROM public.pick_history_real
   WHERE sport='mlb' AND is_synthetic=false AND confidence BETWEEN 70 AND 79
     AND pick_side='over' AND odds>=100 AND game_date>=DATE '2026-06-08';
  RAISE NOTICE '[D-506 FINAL] D-479 cap-firing audit (should be 0): %', v_cap_audit;

  -- 5. D-499 pre-baseline
  SELECT count(*), ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2)
    INTO v_pre_n, v_pre_wr FROM public.pick_history_real
   WHERE sport='mlb' AND is_synthetic=false AND confidence>=60
     AND game_date BETWEEN DATE '2026-05-11' AND DATE '2026-06-09' AND hit IS NOT NULL;
  RAISE NOTICE '[D-506 FINAL] D-499 PRE-baseline (MLB conf>=60, 30d pre-apply): n=% wr=%',
    v_pre_n, v_pre_wr;

  -- 6. D-499 post-apply sample
  SELECT count(*), ROUND(100.0*count(*) FILTER (WHERE hit)/NULLIF(count(*),0), 2)
    INTO v_post_n, v_post_wr FROM public.pick_history_real
   WHERE sport='mlb' AND is_synthetic=false AND confidence>=60
     AND game_date>=DATE '2026-06-10' AND hit IS NOT NULL;
  RAISE NOTICE '[D-506 FINAL] D-499 POST-apply sample (MLB conf>=60, gd>=6/10): n=% wr=%',
    v_post_n, v_post_wr;
  IF v_post_n >= 50 AND v_pre_wr IS NOT NULL AND v_post_wr IS NOT NULL
     AND v_post_wr < (v_pre_wr - 5) THEN
    RAISE NOTICE '[D-506 FINAL] D-499 ROLLBACK TRIGGERED — % vs % (n=%)', v_post_wr, v_pre_wr, v_post_n;
  ELSIF v_post_n >= 50 THEN
    RAISE NOTICE '[D-506 FINAL] D-499 within band, no rollback (n=%)', v_post_n;
  ELSIF v_post_n >= 30 THEN
    RAISE NOTICE '[D-506 FINAL] D-499 early signal (n=% < 50 firm)', v_post_n;
  ELSE
    RAISE NOTICE '[D-506 FINAL] D-499 still too-early (n=% < 30)', v_post_n;
  END IF;

  -- 7. 5 spot-checks from the backfill (random)
  RAISE NOTICE '[D-506 FINAL] 5 random spot-checks (backfill-resolved post 02:11 UTC):';
  FOR r IN
    SELECT id, player_name, team, opponent, sport, mlb_market_type, prop_type,
           line, pick_side, odds, actual_value, hit, voided, game_date
    FROM public.pick_history
    WHERE is_synthetic = false
      AND resolved_at >= '2026-06-11 02:11:00+00'
    ORDER BY random() LIMIT 5
  LOOP
    RAISE NOTICE '  pid=%', r.id;
    RAISE NOTICE '    player=% gd=% market=% line=% side=% odds=%',
      r.player_name, r.game_date, r.mlb_market_type, r.line, r.pick_side, r.odds;
    RAISE NOTICE '    actual=% hit=% voided=%',
      r.actual_value, r.hit, r.voided;
  END LOOP;

  -- 8. Backfill outcome breakdown
  RAISE NOTICE '[D-506 FINAL] backfill outcome breakdown:';
  FOR r IN
    SELECT sport,
           count(*) FILTER (WHERE hit IS TRUE)  AS won,
           count(*) FILTER (WHERE hit IS FALSE) AS lost,
           count(*) FILTER (WHERE hit IS NULL AND resolved_at IS NOT NULL AND voided <> true) AS push,
           count(*) FILTER (WHERE voided = true) AS voided_n,
           count(*) AS total
    FROM public.pick_history
    WHERE is_synthetic = false
      AND resolved_at >= '2026-06-11 02:11:00+00'
    GROUP BY sport ORDER BY sport
  LOOP RAISE NOTICE '  sport=% won=% lost=% push=% voided=% total=%',
    r.sport, r.won, r.lost, r.push, r.voided_n, r.total; END LOOP;
END $$;
