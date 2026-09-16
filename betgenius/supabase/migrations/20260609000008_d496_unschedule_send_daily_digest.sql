-- D-496 (2026-06-09) — Kill the jobid=24 silent 404 + sweep for any other
-- cron pointing at a non-deployed function. CEO-APPROVED unschedule.
--
-- BACKGROUND (D-495 finding): cron jobid=24 'send-daily-digest-daily'
-- fires daily at `0 13 * * *` UTC against
-- `/functions/v1/send-daily-digest`. The function is on-disk
-- (supabase/functions/send-daily-digest/index.ts) but NOT deployed to
-- the Supabase platform. pg_net.http_post logs the call as "success"
-- regardless of HTTP code → 0 user-visible symptom, silent 404 daily.
-- Same silent-failure class as D-457 (Anthropic outage 46h) and
-- D-480 (silent pick loss 24h).
--
-- THIS MIGRATION:
--   1. Confirms jobid=24 is still send-daily-digest-daily
--      → send-daily-digest before acting (match-by-jobname guard
--      so a since-renumbered job isn't accidentally unscheduled).
--   2. Sweeps every cron, extracts each target fn name from its
--      command via regex on the `/functions/v1/<name>` URL, and
--      RAISE NOTICEs the (jobid, jobname, target_fn) tuple so the
--      apply output supports an offline cross-check against the
--      deployed-functions list.
--   3. Calls `cron.unschedule('send-daily-digest-daily')` (by name,
--      not jobid — safer against jobid drift).
--   4. Post-confirms the job is gone + cron count delta = -1.
--
-- ROLLBACK:
--   To restore the cron exactly as it was (NOT recommended — the
--   function would still 404 unless deployed first):
--   SELECT cron.schedule(
--     'send-daily-digest-daily',
--     '0 13 * * *',
--     $cmd$
--       SELECT net.http_post(
--         url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/send-daily-digest',
--         headers := jsonb_build_object(
--           'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
--           'Content-Type', 'application/json'
--         ),
--         body := '{}'::jsonb,
--         timeout_milliseconds := 30000
--       );
--     $cmd$
--   );

DO $$
DECLARE
  r RECORD;
  v_jobid     BIGINT;
  v_jobname   TEXT;
  v_target_fn TEXT;
  v_pre_count INTEGER;
  v_post_count INTEGER;
BEGIN
  ----------------------------------------------------------------
  -- 1. CONFIRM target
  ----------------------------------------------------------------
  SELECT jobid, jobname INTO v_jobid, v_jobname
  FROM cron.job WHERE jobname = 'send-daily-digest-daily';

  IF v_jobid IS NULL THEN
    RAISE NOTICE '[D-496] send-daily-digest-daily NOT FOUND in cron.job — already removed?';
    RETURN;
  END IF;

  RAISE NOTICE '[D-496] CONFIRMED target: jobid=% jobname=% (matches D-495 finding)',
    v_jobid, v_jobname;

  ----------------------------------------------------------------
  -- 2. SWEEP all crons → target fn cross-check material
  ----------------------------------------------------------------
  RAISE NOTICE '[D-496] SWEEP — every active cron with its extracted target fn:';
  FOR r IN
    SELECT
      jobid,
      jobname,
      schedule,
      active,
      (regexp_match(command, '/functions/v1/([a-z0-9-]+)'))[1] AS target_fn
    FROM cron.job
    ORDER BY jobid
  LOOP
    RAISE NOTICE '[D-496 SWEEP] jobid=% jobname=% schedule=% active=% target_fn=%',
      r.jobid, r.jobname, r.schedule, r.active, r.target_fn;
  END LOOP;

  SELECT count(*) INTO v_pre_count FROM cron.job;
  RAISE NOTICE '[D-496] PRE: total cron count = %', v_pre_count;

  ----------------------------------------------------------------
  -- 3. UNSCHEDULE by jobname (jobid-drift-safe)
  ----------------------------------------------------------------
  PERFORM cron.unschedule('send-daily-digest-daily');
  RAISE NOTICE '[D-496] unscheduled send-daily-digest-daily (jobid was %)', v_jobid;

  ----------------------------------------------------------------
  -- 4. POST-CONFIRM gone + count delta
  ----------------------------------------------------------------
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'send-daily-digest-daily';
  IF v_jobid IS NOT NULL THEN
    RAISE EXCEPTION '[D-496] FAIL — send-daily-digest-daily still present (jobid=%)', v_jobid;
  END IF;

  SELECT count(*) INTO v_post_count FROM cron.job;
  RAISE NOTICE '[D-496] POST: total cron count = % (delta = %)',
    v_post_count, v_post_count - v_pre_count;

  IF v_post_count <> v_pre_count - 1 THEN
    RAISE EXCEPTION '[D-496] FAIL — expected count delta -1, got %', v_post_count - v_pre_count;
  END IF;

  RAISE NOTICE '[D-496] silent-404 closed. cron count: % → %', v_pre_count, v_post_count;
END $$;
