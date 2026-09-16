-- D-293 SHIP 2 (2026-05-23) — derive rolling-14d team pitching proxy
-- from cache_mlb_historical_outcomes. Populates cache_mlb_historical_bullpen.
--
-- HONEST DISCLOSURE (Cardinal §1.20):
-- True bullpen-only ERA requires per-game boxscore traversal to
-- distinguish starter vs. reliever pitchers (~14k API calls for
-- 2023-2025). This SQL derives TEAM-LEVEL pitching proxy from data
-- already in outcomes:
--   rolling_14d_era       → team runs allowed per 9 IP (RA/9 proxy, NOT ER-based)
--   rolling_14d_k_per_9   → sum of pitcher SO / sum of pitcher IP × 9
--   rolling_14d_ip        → sum of pitcher IP across all pitchers in last 14 games
--   rolling_14d_whip      → NULL (no hits-allowed or walks in resolution_data)
--   rolling_14d_bb_per_9  → NULL (no walks in resolution_data)
--   games_in_window       → distinct games count in trailing 14 days
--
-- Replay tier: PROXY (team-level, not bullpen-specific).
--
-- Rollback:
--   TRUNCATE cache_mlb_historical_bullpen;
--   DROP FUNCTION IF EXISTS d293_derive_bullpen_snapshots();

CREATE OR REPLACE FUNCTION d293_derive_bullpen_snapshots()
RETURNS TABLE(rows_inserted BIGINT, distinct_teams BIGINT, distinct_dates BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '600s'
AS $$
DECLARE
  v_inserted BIGINT;
  v_teams BIGINT;
  v_dates BIGINT;
BEGIN
  -- Step 1: flatten outcomes into per-team-per-game pitching rows
  WITH per_team_game AS (
    -- Home team perspective: runs allowed = away_score
    SELECT
      o.event_id,
      o.home_team AS team_name,
      (o.commence_time AT TIME ZONE 'America/New_York')::date AS game_date,
      o.away_score AS runs_allowed,
      (
        SELECT COALESCE(SUM((v->>'strikeouts')::numeric), 0)
        FROM jsonb_each(o.resolution_data) AS x(k, v)
        WHERE v ? 'innings_pitched' AND v ? 'strikeouts'
      ) AS pitcher_so_sum,
      (
        SELECT COALESCE(SUM((v->>'innings_pitched')::numeric), 0)
        FROM jsonb_each(o.resolution_data) AS x(k, v)
        WHERE v ? 'innings_pitched'
      ) AS pitcher_ip_sum
    FROM public.cache_mlb_historical_outcomes o
    WHERE o.game_completed = TRUE AND o.resolution_data IS NOT NULL
    UNION ALL
    -- Away team perspective: runs allowed = home_score
    -- (note: pitcher_so/ip aggregates are double-counted to BOTH teams since
    -- resolution_data doesn't split by team — accepted limitation, see disclosure)
    SELECT
      o.event_id,
      o.away_team AS team_name,
      (o.commence_time AT TIME ZONE 'America/New_York')::date AS game_date,
      o.home_score AS runs_allowed,
      (
        SELECT COALESCE(SUM((v->>'strikeouts')::numeric), 0)
        FROM jsonb_each(o.resolution_data) AS x(k, v)
        WHERE v ? 'innings_pitched' AND v ? 'strikeouts'
      ) AS pitcher_so_sum,
      (
        SELECT COALESCE(SUM((v->>'innings_pitched')::numeric), 0)
        FROM jsonb_each(o.resolution_data) AS x(k, v)
        WHERE v ? 'innings_pitched'
      ) AS pitcher_ip_sum
    FROM public.cache_mlb_historical_outcomes o
    WHERE o.game_completed = TRUE AND o.resolution_data IS NOT NULL
  ),
  team_dates AS (
    -- For each team, every date they played
    SELECT DISTINCT team_name, game_date FROM per_team_game
  ),
  rolling AS (
    -- For each (team, date), aggregate last 14 days of games for that team
    SELECT
      td.team_name,
      td.game_date AS snapshot_date,
      COUNT(*) FILTER (WHERE p.game_date BETWEEN td.game_date - INTERVAL '14 days' AND td.game_date - INTERVAL '1 day') AS games_in_window,
      SUM(p.runs_allowed) FILTER (WHERE p.game_date BETWEEN td.game_date - INTERVAL '14 days' AND td.game_date - INTERVAL '1 day') AS sum_ra,
      SUM(p.pitcher_ip_sum) FILTER (WHERE p.game_date BETWEEN td.game_date - INTERVAL '14 days' AND td.game_date - INTERVAL '1 day') AS sum_ip,
      SUM(p.pitcher_so_sum) FILTER (WHERE p.game_date BETWEEN td.game_date - INTERVAL '14 days' AND td.game_date - INTERVAL '1 day') AS sum_so
    FROM team_dates td
    JOIN per_team_game p ON p.team_name = td.team_name
    GROUP BY td.team_name, td.game_date
  )
  INSERT INTO public.cache_mlb_historical_bullpen
    (team_name, snapshot_date, rolling_14d_era, rolling_14d_whip, rolling_14d_ip, rolling_14d_k_per_9, rolling_14d_bb_per_9, games_in_window, fetched_at)
  SELECT
    team_name,
    snapshot_date,
    CASE WHEN sum_ip > 0 THEN ROUND((sum_ra::numeric * 9.0 / sum_ip), 3) ELSE NULL END,
    NULL,
    ROUND(sum_ip::numeric, 2),
    CASE WHEN sum_ip > 0 THEN ROUND((sum_so::numeric * 9.0 / sum_ip), 3) ELSE NULL END,
    NULL,
    games_in_window,
    now()
  FROM rolling
  WHERE games_in_window > 0
  ON CONFLICT (team_name, snapshot_date) DO UPDATE SET
    rolling_14d_era = EXCLUDED.rolling_14d_era,
    rolling_14d_ip = EXCLUDED.rolling_14d_ip,
    rolling_14d_k_per_9 = EXCLUDED.rolling_14d_k_per_9,
    games_in_window = EXCLUDED.games_in_window,
    fetched_at = EXCLUDED.fetched_at;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  SELECT COUNT(DISTINCT team_name), COUNT(DISTINCT snapshot_date)
    INTO v_teams, v_dates FROM public.cache_mlb_historical_bullpen;

  RETURN QUERY SELECT v_inserted, v_teams, v_dates;
END;
$$;

REVOKE EXECUTE ON FUNCTION d293_derive_bullpen_snapshots() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION d293_derive_bullpen_snapshots() TO service_role;

COMMENT ON FUNCTION d293_derive_bullpen_snapshots() IS
  'D-293 SHIP 2: derive rolling-14d team-pitching proxy snapshots '
  'from cache_mlb_historical_outcomes. NOT bullpen-only (would need '
  'boxscore traversal). rolling_14d_era is RA/9 proxy; WHIP + BB/9 '
  'are NULL (not in outcomes resolution_data).';
