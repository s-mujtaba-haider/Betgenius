-- D-361 SHIP 2 — vault auth fix for 3 silently-401'ing crons.
--
-- BACKGROUND (per d361_diagnose.md / §15.0 items #17 + #21):
--   3 crons remain on the broken `current_setting('app.settings.service_role_key', true)`
--   GUC pattern that D-313 already fixed for orchestrator-* crons. The GUC
--   evaluates to NULL on this DB (no app.* GUCs set) → Authorization header
--   becomes "Bearer " → gateway returns 401 → pg_cron records SQL as
--   `succeeded` because it only checks SQL exit code, not HTTP status.
--
-- TARGETS:
--   jobid 3 — resolve-picks-nightly      schedule "30 5 * * *"     body '{}'
--   jobid 6 — fetch-odds-every-15min     schedule "*/15 * * * *"   body '{"dateOffset":0}'
--   jobid 7 — fetch-odds-tomorrow        schedule "0 */2 * * *"    body '{"dateOffset":1}'
--
-- FIX: switch each to the D-313 vault-auth pattern from migration
-- 20260525000016_d313_cron_auth_vault.sql. Verified working for
-- orchestrator-execute since 2026-05-25.
--
-- Schedule + body + jobid preserved via cron.alter_job. Only the command
-- body changes.
--
-- ROLLBACK:
--   DO $$
--   DECLARE v_id BIGINT;
--   BEGIN
--     SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'resolve-picks-nightly';
--     IF v_id IS NOT NULL THEN
--       PERFORM cron.alter_job(v_id, command := $cmd$
--         SELECT net.http_post(
--           url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
--           headers := jsonb_build_object(
--             'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
--             'Content-Type', 'application/json'
--           ),
--           body := '{}'::jsonb
--         );
--       $cmd$);
--     END IF;
--     -- ... same for jobid 6 / 7 with their bodies ...
--   END $$;

DO $$
DECLARE
  v_resolve_jobid BIGINT;
  v_odds_today_jobid BIGINT;
  v_odds_tomorrow_jobid BIGINT;
  v_vault_len INTEGER;
BEGIN
  -- Verify vault secret exists before altering any crons (matches D-313 belt).
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-361] vault.decrypted_secrets has no BACKFILL_AUTH_TOKEN — abort. D-313 + D-330 + D-331 + D-341 crons depend on this same secret; if absent here we have a different problem.';
  END IF;
  RAISE NOTICE '[D-361] vault BACKFILL_AUTH_TOKEN found, length=%', v_vault_len;

  -- Look up each jobid by jobname so the migration is idempotent across DB resets.
  SELECT jobid INTO v_resolve_jobid       FROM cron.job WHERE jobname = 'resolve-picks-nightly';
  SELECT jobid INTO v_odds_today_jobid    FROM cron.job WHERE jobname = 'fetch-odds-every-15min';
  SELECT jobid INTO v_odds_tomorrow_jobid FROM cron.job WHERE jobname = 'fetch-odds-tomorrow';

  -- (1) resolve-picks-nightly — preserve body '{}' + raise timeout to 150s
  --     (resolve-picks iterates many picks; default 60s sometimes times out
  --     and the nightly job needs the full window).
  IF v_resolve_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_resolve_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 150000
        );
      $cmd$
    );
    RAISE NOTICE '[D-361] resolve-picks-nightly (jobid=%) auth switched to vault BACKFILL_AUTH_TOKEN', v_resolve_jobid;
  ELSE
    RAISE NOTICE '[D-361] resolve-picks-nightly NOT FOUND in cron.job — skipping';
  END IF;

  -- (2) fetch-odds-every-15min — preserve body '{"dateOffset":0}'
  IF v_odds_today_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_odds_today_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-odds',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{"dateOffset": 0}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    );
    RAISE NOTICE '[D-361] fetch-odds-every-15min (jobid=%) auth switched to vault BACKFILL_AUTH_TOKEN', v_odds_today_jobid;
  ELSE
    RAISE NOTICE '[D-361] fetch-odds-every-15min NOT FOUND in cron.job — skipping';
  END IF;

  -- (3) fetch-odds-tomorrow — preserve body '{"dateOffset":1}'
  IF v_odds_tomorrow_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_odds_tomorrow_jobid,
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-odds',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{"dateOffset": 1}'::jsonb,
          timeout_milliseconds := 60000
        );
      $cmd$
    );
    RAISE NOTICE '[D-361] fetch-odds-tomorrow (jobid=%) auth switched to vault BACKFILL_AUTH_TOKEN', v_odds_tomorrow_jobid;
  ELSE
    RAISE NOTICE '[D-361] fetch-odds-tomorrow NOT FOUND in cron.job — skipping';
  END IF;
END $$;
