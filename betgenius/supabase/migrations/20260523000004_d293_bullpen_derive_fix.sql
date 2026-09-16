-- D-293 SHIP 2 FIX (2026-05-23) — correct RA/9 calculation in
-- d293_derive_bullpen_snapshots.
--
-- BUG (caught via Cardinal §1.20 ground-truth check):
-- Initial version summed pitcher_ip from resolution_data for both
-- the home-team row and the away-team row, but resolution_data
-- doesn't split pitchers by team. So sum_ip was ~2× the actual
-- IP that team's pitchers threw, yielding RA/9 ≈ ½ of reality
-- (Braves Sep 28 2025 saw 1.83 instead of the real ~3.6).
--
-- FIX: use games_in_window * 9.0 as the IP denominator. This is a
-- 9-IP-per-game assumption (close to truth; extra innings/short
-- games average out across 14d windows). The pitcher_so_sum can no
-- longer feed k_per_9 either (same double-count), so we use
-- per-game SO directly instead.
--
-- Rollback: revert to 20260523000003 version.

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
  -- Clear before recompute (table is derived, idempotent rebuild)
  TRUNCATE public.cache_mlb_historical_bullpen;

  WITH per_team_game AS (
    -- HOME team perspective
    SELECT
      o.event_id,
      o.home_team AS team_name,
      (o.commence_time AT TIME ZONE 'America/New_York')::date AS game_date,
      o.away_score AS runs_allowed,
      (
        SELECT COALESCE(SUM((v->>'strikeouts')::numeric), 0) / 2.0
        FROM jsonb_each(o.resolution_data) AS x(k, v)
        WHERE v ? 'innings_pitched' AND v ? 'strikeouts'
      ) AS pitcher_so_approx
    FROM public.cache_mlb_historical_outcomes o
    WHERE o.game_completed = TRUE AND o.resolution_data IS NOT NULL
    UNION ALL
    -- AWAY team perspective
    SELECT
      o.event_id,
      o.away_team AS team_name,
      (o.commence_time AT TIME ZONE 'America/New_York')::date AS game_date,
      o.home_score AS runs_allowed,
      (
        SELECT COALESCE(SUM((v->>'strikeouts')::numeric), 0) / 2.0
        FROM jsonb_each(o.resolution_data) AS x(k, v)
        WHERE v ? 'innings_pitched' AND v ? 'strikeouts'
      ) AS pitcher_so_approx
    FROM public.cache_mlb_historical_outcomes o
    WHERE o.game_completed = TRUE AND o.resolution_data IS NOT NULL
  ),
  team_dates AS (
    SELECT DISTINCT team_name, game_date FROM per_team_game
  ),
  rolling AS (
    SELECT
      td.team_name,
      td.game_date AS snapshot_date,
      COUNT(*) FILTER (WHERE p.game_date BETWEEN td.game_date - INTERVAL '14 days' AND td.game_date - INTERVAL '1 day') AS games_in_window,
      SUM(p.runs_allowed) FILTER (WHERE p.game_date BETWEEN td.game_date - INTERVAL '14 days' AND td.game_date - INTERVAL '1 day') AS sum_ra,
      SUM(p.pitcher_so_approx) FILTER (WHERE p.game_date BETWEEN td.game_date - INTERVAL '14 days' AND td.game_date - INTERVAL '1 day') AS sum_so_approx
    FROM team_dates td
    JOIN per_team_game p ON p.team_name = td.team_name
    GROUP BY td.team_name, td.game_date
  )
  INSERT INTO public.cache_mlb_historical_bullpen
    (team_name, snapshot_date, rolling_14d_era, rolling_14d_whip, rolling_14d_ip, rolling_14d_k_per_9, rolling_14d_bb_per_9, games_in_window, fetched_at)
  SELECT
    team_name,
    snapshot_date,
    CASE WHEN games_in_window > 0 THEN ROUND((sum_ra::numeric / games_in_window), 3) ELSE NULL END,
    NULL,
    ROUND((games_in_window * 9.0)::numeric, 2),
    CASE WHEN games_in_window > 0 THEN ROUND((sum_so_approx::numeric / games_in_window), 3) ELSE NULL END,
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

COMMENT ON FUNCTION d293_derive_bullpen_snapshots() IS
  'D-293 SHIP 2 (FIXED): derive rolling-14d team RA/game from outcomes. '
  'rolling_14d_era column stores runs-allowed-per-game (proxy for ERA), '
  'k_per_9 stores team-SO/game (approx). NOT bullpen-only.';
