-- D-692 SHIP 7 — pre-window kickoff. UTC hour is 5 (out of normal 6-10 window),
-- but the user explicitly asked "start NOW, not at 2am". One immediate drain
-- batch of 100 picks fires; cron picks up the rest at 06:00 UTC.
DO $$
DECLARE
  v_token TEXT; v_rid BIGINT; v_backlog INT;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;

  SELECT COUNT(*) INTO v_backlog FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';

  v_rid := net.http_post(
    url     := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body    := jsonb_build_object('priority','oldest','sport','mlb','limit',100,'since_days',30),
    timeout_milliseconds := 150000
  );

  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, http_request_id, skip_reason)
  VALUES (NULL, v_backlog, TRUE, v_rid, 'D-692 SHIP 7 pre-window kickoff (gate-bypass)');

  RAISE NOTICE 'D-692 SHIP 7 — pre-window drain fired rid=% backlog_before=%', v_rid, v_backlog;
END $$;
