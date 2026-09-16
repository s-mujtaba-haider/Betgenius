-- D-290 SHIP 2 (2026-05-22) — D-289 backfill monitoring RPC.
--
-- Returns single-row snapshot of D-289 historical-data warehouse
-- backfill progress. CEO can query anytime for visibility into
-- where Phase 3 odds + Phase 4 outcomes stand without bothering
-- the active Claude session.
--
-- Usage:
--   SELECT * FROM get_d289_backfill_progress();
--
-- Rollback:
--   DROP FUNCTION IF EXISTS get_d289_backfill_progress();

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
  odds_rows_total BIGINT,
  outcomes_rows_total BIGINT,
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
BEGIN
  SELECT COUNT(*) INTO v_total FROM public.cache_mlb_historical_events;
  SELECT COUNT(*) INTO v_odds_complete FROM public.cache_mlb_historical_events WHERE odds_backfill_status = 'complete';
  SELECT COUNT(*) INTO v_odds_partial FROM public.cache_mlb_historical_events WHERE odds_backfill_status = 'partial';
  SELECT COUNT(*) INTO v_odds_pending FROM public.cache_mlb_historical_events WHERE odds_backfill_status = 'pending';
  SELECT COUNT(*) INTO v_outcomes_complete FROM public.cache_mlb_historical_events WHERE outcomes_backfill_status = 'complete';
  SELECT COUNT(*) INTO v_outcomes_no_match FROM public.cache_mlb_historical_events WHERE outcomes_backfill_status = 'no_match';
  SELECT COUNT(*) INTO v_outcomes_pending FROM public.cache_mlb_historical_events WHERE outcomes_backfill_status = 'pending';

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
    (SELECT COUNT(*) FROM public.cache_mlb_historical_odds),
    (SELECT COUNT(*) FROM public.cache_mlb_historical_outcomes),
    (SELECT MIN(commence_time) FROM public.cache_mlb_historical_events),
    (SELECT MAX(commence_time) FROM public.cache_mlb_historical_events),
    CASE
      WHEN v_odds_pending = 0 AND v_outcomes_pending = 0 THEN 'DONE'
      WHEN v_odds_pending > 0 AND (SELECT MAX(odds_backfill_at) FROM public.cache_mlb_historical_events) > now() - interval '10 minutes' THEN 'ON_TRACK'
      WHEN v_odds_pending > 0 AND (SELECT MAX(odds_backfill_at) FROM public.cache_mlb_historical_events) > now() - interval '60 minutes' THEN 'SLOW'
      WHEN v_odds_pending > 0 THEN 'STALLED'
      ELSE 'UNKNOWN'
    END;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_d289_backfill_progress() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_d289_backfill_progress() TO service_role;
GRANT EXECUTE ON FUNCTION get_d289_backfill_progress() TO authenticated;

COMMENT ON FUNCTION get_d289_backfill_progress() IS
  'D-290 SHIP 2: snapshot of D-289 backfill state. health_verdict: '
  'DONE | ON_TRACK | SLOW | STALLED | UNKNOWN based on last '
  'odds_backfill_at timestamp.';
