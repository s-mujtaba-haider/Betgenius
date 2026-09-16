-- D-694 — Recent-first daily resolver, sized to cover ~2,000-pick daily slate.
--
-- SHIP 1 — safe batch size = 300 (verified: 300 picks resolved in ~130s, DB
--   stayed at 13 connections, 0 long queries).
-- SHIP 2 — schedule every hour 22 UTC → 06 UTC (9 fires per night during the
--   post-game window when East Coast → West Coast finals land). 9 × 300 =
--   2,700/day capacity vs ~2,000/day slate.
-- SHIP 3 — priority='recent' so it picks up yesterday's finals first (the 4
--   stuck bets + 967 yesterday-cohort pending).
-- SHIP 5 — same DB-health gate pattern as D-692 drain. Skip if stressed.
-- SHIP 4 — D-692 drain (oldest-first */15 06:00-10:59 UTC) preserved as-is.

CREATE OR REPLACE FUNCTION public.resolve_recent_picks_with_gate()
RETURNS TEXT
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp, extensions
AS $$
DECLARE
  v_hour        INT := EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC');
  v_total_conn  INT;
  v_long_query  INT;
  v_pending     INT;
  v_rid         BIGINT;
  v_url         TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks';
  v_token       TEXT;
  v_skip_reason TEXT;
BEGIN
  -- (1) UTC-hour gate (post-game window: 22 UTC → 06 UTC inclusive).
  -- The cron itself ALSO gates on the schedule string, but defense-in-depth.
  IF v_hour NOT IN (22, 23, 0, 1, 2, 3, 4, 5, 6) THEN
    v_skip_reason := format('out_of_window_utc_hour=%s', v_hour);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, 'D-694 ' || v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- (2) connection count gate (same threshold as D-692 drain — 50)
  SELECT COUNT(*) INTO v_total_conn FROM pg_stat_activity;
  IF v_total_conn > 50 THEN
    v_skip_reason := format('db_unhealthy_connections=%s', v_total_conn);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, 'D-694 ' || v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- (3) long-running query gate
  SELECT COUNT(*) INTO v_long_query FROM pg_stat_activity
   WHERE state IN ('active','idle in transaction')
     AND NOW() - query_start > INTERVAL '60 seconds'
     AND pid <> pg_backend_pid();
  IF v_long_query > 0 THEN
    v_skip_reason := format('db_unhealthy_long_queries=%s', v_long_query);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, 'D-694 ' || v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- (4) pending count over last 48h (recent-first window).
  -- 48h covers: late East Coast finals (today), West Coast finals (tonight),
  -- previous day's stragglers. Older picks are the d692 drain's job.
  SELECT COUNT(*) INTO v_pending
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '3 hours'   -- game must be over
    AND game_time::timestamptz > NOW() - INTERVAL '48 hours'; -- recent only
  IF v_pending = 0 THEN
    v_skip_reason := 'pending_recent_empty';
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, 0, TRUE, 'D-694 ' || v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  -- All gates passed — fire one recent batch.
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, v_pending, FALSE, 'D-694 missing_auth_token');
    RETURN 'missing_auth_token';
  END IF;

  v_rid := net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body    := jsonb_build_object(
      'priority',   'recent',
      'sport',      'mlb',
      'limit',      300,           -- safe batch verified in SHIP 1
      'since_days', 2              -- only last 48h finals
    ),
    timeout_milliseconds := 150000
  );

  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, http_request_id, skip_reason)
  VALUES (NULL, v_pending, TRUE, v_rid, 'D-694 recent-first fire');

  RETURN format('fired rid=%s pending_before=%s', v_rid, v_pending);
END $$;

GRANT EXECUTE ON FUNCTION public.resolve_recent_picks_with_gate() TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_recent_picks_with_gate() TO postgres;

COMMENT ON FUNCTION public.resolve_recent_picks_with_gate() IS
  'D-694 — recent-first resolver wrapper. UTC hour 22-06 gate + connection/long-query/pending gates + 300-pick batch via resolve-picks edge fn. Designed to cover the ~2,000-pick daily slate same-day. D-692 drain (oldest-first) handles the older backlog.';

-- SHIP 2 — schedule. Fire HOURLY during the post-game window.
DO $$
DECLARE v_jobid BIGINT;
BEGIN
  PERFORM cron.unschedule('d694-recent-resolver')
   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'd694-recent-resolver');

  -- Hourly 22, 23, 00, 01, 02, 03, 04, 05, 06 UTC = 9 fires per night
  v_jobid := cron.schedule(
    'd694-recent-resolver',
    '0 22,23,0,1,2,3,4,5,6 * * *',
    $cmd$ SELECT public.resolve_recent_picks_with_gate(); $cmd$
  );
  RAISE NOTICE 'D-694 SHIP 2 — d694-recent-resolver scheduled jobid=% schedule=0 22,23,0,1,2,3,4,5,6 * * *', v_jobid;

  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
  VALUES (NULL, NULL, TRUE, 'D-694 cron scheduled (kickoff marker)');
END $$;
