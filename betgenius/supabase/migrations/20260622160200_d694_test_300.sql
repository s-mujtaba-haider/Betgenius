DO $$
DECLARE v_token TEXT; v_rid BIGINT; v_before INT; BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT COUNT(*) INTO v_before FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
      AND game_time::timestamptz >= '2026-06-21T00:00:00Z' AND game_time::timestamptz < '2026-06-22T00:00:00Z';
  RAISE NOTICE 'D-694 SHIP 1 test 300 — yesterday pending BEFORE: %', v_before;
  v_rid := net.http_post(
    url     := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body    := jsonb_build_object('priority','recent','sport','mlb','limit',300,'since_days',7),
    timeout_milliseconds := 150000
  );
  RAISE NOTICE 'fired rid=%', v_rid;
END $$;
