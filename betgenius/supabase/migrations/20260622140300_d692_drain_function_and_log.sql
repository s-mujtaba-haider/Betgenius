-- D-692 — Overnight backlog-drain orchestration.
--
-- SHIP 5 — run log table.
-- SHIP 4 — self-protect: DB-health probe inside the function (UTC-hour gate,
--   connection-count gate, long-running-query gate). If unhealthy → SKIP run,
--   log it, do NOT pile load on a struggling DB.
-- SHIP 2 — safe batch size: 100 picks per run (proven safe in SHIP 1 test —
--   42s wall time, no DB stress).
-- SHIP 3 — gated to 06:00 ≤ UTC-hour ≤ 10 (≈ 02:00–06:30 ET no-live-games window).
CREATE TABLE IF NOT EXISTS public.resolve_backlog_run_log (
  id                   BIGSERIAL PRIMARY KEY,
  run_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picks_resolved       INTEGER,              -- known after run completes (delta in backlog)
  backlog_before       INTEGER,
  backlog_after        INTEGER,              -- populated by next run's "before"
  duration_ms          INTEGER,              -- populated when net._http_response arrives
  db_health_ok         BOOLEAN NOT NULL,     -- false when health-probe skipped run
  skip_reason          TEXT,                 -- e.g. "out_of_window", "db_unhealthy"
  http_request_id      BIGINT,               -- from net.http_post
  http_status          INTEGER               -- populated after response lands
);
CREATE INDEX IF NOT EXISTS idx_resolve_backlog_run_log_run_at
  ON public.resolve_backlog_run_log (run_at DESC);

COMMENT ON TABLE public.resolve_backlog_run_log IS
  'D-692 SHIP 5 — per-run audit of resolve-picks-backlog-drain. Each row records timestamp, picks resolved (via backlog delta), DB health gate state, and HTTP request status. Morning-check query at the bottom of d692 doc.';

-- D-692 self-protecting drain function.
-- Pre-flight gates:
--   (1) UTC hour in [6, 10] inclusive (= 02:00 → 06:59 ET; cron fires :00/:15/:30/:45)
--   (2) total connections <= 50 (baseline ~12; flag at 50 means something heavy is happening)
--   (3) zero long-running queries (>60s active)
--   (4) backlog actually has rows remaining
-- If any gate trips → log a skip and exit. Otherwise → POST to resolve-picks
-- with limit=100, priority=oldest, since_days=30.
CREATE OR REPLACE FUNCTION public.drain_resolver_backlog()
RETURNS TEXT
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp, extensions
AS $$
DECLARE
  v_hour        INT := EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC');
  v_total_conn  INT;
  v_long_query  INT;
  v_backlog     INT;
  v_rid         BIGINT;
  v_url         TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks';
  v_token       TEXT;
  v_skip_reason TEXT;
BEGIN
  -- (1) UTC-hour gate (idle window 06:00-10:59 UTC = 02:00-06:59 ET)
  IF v_hour < 6 OR v_hour > 10 THEN
    v_skip_reason := format('out_of_window_utc_hour=%s', v_hour);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- (2) connection-count gate
  SELECT COUNT(*) INTO v_total_conn FROM pg_stat_activity;
  IF v_total_conn > 50 THEN
    v_skip_reason := format('db_unhealthy_connections=%s', v_total_conn);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- (3) long-running query gate (>60s)
  SELECT COUNT(*) INTO v_long_query FROM pg_stat_activity
   WHERE state IN ('active','idle in transaction')
     AND NOW() - query_start > INTERVAL '60 seconds'
     AND pid <> pg_backend_pid();
  IF v_long_query > 0 THEN
    v_skip_reason := format('db_unhealthy_long_queries=%s', v_long_query);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- (4) backlog count
  SELECT COUNT(*) INTO v_backlog
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';
  IF v_backlog = 0 THEN
    v_skip_reason := 'backlog_empty';
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, 0, TRUE, v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- All gates passed — fire one drain batch
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, v_backlog, FALSE, 'missing_auth_token');
    RETURN 'missing_auth_token';
  END IF;

  v_rid := net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token
    ),
    body    := jsonb_build_object(
      'priority',   'oldest',
      'sport',      'mlb',
      'limit',      100,           -- SHIP 2 — safe batch (verified at 42s in test)
      'since_days', 30
    ),
    timeout_milliseconds := 150000
  );

  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, http_request_id)
  VALUES (NULL, v_backlog, TRUE, v_rid);

  RETURN format('fired rid=%s backlog_before=%s', v_rid, v_backlog);
END $$;

GRANT EXECUTE ON FUNCTION public.drain_resolver_backlog() TO service_role;
GRANT EXECUTE ON FUNCTION public.drain_resolver_backlog() TO postgres;

COMMENT ON FUNCTION public.drain_resolver_backlog() IS
  'D-692 SHIP 3+4+5 — self-protecting backlog drainer. UTC-hour gate (6-10 only), connection-count gate (<=50), long-query gate, backlog gate, then POST to resolve-picks with limit=100/priority=oldest. Logs every fire to resolve_backlog_run_log. Safe to call from cron every 15 min — the gate self-noops outside the window.';

-- SHIP 3 — schedule cron. Calls drain_resolver_backlog() every 15 min always;
-- the function self-gates to the 06:00-10:59 UTC window. No need to gate at
-- cron level (pg_cron's CRON syntax for "only in window" is messy; cleaner to
-- put the gate inside the function).
DO $$
DECLARE v_jobid BIGINT;
BEGIN
  -- Remove any prior version of this cron (D-673 original + any stray)
  PERFORM cron.unschedule('resolve-picks-backlog-drain')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'resolve-picks-backlog-drain');
  PERFORM cron.unschedule('d692-drain-resolver-backlog')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'd692-drain-resolver-backlog');

  v_jobid := cron.schedule(
    'd692-drain-resolver-backlog',
    '*/15 * * * *',                            -- every 15 min; function gates by UTC hour
    $cmd$ SELECT public.drain_resolver_backlog(); $cmd$
  );
  RAISE NOTICE 'D-692 SHIP 3 — d692-drain-resolver-backlog scheduled jobid=% schedule=*/15 * * * *', v_jobid;

  -- Log a "scheduled" marker row so the run_log shows the kickoff
  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
  VALUES (NULL, NULL, TRUE, 'D-692 cron scheduled (kickoff marker)');
END $$;
