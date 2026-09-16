-- D-365 SHIP 2 — production-incident fix. CEO authorized via AskUserQuestion.
-- Part A: sync vault.secrets.BACKFILL_AUTH_TOKEN to D-358 UUID (matches env).
-- Part B: migrate 4 GUC-broken crons (jobids 1, 2, 9, 31) to vault pattern.

-- Part A — use vault.update_secret() API (direct UPDATE on vault.secrets is RLS-denied)
DO $$
DECLARE
  v_target TEXT := '0e843fb5-6107-4eca-981b-4698fbf49f85';
  v_secret_id UUID;
BEGIN
  SELECT id INTO v_secret_id FROM vault.secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(v_secret_id, v_target);
    RAISE NOTICE '[D-365] vault BACKFILL_AUTH_TOKEN updated via vault.update_secret (id=%)', v_secret_id;
  ELSE
    PERFORM vault.create_secret(v_target, 'BACKFILL_AUTH_TOKEN', 'D-365 sync to env');
    RAISE NOTICE '[D-365] vault BACKFILL_AUTH_TOKEN created via vault.create_secret';
  END IF;
END $$;

-- Part B
DO $$
DECLARE
  v1 BIGINT; v2 BIGINT; v9 BIGINT; v31 BIGINT;
  v_vault_len INT;
BEGIN
  SELECT length(decrypted_secret) INTO v_vault_len FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-365] vault BACKFILL_AUTH_TOKEN missing after Part A';
  END IF;

  SELECT jobid INTO v1  FROM cron.job WHERE jobname = 'resolve-picks-daily';
  SELECT jobid INTO v2  FROM cron.job WHERE jobname = 'resolve-picks-cleanup';
  SELECT jobid INTO v9  FROM cron.job WHERE jobname = 'process-games-progressive';
  SELECT jobid INTO v31 FROM cron.job WHERE jobname = 'dashboard-health-check-2h';

  IF v1 IS NOT NULL THEN
    PERFORM cron.alter_job(v1, command := $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cmd$);
    RAISE NOTICE '[D-365] resolve-picks-daily jobid=% switched', v1;
  END IF;

  IF v2 IS NOT NULL THEN
    PERFORM cron.alter_job(v2, command := $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cmd$);
    RAISE NOTICE '[D-365] resolve-picks-cleanup jobid=% switched', v2;
  END IF;

  IF v9 IS NOT NULL THEN
    PERFORM cron.alter_job(v9, command := $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000
      );
    $cmd$);
    RAISE NOTICE '[D-365] process-games-progressive jobid=% switched', v9;
  END IF;

  IF v31 IS NOT NULL THEN
    PERFORM cron.alter_job(v31, command := $cmd$
      SELECT net.http_post(
        url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/dashboard-health-check',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $cmd$);
    RAISE NOTICE '[D-365] dashboard-health-check-2h jobid=% switched', v31;
  END IF;
END $$;
