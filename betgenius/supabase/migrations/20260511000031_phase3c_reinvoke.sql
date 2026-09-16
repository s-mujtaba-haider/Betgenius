DO $$
DECLARE v_request_id BIGINT; v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/backfill-historical',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object('startDate', '2026-04-25', 'endDate', '2026-04-25', 'sport', 'nba',
      'dryRun', false, 'requireServiceRoleKey', true,
      'algorithmVersion', '2026-05-11-phase3c-verify'),
    timeout_milliseconds := 120000
  ) INTO v_request_id;
  RAISE NOTICE 'Phase 3c invoked: request_id=%', v_request_id;
END $$;
