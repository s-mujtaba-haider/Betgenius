-- ML Optimizer Phase 7 — switch jobid 12 cron to run-optimizer-v2 (May 7).
--
-- Updates jobid=12 (auto-optimizer-weekly, Sunday 11:00 UTC):
--   OLD URL: /functions/v1/run-optimizer  (single-weight ±0.25 coordinate
--            descent; routes proposals through apply_optimized_weights_with_gate_synthetic)
--   NEW URL: /functions/v1/run-optimizer-v2  (multi-weight + larger steps +
--            walk-forward validation; conditional apply only on APPROVE)
--
-- Direct UPDATE on cron.job is permission-denied for the postgres role we
-- connect as via supabase pooler — uses cron.alter_job() instead, which is
-- the supported privileged API in pg_cron 1.5+.
--
-- Auth pattern preserved: current_setting('app.backfill_auth_token', true).
-- This GUC is empty at every level (verified by 20260507000010). When CEO is
-- online they need to populate it via vault.create_secret or ALTER ROLE
-- postgres SET app.backfill_auth_token. Until then, cron fire will return
-- 401 → run-optimizer-v2 emits a `critical` notification. That's the
-- acceptable failure mode (audit trail surfaces the problem); the auth
-- gap is preexisting (jobid 12 today would also fail Sunday with same auth).
--
-- The switch is SAFER than staying on run-optimizer regardless of auth
-- outcome: even after auth is fixed, run-optimizer-v2 will only mutate
-- algorithm_weights when walk-forward decides APPROVE — i.e. when the train
-- delta transfers to the held-out validate window. Old run-optimizer would
-- apply changes based purely on training-data improvements (no held-out
-- validation), which is exactly the failure mode the May 7 ML upgrade
-- addresses.
--
-- Old run-optimizer edge function STAYS deployed for rollback. To roll back:
--   SELECT cron.alter_job(12, command := <old command>);
-- with the original command captured below in v_before NOTICE output.

DO $$
DECLARE
  v_before TEXT;
  v_after TEXT;
  v_new_cmd CONSTANT TEXT := $cmd$
    SELECT net.http_post(
      url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/run-optimizer-v2',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || current_setting('app.backfill_auth_token', true),
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 180000
    );
  $cmd$;
BEGIN
  SELECT command INTO v_before FROM cron.job WHERE jobid = 12;
  RAISE NOTICE '[Phase 7 switch] jobid 12 BEFORE: %', LEFT(v_before, 400);

  -- Use cron.alter_job to update only the command, preserving schedule and
  -- jobname. Function signature (pg_cron 1.5+):
  --   cron.alter_job(job_id BIGINT, schedule TEXT DEFAULT NULL,
  --                   command TEXT DEFAULT NULL, database TEXT DEFAULT NULL,
  --                   username TEXT DEFAULT NULL, active BOOLEAN DEFAULT NULL)
  PERFORM cron.alter_job(
    job_id := 12,
    command := v_new_cmd
  );

  SELECT command INTO v_after FROM cron.job WHERE jobid = 12;
  RAISE NOTICE '[Phase 7 switch] jobid 12 AFTER : %', LEFT(v_after, 400);

  IF v_after LIKE '%run-optimizer-v2%' THEN
    RAISE NOTICE '[Phase 7 switch] OK — jobid 12 now points at run-optimizer-v2. Schedule unchanged: Sunday 11:00 UTC = 6am ET.';
  ELSE
    RAISE EXCEPTION '[Phase 7 switch] cron.alter_job appears to have run but command does not contain run-optimizer-v2 string';
  END IF;
END $$;
