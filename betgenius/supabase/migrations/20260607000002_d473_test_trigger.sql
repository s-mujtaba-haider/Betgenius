-- D-473 SHIP 2 test trigger: invoke process-games-mlb with body game_date=20260607
-- to verify the progressive cron shards on tomorrow's slate (today's all D-374-Live).
-- One-off idempotent no-op on db reset.
DO $$
BEGIN
  PERFORM net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{"game_date":"20260607"}'::jsonb,
    timeout_milliseconds := 150000
  );
  RAISE NOTICE '[D-473 test1] http_post enqueued for 20260607 — wait ~100s then query checkpoints';
END $$;
