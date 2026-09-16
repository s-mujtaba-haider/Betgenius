DO $$
DECLARE v_pending BIGINT; v_resolved_total BIGINT; v_voided_total BIGINT;
        r RECORD;
BEGIN
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';
  SELECT count(*) INTO v_resolved_total FROM public.pick_history
   WHERE resolved_at >= '2026-06-11 02:11:00+00';
  SELECT count(*) INTO v_voided_total FROM public.pick_history
   WHERE voided = true AND id IN (
     SELECT id FROM public.pick_history WHERE voided = true ORDER BY id DESC LIMIT 50000
   );

  RAISE NOTICE '[D-506 state] pending=% resolved_since_backfill_start=% (any voided=true total≈%)',
    v_pending, v_resolved_total, v_voided_total;

  RAISE NOTICE '[D-506 state] active resolve-picks crons:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname ILIKE '%resolve%' ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- pick_history_real freshness
  DECLARE v_total_real BIGINT; v_max_resolved DATE;
  BEGIN
    SELECT count(*), max(game_date) INTO v_total_real, v_max_resolved
    FROM public.pick_history_real WHERE is_synthetic = false;
    RAISE NOTICE '[D-506 state] pick_history_real total=% max_game_date=%',
      v_total_real, v_max_resolved;
  END;

  -- Pending breakdown by date (where are the holdouts?)
  RAISE NOTICE '[D-506 state] pending by date (top 10):';
  FOR r IN
    SELECT game_date, sport, count(*) AS n
    FROM public.pick_history
    WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
      AND is_synthetic = false AND game_date >= DATE '2026-05-28'
    GROUP BY game_date, sport ORDER BY game_date LIMIT 10
  LOOP RAISE NOTICE '  gd=% sport=% n=%', r.game_date, r.sport, r.n; END LOOP;
END $$;
