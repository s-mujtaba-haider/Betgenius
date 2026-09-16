-- D-273-OPPSTATS (2026-05-20) — snapshot-opp-stats cron reschedule.
--
-- Symptom: jobid=11 ("snapshot-opp-stats", 0 12 * * *) has been
-- failing for 13 consecutive days since 2026-05-07. last_run_status =
-- 'failed', last_run_duration_ms ≈ 5ms — the function returns
-- before any meaningful work, consistent with an immediate 401
-- (Authorization header missing or stale token) or 500 (env missing).
--
-- The function code (supabase/functions/snapshot-opp-stats/index.ts
-- line 295-303) requires an Authorization header that matches either
-- the service-role key or BACKFILL_AUTH_TOKEN. The original cron
-- schedule was set via SQL Editor (per the function header comment),
-- not via migration, so the command form isn't versioned in this
-- repo. Most likely the original schedule embedded a since-rotated
-- BACKFILL_AUTH_TOKEN or omitted the Authorization header entirely.
--
-- Fix: unschedule + reschedule using the canonical
-- vault.decrypted_secrets pattern that
-- 20260515000005_d186_schedule_fetch_team_advanced_stats.sql
-- established. Same pattern → auth always reads the live secret.
--
-- Rollback:
--   SELECT cron.unschedule('snapshot-opp-stats');

DO $$
DECLARE
  v_old_jobid bigint;
  v_new_jobid bigint;
BEGIN
  -- Drop any existing schedule with this name (idempotent).
  SELECT jobid INTO v_old_jobid FROM cron.job WHERE jobname = 'snapshot-opp-stats' LIMIT 1;
  IF v_old_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_old_jobid);
    RAISE NOTICE '[D-273-OPPSTATS] unscheduled existing jobid=%', v_old_jobid;
  END IF;

  -- Reschedule using the canonical vault-backed auth pattern that
  -- fetch-team-advanced-stats-daily uses (known-working).
  SELECT cron.schedule(
    'snapshot-opp-stats',
    '0 12 * * *',    -- 12:00 UTC daily (same as before; matches function comment)
    $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/snapshot-opp-stats',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1
          ),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cmd$
  ) INTO v_new_jobid;
  RAISE NOTICE '[D-273-OPPSTATS] rescheduled as jobid=%', v_new_jobid;
END $$;
