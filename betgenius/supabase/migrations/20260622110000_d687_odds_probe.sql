DO $$
DECLARE r RECORD; v_n INT; v_now TIMESTAMPTZ := NOW(); BEGIN
  RAISE NOTICE '──── D-687 NOW=% ────', v_now;

  -- 1) Odds/snapshot named crons
  RAISE NOTICE '──── odds + snapshot crons in cron.job ────';
  FOR r IN
    SELECT jobname, schedule, active FROM cron.job
    WHERE jobname LIKE '%odds%' OR jobname LIKE '%snapshot%' OR jobname LIKE '%closing%'
    ORDER BY jobname
  LOOP
    RAISE NOTICE 'cron: % | schedule=% | enabled=%', r.jobname, r.schedule, r.active;
  END LOOP;

  -- 2) D-681 _d681_cron_pause_log: any odds/snapshot in pause-list?
  RAISE NOTICE '──── D-681 pause-log: any odds/snapshot jobs? ────';
  FOR r IN
    SELECT DISTINCT jobname, action FROM public._d681_cron_pause_log
    WHERE (jobname LIKE '%odds%' OR jobname LIKE '%snapshot%' OR jobname LIKE '%closing%')
      AND action IN ('unscheduled','restored','not_present')
    ORDER BY jobname, action
  LOOP
    RAISE NOTICE 'pause-log: % -> %', r.jobname, r.action;
  END LOOP;

  -- 3) Last 15 runs per odds cron (last 6h)
  RAISE NOTICE '──── last runs per odds cron (6h) ────';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.end_time, jrd.status,
           EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::int AS dur_s
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE (j.jobname LIKE '%odds%' OR j.jobname LIKE '%snapshot%' OR j.jobname LIKE '%closing%')
      AND jrd.start_time >= NOW() - INTERVAL '6 hours'
    ORDER BY j.jobname, jrd.start_time DESC LIMIT 80
  LOOP
    RAISE NOTICE 'run: % | %@ start=% end=% status=% dur=%s',
      LPAD(r.dur_s::TEXT, 4), r.jobname, r.start_time, r.end_time, r.status, r.dur_s;
  END LOOP;

  -- 4) cache_odds_snapshots table presence + cols
  RAISE NOTICE '──── cache_odds_snapshots schema + state ────';
  BEGIN
    FOR r IN
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='cache_odds_snapshots'
      ORDER BY ordinal_position LIMIT 15
    LOOP RAISE NOTICE 'snap col % (%)', r.column_name, r.data_type; END LOOP;
    SELECT COUNT(*) INTO v_n FROM public.cache_odds_snapshots;
    RAISE NOTICE 'cache_odds_snapshots total rows: %', v_n;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cache_odds_snapshots: NOT PRESENT'; END;

  -- 5) Recent snapshots overall
  BEGIN
    SELECT COUNT(*) INTO v_n FROM public.cache_odds_snapshots WHERE snapshot_time >= NOW() - INTERVAL '6 hours';
    RAISE NOTICE 'snapshots last 6h total: %', v_n;
    SELECT MAX(snapshot_time) INTO v_now FROM public.cache_odds_snapshots;
    RAISE NOTICE 'latest snapshot_time: %', v_now;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      SELECT COUNT(*) INTO v_n FROM public.cache_odds_snapshots WHERE captured_at >= NOW() - INTERVAL '6 hours';
      RAISE NOTICE 'snapshots last 6h (via captured_at): %', v_n;
      SELECT MAX(captured_at) INTO v_now FROM public.cache_odds_snapshots;
      RAISE NOTICE 'latest captured_at: %', v_now;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'no snapshot_time/captured_at col'; END;
  END;
END $$;
