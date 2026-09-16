-- D-507 — Daily break sweep, last 24h. READ-ONLY.
DO $$
DECLARE r RECORD;
BEGIN
  -- 1. error_log
  RAISE NOTICE '[D-507 §1] error_log last 24h:';
  FOR r IN
    SELECT error_type, count(*) AS n
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY error_type ORDER BY n DESC
  LOOP RAISE NOTICE '  type=% n=%', r.error_type, r.n; END LOOP;

  -- 2. health_status warns/fails
  RAISE NOTICE '[D-507 §2] health_status warn/fail last 24h:';
  FOR r IN
    SELECT check_name, status, detail, created_at
    FROM public.health_status
    WHERE status IN ('warn','fail') AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC LIMIT 30
  LOOP RAISE NOTICE '  check=% status=% at=% detail=%',
    r.check_name, r.status, r.created_at, COALESCE(left(r.detail, 200),'<null>'); END LOOP;

  -- 3a. resolve-picks: resolved count last 24h
  DECLARE v_resolved_24h BIGINT;
  BEGIN
    SELECT count(*) INTO v_resolved_24h FROM public.pick_history
     WHERE resolved_at > NOW() - INTERVAL '24 hours';
    RAISE NOTICE '[D-507 §3a] resolve-picks: picks resolved in last 24h = %', v_resolved_24h;
  END;

  -- 3b. process-games-mlb ticks (5-min cadence expected)
  RAISE NOTICE '[D-507 §3b] process-games-mlb cron last 6 ticks:';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.status,
           ROUND(EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::NUMERIC, 1) AS runtime_s
    FROM cron.job j
    JOIN cron.job_run_details jrd ON jrd.jobid = j.jobid
    WHERE j.jobname ILIKE '%process-games%mlb%'
       OR j.jobname ILIKE '%mlb%process%'
       OR j.jobname ILIKE '%process-games%'
    ORDER BY jrd.start_time DESC LIMIT 6
  LOOP RAISE NOTICE '  job=% at=% status=% runtime_s=%',
    r.jobname, r.start_time, r.status, r.runtime_s; END LOOP;

  -- 3c. Today's slate coverage
  DECLARE v_today DATE := CURRENT_DATE;
      v_today_eastern DATE := (NOW() AT TIME ZONE 'America/New_York')::DATE;
      v_scoring_count BIGINT; v_schedule_count BIGINT;
  BEGIN
    -- mlb_scoring_progress count for today
    BEGIN
      SELECT count(*) INTO v_scoring_count FROM public.mlb_scoring_progress
       WHERE game_date = v_today_eastern;
    EXCEPTION WHEN OTHERS THEN v_scoring_count := -1; END;
    -- games scheduled today (from mlb_schedule or games table)
    BEGIN
      SELECT count(*) INTO v_schedule_count FROM public.games
       WHERE game_date = v_today_eastern AND sport = 'mlb';
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        SELECT count(*) INTO v_schedule_count FROM public.mlb_schedule
         WHERE game_date = v_today_eastern;
      EXCEPTION WHEN OTHERS THEN v_schedule_count := -1; END;
    END;
    RAISE NOTICE '[D-507 §3c] today=% (ET) mlb_scoring_progress=% schedule_count=%',
      v_today_eastern, v_scoring_count, v_schedule_count;
  END;

  -- 4. Writes landing
  DECLARE v_ph_today BIGINT; v_rpc_failed BIGINT; v_rec_today BIGINT; v_rec_max TIMESTAMPTZ;
  BEGIN
    SELECT count(*) INTO v_ph_today FROM public.pick_history
     WHERE created_at >= (NOW() AT TIME ZONE 'America/New_York')::DATE
       AND is_synthetic = false;
    RAISE NOTICE '[D-507 §4a] pick_history non-syn rows created today (ET) = %', v_ph_today;

    BEGIN
      SELECT count(*) INTO v_rpc_failed FROM public.error_log
       WHERE error_type ILIKE '%rpc_failed%' AND created_at > NOW() - INTERVAL '24 hours';
    EXCEPTION WHEN OTHERS THEN v_rpc_failed := -1; END;
    RAISE NOTICE '[D-507 §4b] error_log type=rpc_failed last 24h = %', v_rpc_failed;

    BEGIN
      SELECT count(*), max(created_at) INTO v_rec_today, v_rec_max
      FROM public.recommendations_cache
       WHERE created_at > NOW() - INTERVAL '24 hours';
    EXCEPTION WHEN OTHERS THEN v_rec_today := -1; END;
    RAISE NOTICE '[D-507 §4c] recommendations_cache last 24h: n=% max_created=%',
      v_rec_today, v_rec_max;
  END;

  -- 5. Long tick check: any cron run > 130s last 24h
  RAISE NOTICE '[D-507 §5] max cron tick runtime in last 24h (top 10 by runtime):';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.status,
           ROUND(EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::NUMERIC, 1) AS runtime_s
    FROM cron.job j
    JOIN cron.job_run_details jrd ON jrd.jobid = j.jobid
    WHERE jrd.start_time > NOW() - INTERVAL '24 hours'
      AND jrd.end_time IS NOT NULL
    ORDER BY (jrd.end_time - jrd.start_time) DESC NULLS LAST
    LIMIT 10
  LOOP RAISE NOTICE '  job=% at=% status=% runtime_s=%',
    r.jobname, r.start_time, r.status, r.runtime_s; END LOOP;

  -- 5b. Specifically: runtime_approaching_timeout error_log entries last 24h
  RAISE NOTICE '[D-507 §5b] runtime_approaching_timeout error_log entries last 24h:';
  FOR r IN
    SELECT created_at, error_type, function_name,
           left(COALESCE(error_message,''), 200) AS msg
    FROM public.error_log
    WHERE error_type ILIKE '%runtime%' OR error_type ILIKE '%timeout%'
       OR error_message ILIKE '%runtime_approaching_timeout%'
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% type=% fn=% msg=%',
    r.created_at, r.error_type, r.function_name, r.msg; END LOOP;
END $$;
