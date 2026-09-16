-- D-492 (2026-06-09) — Atomic rename of d459 cron + function name to semantic.
--
-- Renames the deployed function URL target from `d459-sonnet-health` →
-- `sonnet-health-monitor` and the cron jobname from
-- `d459-sonnet-health-hourly` → `sonnet-health-monitor-hourly`.
--
-- Sequencing (atomic — single migration, single tx by default):
--   1. cron.unschedule old jobname (idempotent — guarded by SELECT)
--   2. cron.schedule new jobname pointing at new function URL
--
-- New function `sonnet-health-monitor` was already deployed
-- (npx supabase functions deploy sonnet-health-monitor --no-verify-jwt)
-- and boot-verified (HTTP 401 unauthorized = reachable + auth-rejects).
-- The old function `d459-sonnet-health` will be deleted from disk in the
-- D-492 SHIP 3 commit AFTER this migration applies + new cron is registered.
--
-- Schedule preserved: '7 * * * *' (hourly at minute 7).
-- Auth pattern preserved: vault BACKFILL_AUTH_TOKEN.
-- Body / timeout preserved.
--
-- ROLLBACK:
--   SELECT cron.unschedule('sonnet-health-monitor-hourly');
--   PERFORM cron.schedule(
--     'd459-sonnet-health-hourly',
--     '7 * * * *',
--     $cmd$ SELECT net.http_post(
--       url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/d459-sonnet-health',
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
--         'Content-Type', 'application/json'
--       ),
--       body := '{}'::jsonb,
--       timeout_milliseconds := 30000
--     ); $cmd$
--   );
--   (Then redeploy d459-sonnet-health from prior git SHA if function dir already deleted.)

DO $$
DECLARE
  v_vault_len INTEGER;
  v_old_jobid BIGINT;
  v_new_jobid BIGINT;
BEGIN
  -- Verify vault auth secret still present (matches D-459 + D-313 pattern).
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-492] vault.decrypted_secrets has no BACKFILL_AUTH_TOKEN — abort.';
  END IF;
  RAISE NOTICE '[D-492] vault BACKFILL_AUTH_TOKEN present, length=%', v_vault_len;

  -- 1. Unschedule the old cron (idempotent — only acts if present).
  SELECT jobid INTO v_old_jobid FROM cron.job WHERE jobname = 'd459-sonnet-health-hourly';
  IF v_old_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_old_jobid);
    RAISE NOTICE '[D-492] unscheduled old jobid=% (d459-sonnet-health-hourly)', v_old_jobid;
  ELSE
    RAISE NOTICE '[D-492] no existing d459-sonnet-health-hourly cron found — already migrated?';
  END IF;

  -- 2. Schedule the new cron (idempotent — alter if present, schedule if not).
  SELECT jobid INTO v_new_jobid FROM cron.job WHERE jobname = 'sonnet-health-monitor-hourly';

  IF v_new_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_new_jobid,
      schedule := '7 * * * *',
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/sonnet-health-monitor',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    );
    RAISE NOTICE '[D-492] altered existing new cron jobid=%', v_new_jobid;
  ELSE
    PERFORM cron.schedule(
      'sonnet-health-monitor-hourly',
      '7 * * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/sonnet-health-monitor',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    );
    RAISE NOTICE '[D-492] scheduled new cron sonnet-health-monitor-hourly';
  END IF;

  -- 3. Sanity check: new cron is now registered.
  SELECT jobid INTO v_new_jobid FROM cron.job WHERE jobname = 'sonnet-health-monitor-hourly';
  IF v_new_jobid IS NULL THEN
    RAISE EXCEPTION '[D-492] post-migration sanity check failed: sonnet-health-monitor-hourly not in cron.job';
  END IF;
  RAISE NOTICE '[D-492] new cron registered jobid=%; old gone.', v_new_jobid;
END $$;
