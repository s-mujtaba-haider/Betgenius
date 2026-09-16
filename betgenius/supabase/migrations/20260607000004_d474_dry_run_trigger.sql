-- D-474 SHIP 1/2 dry-run sanity trigger: invoke process-games-mlb with
-- body {dry_run: true, game_date: 20260607} to validate that scoreBatterStrikeouts
-- produces sane K projections without touching production tables. One-off
-- idempotent no-op on db reset.
DO $$
BEGIN
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{"game_date":"20260607","dry_run":true}'::jsonb,
    timeout_milliseconds := 150000
  );
  RAISE NOTICE '[D-474 dry-run] http_post enqueued; check checkpoint + dry-run sample';
END $$;
