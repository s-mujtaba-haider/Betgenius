DO $$
DECLARE r RECORD; v_remaining BIGINT; v_resolved_5min BIGINT; v_resolved_10min BIGINT;
BEGIN
  SELECT count(*) INTO v_remaining FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-28';

  SELECT count(*) INTO v_resolved_5min FROM public.pick_history
   WHERE resolved_at >= NOW() - INTERVAL '5 minutes';
  SELECT count(*) INTO v_resolved_10min FROM public.pick_history
   WHERE resolved_at >= NOW() - INTERVAL '10 minutes';

  RAISE NOTICE '[D-506 SHIP 3 progress] pending=%, resolved 5min=%, resolved 10min=%',
    v_remaining, v_resolved_5min, v_resolved_10min;

  -- recent backfill cron runs
  RAISE NOTICE '[D-506 SHIP 3 progress] last 10 backfill cron runs:';
  FOR r IN
    SELECT start_time, status, length(COALESCE(return_message,'')) AS rmsglen
    FROM cron.job_run_details
    WHERE jobid = 43
    ORDER BY start_time DESC LIMIT 10
  LOOP
    RAISE NOTICE '  start=% status=% rmsg_len=%', r.start_time, r.status, r.rmsglen;
  END LOOP;

  -- last 5 resolve-picks response status codes from net._http_response
  RAISE NOTICE '[D-506 SHIP 3 progress] last 5 resolve-picks function responses:';
  FOR r IN
    SELECT id, status_code, length(content::text) AS blen, created
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '20 minutes'
    ORDER BY created DESC LIMIT 5
  LOOP
    RAISE NOTICE '  rid=% status=% blen=% created=%',
      r.id, r.status_code, r.blen, r.created;
  END LOOP;
END $$;
