-- D-640 — one-off RPC that fires fetch-weather using the vault token
-- (the same path pg_cron uses). Lets the operator re-trigger today's
-- weather fetch after deploying a fetch-weather fix without waiting
-- for the next 4-hour cron slot.
-- Rollback: DROP FUNCTION public.d640_fire_fetch_weather();

CREATE OR REPLACE FUNCTION public.d640_fire_fetch_weather()
RETURNS BIGINT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  request_id BIGINT;
BEGIN
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-weather',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) INTO request_id;
  RETURN request_id;
END $$;
GRANT EXECUTE ON FUNCTION public.d640_fire_fetch_weather() TO service_role;
