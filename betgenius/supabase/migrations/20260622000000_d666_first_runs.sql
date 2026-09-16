-- D-666 — first-run dispatchers so the 17:00 UTC pregame tick finds:
--   1. Widened Statcast arsenal (min=50 → min=10)
--   2. Populated vs_lhp/vs_rhp K rates in cache_team_batting_stats
-- Both fns use BACKFILL_AUTH_TOKEN via vault; idempotent.
DO $$
DECLARE
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-666 first-runs deferred.';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-baseball-savant-weekly',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 540000
  );
  RAISE NOTICE 'D-666 dispatched: fetch-baseball-savant-weekly (Statcast widen min=50→10)';

  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-team-stats',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 180000
  );
  RAISE NOTICE 'D-666 dispatched: fetch-mlb-team-stats (vs_lhp/vs_rhp K rate populate)';
END $$;
