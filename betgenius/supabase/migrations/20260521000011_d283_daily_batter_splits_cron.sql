-- D-283 SHIP 3 (2026-05-21) — schedule fetch-mlb-batter-splits daily.
--
-- Daily 5 AM ET (09:00 UTC). Pulls today's batter names from
-- props_cache, resolves player_ids via MLB Stats API /people/search,
-- fetches statSplits vs LHP/RHP, upserts to cache_mlb_batter_splits.
--
-- Rollback:
--   SELECT cron.unschedule('fetch-mlb-batter-splits');

DO $$
DECLARE
  v_old bigint;
  v_new bigint;
BEGIN
  SELECT jobid INTO v_old FROM cron.job WHERE jobname = 'fetch-mlb-batter-splits' LIMIT 1;
  IF v_old IS NOT NULL THEN
    PERFORM cron.unschedule(v_old);
    RAISE NOTICE '[D-283] unscheduled existing fetch-mlb-batter-splits jobid=%', v_old;
  END IF;

  SELECT cron.schedule(
    'fetch-mlb-batter-splits',
    '0 9 * * *',  -- 09:00 UTC = 5 AM ET daily
    $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-mlb-batter-splits',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1
          ),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
      );
    $cmd$
  ) INTO v_new;
  RAISE NOTICE '[D-283] scheduled fetch-mlb-batter-splits as jobid=%', v_new;
END $$;

-- Seed cron_heartbeat row
INSERT INTO public.cron_heartbeat (job_name, last_status, last_fired_at, expected_interval_seconds)
VALUES ('fetch-mlb-batter-splits', 'success', now(), 86400)
ON CONFLICT (job_name) DO UPDATE SET expected_interval_seconds = EXCLUDED.expected_interval_seconds;
