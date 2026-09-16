DO $$ DECLARE r RECORD; v_result TEXT; v_token TEXT; v_rid BIGINT; v_pending INT; BEGIN
  -- Confirm cron registered (proof, not claim)
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname IN ('d694-recent-resolver','d692-drain-resolver-backlog') ORDER BY jobname
  LOOP RAISE NOTICE 'cron: jobid=% name=% schedule=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- Current hour
  RAISE NOTICE 'NOW UTC hour: %', EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC');

  -- Kick off via the function (it'll gate-skip if hour not in 22-06; current is 12 UTC so it skips)
  v_result := public.resolve_recent_picks_with_gate();
  RAISE NOTICE 'gated kickoff result: %', v_result;

  -- ALSO fire immediately bypassing the gate (CEO said start NOW to clear yesterday + 4 bets)
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT COUNT(*) INTO v_pending FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
      AND game_time::timestamptz < NOW() - INTERVAL '3 hours'
      AND game_time::timestamptz > NOW() - INTERVAL '48 hours';
  v_rid := net.http_post(
    url     := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body    := jsonb_build_object('priority','recent','sport','mlb','limit',300,'since_days',2),
    timeout_milliseconds := 150000
  );
  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, http_request_id, skip_reason)
  VALUES (NULL, v_pending, TRUE, v_rid, 'D-694 kickoff pre-window (gate-bypass) — clear yesterday + 4 bets');
  RAISE NOTICE 'kickoff fired rid=% pending_before=%', v_rid, v_pending;
END $$;
