DO $$
DECLARE r RECORD; v_n INT; v_now TIMESTAMPTZ := NOW(); BEGIN
  RAISE NOTICE '──── D-687 SHIP 3 snapshot cadence ────';

  -- last 20 runs of each odds cron
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.status,
           EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::int AS dur_s
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE j.jobname IN ('snapshot-odds-writer-30min','fetch-odds-mlb-30min','fetch-odds-every-15min','fetch-odds-mlb-morning','fetch-odds-tomorrow')
      AND jrd.start_time >= NOW() - INTERVAL '4 hours'
    ORDER BY j.jobname, jrd.start_time DESC LIMIT 60
  LOOP
    RAISE NOTICE 'run: % start=% status=% dur=%s', r.jobname, r.start_time, r.status, r.dur_s;
  END LOOP;

  -- cache_odds_snapshots schema
  RAISE NOTICE '──── cache_odds_snapshots cols ────';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_odds_snapshots'
    ORDER BY ordinal_position LIMIT 20
  LOOP RAISE NOTICE 'snap col % (%)', r.column_name, r.data_type; END LOOP;

  -- snapshot total + latest
  BEGIN
    SELECT COUNT(*) INTO v_n FROM public.cache_odds_snapshots;
    RAISE NOTICE 'cache_odds_snapshots TOTAL rows: %', v_n;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'count failed'; END;

  -- last 12h cadence — group by 15-min bucket
  BEGIN
    RAISE NOTICE '──── snapshots per 15-min bucket last 6h ────';
    FOR r IN
      SELECT DATE_TRUNC('hour', snapshot_time) + INTERVAL '15 min' * (EXTRACT(MINUTE FROM snapshot_time)::int / 15) AS bucket,
             COUNT(*) AS n
      FROM public.cache_odds_snapshots
      WHERE snapshot_time >= NOW() - INTERVAL '6 hours'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 30
    LOOP
      RAISE NOTICE 'snap bucket=% n=%', r.bucket, r.n;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      RAISE NOTICE 'try captured_at instead:';
      FOR r IN
        SELECT DATE_TRUNC('hour', captured_at) + INTERVAL '15 min' * (EXTRACT(MINUTE FROM captured_at)::int / 15) AS bucket,
               COUNT(*) AS n
        FROM public.cache_odds_snapshots
        WHERE captured_at >= NOW() - INTERVAL '6 hours'
        GROUP BY 1 ORDER BY 1 DESC LIMIT 30
      LOOP
        RAISE NOTICE 'snap bucket=% n=%', r.bucket, r.n;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'cadence probe failed (col?)'; END;
  END;
END $$;
