-- D-300V SHIP 3 (2026-05-24) — postponement + doubleheader edge-case monitor.
--
-- Detects:
--   1. Games in scoreboard with status='postponed' for today
--   2. Doubleheaders (same home_team + away_team + same date, 2+ rows)
--
-- Pre D-300V SHIP 2 fix, postponed games were stored as status='final'
-- (fetch-weather read abstractGameState which is "Final" for postponed).
-- SHIP 2 fixed this; SHIP 3 monitors so future stale cache reflecting
-- postponements get flagged before subscribers see them.
--
-- Rollback: DROP FUNCTION IF EXISTS get_mlb_edge_case_status(DATE);

CREATE OR REPLACE FUNCTION get_mlb_edge_case_status(check_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
  edge_case_type TEXT,
  detail TEXT,
  count BIGINT,
  rows JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Postponed games today
  RETURN QUERY
  SELECT
    'postponed'::TEXT,
    'Games with status=postponed for the target date'::TEXT,
    COUNT(*)::BIGINT,
    COALESCE(jsonb_agg(jsonb_build_object(
      'game_id', game_id,
      'home_team', home_team,
      'away_team', away_team,
      'fetched_at', fetched_at
    )) FILTER (WHERE game_id IS NOT NULL), '[]'::jsonb)
  FROM cache_mlb_game_scoreboard
  WHERE game_date = check_date AND status = 'postponed';

  -- Doubleheaders (same home/away pair appearing >= 2 times for the date)
  RETURN QUERY
  WITH pairs AS (
    SELECT home_team, away_team, COUNT(*) AS n, array_agg(game_id ORDER BY game_id) AS pks
    FROM cache_mlb_game_scoreboard
    WHERE game_date = check_date
    GROUP BY home_team, away_team
    HAVING COUNT(*) >= 2
  )
  SELECT
    'doubleheader'::TEXT,
    format('%s teams have multiple games scheduled this date', COUNT(*))::TEXT,
    COUNT(*)::BIGINT,
    COALESCE(jsonb_agg(jsonb_build_object(
      'home_team', home_team,
      'away_team', away_team,
      'game_ids', pks
    )), '[]'::jsonb)
  FROM pairs;

  -- Stale rows (fetched_at older than 12h for today's date)
  RETURN QUERY
  SELECT
    'stale_fetched_at'::TEXT,
    'Cache rows for target date not refreshed in last 12h'::TEXT,
    COUNT(*)::BIGINT,
    COALESCE(jsonb_agg(jsonb_build_object(
      'game_id', game_id,
      'home_team', home_team,
      'away_team', away_team,
      'status', status,
      'fetched_at', fetched_at,
      'hours_stale', EXTRACT(EPOCH FROM (now() - fetched_at)) / 3600
    )) FILTER (WHERE game_id IS NOT NULL), '[]'::jsonb)
  FROM cache_mlb_game_scoreboard
  WHERE game_date = check_date AND fetched_at < (now() - INTERVAL '12 hours');
END;
$$;

REVOKE EXECUTE ON FUNCTION get_mlb_edge_case_status(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_mlb_edge_case_status(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION get_mlb_edge_case_status(DATE) TO authenticated;

COMMENT ON FUNCTION get_mlb_edge_case_status(DATE) IS
  'D-300V: detect postponements + doubleheaders + stale cache rows for a target date. '
  'Returns one row per edge case type with details. Call with no arg for today.';
