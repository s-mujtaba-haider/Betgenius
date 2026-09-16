-- D-653 SHIP 2 — REAL DEFENSE via Baseball Savant team-level OAA.
-- Replaces the v3 runs_allowed_per_game proxy with real team Outs Above Average.
-- Source: https://baseballsavant.mlb.com/leaderboard/outs_above_average?type=Fielding_Team&year={YYYY}&csv=true
-- Coverage: all 30 MLB teams, current season, refreshed daily.

CREATE TABLE IF NOT EXISTS public.cache_mlb_team_oaa (
  team_name             TEXT    NOT NULL,    -- Savant short name ("Angels", "Cubs", "D-backs")
  team_id               INTEGER NOT NULL,    -- MLB Stats API team id
  full_team_name        TEXT,                -- Canonical MLB name ("Los Angeles Angels"), null when mapping unknown
  snapshot_date         DATE    NOT NULL,
  year                  INTEGER NOT NULL,
  oaa                   INTEGER NOT NULL,    -- Total outs above average (season-to-date)
  oaa_infront           INTEGER,
  oaa_lateral_to_3b     INTEGER,
  oaa_lateral_to_1b     INTEGER,
  oaa_behind            INTEGER,
  oaa_vs_rhh            INTEGER,
  oaa_vs_lhh            INTEGER,
  actual_success_rate   NUMERIC(5,3),        -- e.g. 0.780 from "78%"
  expected_success_rate NUMERIC(5,3),
  diff_success_rate     NUMERIC(5,3),
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_team_oaa_lookup
  ON public.cache_mlb_team_oaa(full_team_name, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_team_oaa_short_lookup
  ON public.cache_mlb_team_oaa(team_name, snapshot_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cache_mlb_team_oaa TO service_role;
GRANT SELECT ON public.cache_mlb_team_oaa TO authenticated, anon;

COMMENT ON TABLE public.cache_mlb_team_oaa IS
  'D-653 — Baseball Savant team-level Outs Above Average. Refreshed daily by fetch-mlb-team-oaa edge fn. '
  'Drives the v3 score_team_defense_oaa_v3 factor + projTeamRunsV3 defAdj when D652_GAME_SIDE_V3_PROMOTE=true. '
  'See docs/loop/architecture/d653_*.md for the full pipeline.';
