-- D-692 SHIP 1 — manually invoke resolve-picks ONCE with priority=oldest.
-- Starts with limit=100 (1/3 of original D-673 cron's 300). Reports the request
-- ID; the response lands in net._http_response asynchronously.
DO $$
DECLARE
  v_url   TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks';
  v_token TEXT;
  v_rid   BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'D-692 BACKFILL_AUTH_TOKEN missing — abort';
  END IF;

  v_rid := net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token
    ),
    body    := jsonb_build_object(
      'priority', 'oldest',
      'sport', 'mlb',
      'limit', 100,
      'since_days', 30
    ),
    timeout_milliseconds := 150000
  );
  RAISE NOTICE 'D-692 SHIP 1 — test invocation dispatched, net.http_post request_id=%, fire-and-forget; check net._http_response in ~30s', v_rid;
END $$;
