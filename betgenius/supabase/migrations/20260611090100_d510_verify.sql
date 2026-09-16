-- D-510 SHIP 2 verify: clear markers + trigger + observe
DELETE FROM public.mlb_scoring_progress WHERE game_date='20260611';
DO $$
DECLARE v_rid BIGINT;
BEGIN
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 200000
  ) INTO v_rid;
  RAISE NOTICE '[D-510 verify] trigger rid=%', v_rid;
END $$;
