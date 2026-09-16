-- D-285 SHIP 2 (2026-05-21) — process-games-mlb runtime audit RPC.
--
-- Returns last 14 days of process-games-mlb run timings via cron_heartbeat.
-- Lets the audit-resolution-coverage daily check (D-275 SHIP 6) detect
-- runtime trend before it crosses the 150s IDLE_TIMEOUT wall.
--
-- Usage:
--   SELECT * FROM get_mlb_runtime_trend();
--   SELECT * FROM get_mlb_runtime_trend(7);  -- last 7 days only
--
-- Rollback:
--   DROP FUNCTION IF EXISTS get_mlb_runtime_trend(integer);

CREATE OR REPLACE FUNCTION get_mlb_runtime_trend(days_back INTEGER DEFAULT 14)
RETURNS TABLE (
  fired_at TIMESTAMPTZ,
  duration_ms BIGINT,
  status TEXT,
  is_warning BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    last_fired_at AS fired_at,
    last_duration_ms AS duration_ms,
    last_status AS status,
    (last_duration_ms > 130000) AS is_warning
  FROM public.cron_heartbeat
  WHERE job_name = 'process-games-mlb'
    AND last_fired_at >= now() - (days_back || ' days')::INTERVAL
  ORDER BY last_fired_at DESC;
$$;

REVOKE EXECUTE ON FUNCTION get_mlb_runtime_trend(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_mlb_runtime_trend(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION get_mlb_runtime_trend(INTEGER) TO authenticated;

COMMENT ON FUNCTION get_mlb_runtime_trend(INTEGER) IS
  'D-285 SHIP 2: returns process-games-mlb runtime trend from cron_heartbeat. '
  'is_warning=true when duration > 130s (the 20s-buffer threshold to 150s IDLE_TIMEOUT).';
