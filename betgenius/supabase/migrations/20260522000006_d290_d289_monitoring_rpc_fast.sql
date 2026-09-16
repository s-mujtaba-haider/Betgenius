-- D-290 SHIP 2 (2026-05-22) — speed up D-289 monitoring RPC.
--
-- Previous version counted cache_mlb_historical_odds rows which is now
-- 250K+ and growing — query exceeded statement_timeout. New version
-- uses pg_class.reltuples for fast approximate row counts (refreshed
-- by autovacuum/analyze; off by ~1% which is fine for monitoring).
--
-- Rollback:
--   keep prior version migration 20260522000005 active.

-- Drop old return-type to allow signature change
DROP FUNCTION IF EXISTS get_d289_backfill_progress();

CREATE OR REPLACE FUNCTION get_d289_backfill_progress()
RETURNS TABLE (
  total_events INTEGER,
  odds_complete INTEGER,
  odds_partial INTEGER,
  odds_pending INTEGER,
  odds_pct_done NUMERIC,
  outcomes_complete INTEGER,
  outcomes_no_match INTEGER,
  outcomes_pending INTEGER,
  outcomes_pct_done NUMERIC,
  odds_rows_approx BIGINT,
  outcomes_rows_approx BIGINT,
  last_odds_backfill_at TIMESTAMPTZ,
  events_oldest TIMESTAMPTZ,
  events_newest TIMESTAMPTZ,
  health_verdict TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total INTEGER;
  v_odds_complete INTEGER;
  v_odds_partial INTEGER;
  v_odds_pending INTEGER;
  v_outcomes_complete INTEGER;
  v_outcomes_no_match INTEGER;
  v_outcomes_pending INTEGER;
  v_last_odds_at TIMESTAMPTZ;
BEGIN
  SELECT COUNT(*) INTO v_total FROM public.cache_mlb_historical_events;
  SELECT COUNT(*) INTO v_odds_complete FROM public.cache_mlb_historical_events WHERE odds_backfill_status = 'complete';
  SELECT COUNT(*) INTO v_odds_partial FROM public.cache_mlb_historical_events WHERE odds_backfill_status = 'partial';
  SELECT COUNT(*) INTO v_odds_pending FROM public.cache_mlb_historical_events WHERE odds_backfill_status = 'pending';
  SELECT COUNT(*) INTO v_outcomes_complete FROM public.cache_mlb_historical_events WHERE outcomes_backfill_status = 'complete';
  SELECT COUNT(*) INTO v_outcomes_no_match FROM public.cache_mlb_historical_events WHERE outcomes_backfill_status = 'no_match';
  SELECT COUNT(*) INTO v_outcomes_pending FROM public.cache_mlb_historical_events WHERE outcomes_backfill_status = 'pending';
  SELECT MAX(odds_backfill_at) INTO v_last_odds_at FROM public.cache_mlb_historical_events WHERE odds_backfill_at IS NOT NULL;

  RETURN QUERY
  SELECT
    v_total,
    v_odds_complete,
    v_odds_partial,
    v_odds_pending,
    CASE WHEN v_total = 0 THEN 0 ELSE ROUND((v_odds_complete::numeric / v_total) * 100, 2) END,
    v_outcomes_complete,
    v_outcomes_no_match,
    v_outcomes_pending,
    CASE WHEN v_total = 0 THEN 0 ELSE ROUND(((v_outcomes_complete + v_outcomes_no_match)::numeric / v_total) * 100, 2) END,
    -- Approximate row counts via pg_class.reltuples (fast, off by ~1% post-analyze)
    (SELECT GREATEST(0, reltuples::bigint) FROM pg_class WHERE relname = 'cache_mlb_historical_odds'),
    (SELECT GREATEST(0, reltuples::bigint) FROM pg_class WHERE relname = 'cache_mlb_historical_outcomes'),
    v_last_odds_at,
    (SELECT MIN(commence_time) FROM public.cache_mlb_historical_events),
    (SELECT MAX(commence_time) FROM public.cache_mlb_historical_events),
    CASE
      WHEN v_odds_pending = 0 AND v_outcomes_pending = 0 THEN 'DONE'
      WHEN v_odds_pending > 0 AND v_last_odds_at > now() - interval '10 minutes' THEN 'ON_TRACK'
      WHEN v_odds_pending > 0 AND v_last_odds_at > now() - interval '60 minutes' THEN 'SLOW'
      WHEN v_odds_pending > 0 THEN 'STALLED'
      ELSE 'UNKNOWN'
    END;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_d289_backfill_progress() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_d289_backfill_progress() TO service_role;
GRANT EXECUTE ON FUNCTION get_d289_backfill_progress() TO authenticated;
