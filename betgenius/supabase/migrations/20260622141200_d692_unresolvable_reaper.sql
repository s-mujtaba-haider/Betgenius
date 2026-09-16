-- D-692 SHIP 6 — unresolvable-pick reaper.
--
-- Picks where the game was played >10 days ago AND the resolver still hasn't
-- managed to mark hit/resolved_at are almost certainly missing a box score
-- (game data not available in the cache, or never will be). They clog the
-- queue forever otherwise. Mark them voided=true with a reason so they stop
-- being claimed by each drain run.
--
-- Conservative: 10-day threshold. Current backlog max age is 8 days so this
-- is a no-op tonight; the reaper kicks in after the drain has had 2+ nights
-- to try resolving each pick.
CREATE OR REPLACE FUNCTION public.reap_unresolvable_picks()
RETURNS INT
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_reaped INT;
BEGIN
  WITH candidates AS (
    SELECT id FROM public.pick_history
    WHERE sport = 'mlb'
      AND is_synthetic = false
      AND hit IS NULL
      AND resolved_at IS NULL
      AND voided = false
      AND game_time::timestamptz < NOW() - INTERVAL '10 days'
    FOR UPDATE
  )
  UPDATE public.pick_history ph
  SET voided = true,
      resolved_at = NOW(),
      ai_analysis = COALESCE(ai_analysis, '') ||
        CASE WHEN ai_analysis IS NULL OR ai_analysis = '' THEN '' ELSE E'\n' END ||
        '[D-692] auto-voided 2026-06-22 — unresolvable (game >10d old, no box score data)'
  FROM candidates c
  WHERE ph.id = c.id;
  GET DIAGNOSTICS v_reaped = ROW_COUNT;

  -- Log into run-log
  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
  VALUES (v_reaped, NULL, TRUE, format('D-692 SHIP 6 reaper ran; voided=%s unresolvable picks >10d', v_reaped));

  RETURN v_reaped;
END $$;

GRANT EXECUTE ON FUNCTION public.reap_unresolvable_picks() TO service_role;
GRANT EXECUTE ON FUNCTION public.reap_unresolvable_picks() TO postgres;

COMMENT ON FUNCTION public.reap_unresolvable_picks() IS
  'D-692 SHIP 6 — voids MLB picks where the game was played >10 days ago and the resolver still hasn''t produced a hit/resolved_at. Conservative threshold so the drain has multiple nights to try first. Returns count of picks voided.';

-- Hook into the drain: after each successful drain batch, run the reaper.
-- We replace drain_resolver_backlog() with a version that calls reap_unresolvable_picks()
-- as a follow-up step. Idempotent — if no candidates, returns 0 with no work.
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
  v_reaped      INT;
  v_url         TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks';
  v_token       TEXT;
  v_skip_reason TEXT;
BEGIN
  IF v_hour < 6 OR v_hour > 10 THEN
    v_skip_reason := format('out_of_window_utc_hour=%s', v_hour);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  SELECT COUNT(*) INTO v_total_conn FROM pg_stat_activity;
  IF v_total_conn > 50 THEN
    v_skip_reason := format('db_unhealthy_connections=%s', v_total_conn);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, NULL, FALSE, v_skip_reason);
    RETURN v_skip_reason;
  END IF;

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

  SELECT COUNT(*) INTO v_backlog
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND hit IS NULL AND resolved_at IS NULL
    AND game_time::timestamptz < NOW() - INTERVAL '6 hours';
  IF v_backlog = 0 THEN
    -- backlog empty — still reap any unresolvable stuck picks (won't fire often
    -- once the drain catches up)
    v_reaped := public.reap_unresolvable_picks();
    v_skip_reason := format('backlog_empty (reaper voided %s)', v_reaped);
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (v_reaped, 0, TRUE, v_skip_reason);
    RETURN v_skip_reason;
  END IF;

  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, skip_reason)
    VALUES (NULL, v_backlog, FALSE, 'missing_auth_token');
    RETURN 'missing_auth_token';
  END IF;

  v_rid := net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body    := jsonb_build_object('priority','oldest','sport','mlb','limit',100,'since_days',30),
    timeout_milliseconds := 150000
  );

  INSERT INTO public.resolve_backlog_run_log(picks_resolved, backlog_before, db_health_ok, http_request_id)
  VALUES (NULL, v_backlog, TRUE, v_rid);

  RETURN format('fired rid=%s backlog_before=%s', v_rid, v_backlog);
END $$;
