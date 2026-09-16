DO $$
DECLARE v_rid BIGINT; v_pre_pending BIGINT;
BEGIN
  -- Capture pending count BEFORE
  SELECT count(*) INTO v_pre_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-30';
  RAISE NOTICE '[D-506] pre-trigger pending: %', v_pre_pending;

  -- Real resolve-picks call (empty body == cron default)
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO v_rid;
  RAISE NOTICE '[D-506] real resolve-picks trigger request_id=%', v_rid;
END $$;
