-- D-669 SHIP 2 — one-shot first-run for fetch-savant-team-chase-weekly
-- so today's pregame tick has chase data.
DO $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-savant-team-chase-weekly',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  RAISE NOTICE 'D-669 SHIP 2 first-run dispatched: fetch-savant-team-chase-weekly';
END $$;
