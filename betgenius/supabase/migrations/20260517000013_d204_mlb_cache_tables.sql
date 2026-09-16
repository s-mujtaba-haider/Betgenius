-- D-204 Batch 3 Task 3.0 — MLB shared cache infrastructure.
--
-- Five cache tables backing the 7-market MLB Beta build (D-203 spec).
-- All tables: RLS read-authed, write service-role only. PK includes
-- snapshot_date for daily refresh idempotency. Indexes per D-197
-- pattern (read-optimized for scoring lookups + rescore reads).
--
-- §1.17 audit N/A — pure DDL additions, no writer-path implications
-- on existing tables. Writer functions (fetch-mlb-*) ship with their
-- own §1.17 column-set discipline.

BEGIN;

-- ===========================================================================
-- 1) cache_pitcher_game_logs
--    Per-pitcher last 10 starts (K + IP + opp). Refresh daily via
--    fetch-mlb-pitcher-stats from MLB Stats API.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cache_pitcher_game_logs (
  pitcher_id      INTEGER       NOT NULL,
  snapshot_date   DATE          NOT NULL,
  game_date       DATE          NOT NULL,
  opponent_team   TEXT          NOT NULL,
  innings_pitched NUMERIC(4,2)  NOT NULL DEFAULT 0,
  hits            INTEGER       NOT NULL DEFAULT 0,
  earned_runs     INTEGER       NOT NULL DEFAULT 0,
  strikeouts      INTEGER       NOT NULL DEFAULT 0,
  walks           INTEGER       NOT NULL DEFAULT 0,
  pitch_count     INTEGER,
  stats_json      JSONB,
  fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pitcher_id, snapshot_date, game_date)
);
CREATE INDEX IF NOT EXISTS idx_cpgl_pitcher_snapshot
  ON public.cache_pitcher_game_logs (pitcher_id, snapshot_date DESC);
COMMENT ON TABLE public.cache_pitcher_game_logs IS
  'D-204 — per-pitcher recent-starts cache for MLB scoring. Source: MLB Stats API /v1/people/{id}/stats?stats=gameLog. Refresh: daily by fetch-mlb-pitcher-stats cron jobid 18.';

-- ===========================================================================
-- 2) cache_team_batting_stats
--    Per-team season hitting + K-rate splits vs LHP/RHP. Daily refresh.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cache_team_batting_stats (
  team_name       TEXT          NOT NULL,
  sport           TEXT          NOT NULL DEFAULT 'mlb',
  snapshot_date   DATE          NOT NULL,
  games_played    INTEGER       NOT NULL DEFAULT 0,
  plate_appearances INTEGER     NOT NULL DEFAULT 0,
  strikeouts      INTEGER       NOT NULL DEFAULT 0,
  k_rate          NUMERIC(5,3)  NOT NULL DEFAULT 0,
  vs_lhp_k_rate   NUMERIC(5,3),
  vs_rhp_k_rate   NUMERIC(5,3),
  runs_per_game   NUMERIC(4,2)  NOT NULL DEFAULT 0,
  ops_l10         NUMERIC(4,3),
  ops_season      NUMERIC(4,3),
  fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_name, sport, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_ctbs_lookup
  ON public.cache_team_batting_stats (team_name, sport, snapshot_date DESC);
COMMENT ON TABLE public.cache_team_batting_stats IS
  'D-204 — per-team batting stats for MLB scoring. Source: MLB Stats API /v1/teams/{id}/stats. Refresh: daily by fetch-mlb-team-stats cron jobid 19.';

-- ===========================================================================
-- 3) cache_ballpark_factors
--    Per-park run + HR + K + hits factors. Weekly refresh per CEO decision #3.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cache_ballpark_factors (
  park_name       TEXT          NOT NULL,
  runs_factor     NUMERIC(4,3)  NOT NULL DEFAULT 1.000,
  hr_factor       NUMERIC(4,3)  NOT NULL DEFAULT 1.000,
  k_factor        NUMERIC(4,3)  NOT NULL DEFAULT 1.000,
  hits_factor     NUMERIC(4,3)  NOT NULL DEFAULT 1.000,
  refresh_date    DATE          NOT NULL,
  notes           TEXT,
  PRIMARY KEY (park_name)
);
CREATE INDEX IF NOT EXISTS idx_cbf_refresh
  ON public.cache_ballpark_factors (refresh_date DESC);
COMMENT ON TABLE public.cache_ballpark_factors IS
  'D-204 — ballpark factors (relative to league avg 1.000). Source: Statcast / Baseball Savant aggregates. Refresh: weekly Monday 11:00 UTC by fetch-ballpark-factors cron jobid 20.';

-- ===========================================================================
-- 4) cache_mlb_game_scoreboard
--    Daily MLB games + scores + venue + weather + umpire. Refresh during game window.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cache_mlb_game_scoreboard (
  game_id            INTEGER     NOT NULL,
  game_date          DATE        NOT NULL,
  home_team          TEXT        NOT NULL,
  away_team          TEXT        NOT NULL,
  home_score         INTEGER,
  away_score         INTEGER,
  status             TEXT        NOT NULL DEFAULT 'scheduled',
  venue              TEXT,
  weather_temp_f     INTEGER,
  weather_wind_speed INTEGER,
  weather_wind_dir   TEXT,
  weather_condition  TEXT,
  umpire_name        TEXT,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (game_id)
);
CREATE INDEX IF NOT EXISTS idx_cmgs_date
  ON public.cache_mlb_game_scoreboard (game_date, status);
CREATE INDEX IF NOT EXISTS idx_cmgs_lookup_by_team
  ON public.cache_mlb_game_scoreboard (game_date, home_team, away_team);
COMMENT ON TABLE public.cache_mlb_game_scoreboard IS
  'D-204 — MLB scoreboard with weather + umpire context. Source: MLB Stats API /v1/schedule + OpenWeather + Baseball Savant. Refresh: every 4h during game window.';

-- ===========================================================================
-- 5) cache_umpire_stats
--    Per-umpire called-strike-rate (proxy for K-zone size). Daily refresh.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cache_umpire_stats (
  umpire_name           TEXT          NOT NULL,
  snapshot_date         DATE          NOT NULL,
  called_strike_rate    NUMERIC(5,3),
  k_zone_size_index     NUMERIC(4,2),  -- pct vs league avg (1.00 = avg)
  games_in_sample       INTEGER       NOT NULL DEFAULT 0,
  fetched_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (umpire_name, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_cus_lookup
  ON public.cache_umpire_stats (umpire_name, snapshot_date DESC);
COMMENT ON TABLE public.cache_umpire_stats IS
  'D-204 — per-home-plate-umpire K-zone proxy. Source: Baseball Savant CSV (public). Refresh: daily by fetch-umpire-stats cron jobid 21. Per CEO decision #2 Batch 3.';

-- ===========================================================================
-- RLS — read-authed, write service-role only on all 5
-- ===========================================================================
ALTER TABLE public.cache_pitcher_game_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cpgl_select_authed ON public.cache_pitcher_game_logs;
CREATE POLICY cpgl_select_authed ON public.cache_pitcher_game_logs FOR SELECT TO authenticated USING (true);

ALTER TABLE public.cache_team_batting_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ctbs_select_authed ON public.cache_team_batting_stats;
CREATE POLICY ctbs_select_authed ON public.cache_team_batting_stats FOR SELECT TO authenticated USING (true);

ALTER TABLE public.cache_ballpark_factors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cbf_select_authed ON public.cache_ballpark_factors;
CREATE POLICY cbf_select_authed ON public.cache_ballpark_factors FOR SELECT TO authenticated USING (true);

ALTER TABLE public.cache_mlb_game_scoreboard ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cmgs_select_authed ON public.cache_mlb_game_scoreboard;
CREATE POLICY cmgs_select_authed ON public.cache_mlb_game_scoreboard FOR SELECT TO authenticated USING (true);

ALTER TABLE public.cache_umpire_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cus_select_authed ON public.cache_umpire_stats;
CREATE POLICY cus_select_authed ON public.cache_umpire_stats FOR SELECT TO authenticated USING (true);

-- ===========================================================================
-- Verification — confirm all 5 tables exist + RLS enabled
-- ===========================================================================
DO $$
DECLARE
  table_count INT;
  rls_count INT;
BEGIN
  SELECT COUNT(*) INTO table_count FROM pg_tables
    WHERE schemaname = 'public' AND tablename IN (
      'cache_pitcher_game_logs', 'cache_team_batting_stats',
      'cache_ballpark_factors', 'cache_mlb_game_scoreboard', 'cache_umpire_stats'
    );
  SELECT COUNT(*) INTO rls_count FROM pg_tables
    WHERE schemaname = 'public' AND rowsecurity = true AND tablename IN (
      'cache_pitcher_game_logs', 'cache_team_batting_stats',
      'cache_ballpark_factors', 'cache_mlb_game_scoreboard', 'cache_umpire_stats'
    );
  RAISE NOTICE 'D-204 VERIFY: % of 5 MLB cache tables created, % with RLS enabled',
    table_count, rls_count;
  IF table_count <> 5 OR rls_count <> 5 THEN
    RAISE EXCEPTION 'D-204 VERIFY FAIL: expected 5 tables with RLS, got % tables / % RLS', table_count, rls_count;
  END IF;
END $$;

COMMIT;
