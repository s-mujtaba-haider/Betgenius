-- D-459 (2026-06-06) — Sonnet-focused health-check cron + persistent health_status table.
--
-- WHY: D-457 (Anthropic credit-zero outage) ran 46 HOURS undetected because
-- nothing actively probed the Sonnet API. health-monitor (D-302/D-147/D-151)
-- watches generic infra (error_log accumulation, run_log freshness for
-- NBA process-games, silent_failure_pattern) — but it has three D-457-class
-- gaps:
--   (a) no direct Anthropic API probe → can't detect a healthy-error_log
--       state where Sonnet is failing silently inside try/catch
--   (b) run_log freshness check watches `function_name=eq.process-games`
--       (NBA), NOT `process-games-mlb` (the MLB path that broke)
--   (c) no persistent health_status table — health-monitor results live
--       only in the HTTP response + notification_log writes on alert path
--
-- This migration creates a Sonnet-focused d459-sonnet-health function that
-- runs HOURLY and writes structured ok/warn/fail rows to a new health_status
-- table, complementing health-monitor's existing generic checks.
--
-- The 4 D-459 checks:
--   1. Sonnet probe          — minimal 1-token Anthropic call; ok if 200, fail otherwise
--   2. sonnet_400 rate        — count sonnet_http_error rows last 1h, threshold 5
--   3. MLB cron freshness    — process-games-mlb run_log last fire vs expected interval
--   4. MLB write velocity    — pick_history rows written last hour during cron window
--
-- Cron cost: ~$0.00001/probe × 24/day = $0.00024/month negligible (D-463 sonnet_usage_log
-- will track if probe ever spikes).
--
-- ROLLBACK:
--   DELETE FROM cron.job WHERE jobname = 'd459-sonnet-health-hourly';
--   DROP TABLE public.health_status;

-- =====================================================================
-- TABLE: health_status (append-only log of health-check results)
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.health_status (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- which check fired this row; one of:
  --   'sonnet_probe', 'sonnet_400_rate',
  --   'mlb_cron_freshness', 'mlb_write_velocity'
  check_name  text NOT NULL,

  -- outcome severity:
  --   'ok'   — check passed
  --   'warn' — threshold approaching (e.g., 1-4 sonnet_400s/hour)
  --   'fail' — check failed (e.g., Sonnet probe returned non-200,
  --            >=5 sonnet_400s/hour)
  --   'info' — informational (e.g., outside cron window, skipped)
  status      text NOT NULL CHECK (status IN ('ok', 'warn', 'fail', 'info')),

  -- human-readable summary
  detail      text NOT NULL,

  -- structured payload (probe response, counts, thresholds, etc.)
  metadata    jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_health_status_created_at
  ON public.health_status(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_status_check_name_created_at
  ON public.health_status(check_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_health_status_status
  ON public.health_status(status) WHERE status IN ('warn', 'fail');

COMMENT ON TABLE public.health_status IS
  'D-459 (2026-06-06). Persistent log of d459-sonnet-health check results. '
  'One row per (check_name, run) — append-only. CEO morning glance: '
  'SELECT * FROM health_status WHERE status IN (''warn'',''fail'') AND '
  'created_at >= NOW() - INTERVAL ''24 hours'' ORDER BY created_at DESC.';

-- =====================================================================
-- CRON: d459-sonnet-health hourly
-- =====================================================================
DO $$
DECLARE
  v_vault_len INTEGER;
  v_existing_jobid BIGINT;
BEGIN
  -- Verify vault auth secret exists (matches D-313 + D-361 pattern).
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-459] vault.decrypted_secrets has no BACKFILL_AUTH_TOKEN — abort.';
  END IF;
  RAISE NOTICE '[D-459] vault BACKFILL_AUTH_TOKEN found, length=%', v_vault_len;

  -- Idempotent: if cron already exists (re-run), update it; else schedule fresh.
  SELECT jobid INTO v_existing_jobid FROM cron.job WHERE jobname = 'd459-sonnet-health-hourly';

  IF v_existing_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_existing_jobid,
      schedule := '7 * * * *',  -- every hour at :07 (offset from typical :00 cron crush)
      command := $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/d459-sonnet-health',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    );
    RAISE NOTICE '[D-459] altered existing cron jobid=%', v_existing_jobid;
  ELSE
    PERFORM cron.schedule(
      'd459-sonnet-health-hourly',
      '7 * * * *',
      $cmd$
        SELECT net.http_post(
          url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/d459-sonnet-health',
          headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      $cmd$
    );
    RAISE NOTICE '[D-459] scheduled new cron d459-sonnet-health-hourly';
  END IF;
END $$;

-- Read access for dashboards/analytics
GRANT SELECT ON public.health_status TO anon, authenticated;
