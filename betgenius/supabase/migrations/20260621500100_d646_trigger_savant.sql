-- D-646 — one-off pg_net trigger to refresh the arsenal cache after
-- the fetch-baseball-savant-weekly URL/aggregation fix lands. The
-- weekly cron runs Sundays (`0 8 * * 0`); we don't want to wait until
-- 2026-06-22 for verification. Dropped via 20260621501000.
CREATE OR REPLACE FUNCTION public.d646_fire_savant()
RETURNS BIGINT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
DECLARE rid BIGINT;
BEGIN
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-baseball-savant-weekly',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  ) INTO rid;
  RETURN rid;
END $$;
GRANT EXECUTE ON FUNCTION public.d646_fire_savant() TO service_role;
