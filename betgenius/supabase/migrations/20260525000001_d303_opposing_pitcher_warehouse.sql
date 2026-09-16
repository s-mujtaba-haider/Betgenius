-- D-303 SHIP 2 (2026-05-25) — historical opposing pitcher warehouse.
--
-- D-298 SHIP 1 flagged this as a critical gap: replay engine
-- currently returns null for homePitcher + awayPitcher contexts,
-- causing game-level scoring to fall back to league-average ERA
-- (~3-5pp confidence accuracy hit per D-298 honest disclosure).
--
-- Schema: one row per event_id with home + away starter info.
-- Source: cache_mlb_historical_lineups (D-293 SHIP 3) extracts the
-- starting batters from boxscore battingOrder, but the SP is in
-- boxscore.teams.{home,away}.pitchers[0] (first pitcher = starter).
--
-- Rollback: DROP TABLE IF EXISTS cache_mlb_historical_opposing_pitcher CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_opposing_pitcher (
  event_id TEXT PRIMARY KEY,
  home_starter_id INTEGER,
  home_starter_name TEXT,
  home_starter_hand TEXT,    -- "L" / "R"
  away_starter_id INTEGER,
  away_starter_name TEXT,
  away_starter_hand TEXT,
  game_pk INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hist_op_event ON public.cache_mlb_historical_opposing_pitcher (event_id);
CREATE INDEX IF NOT EXISTS idx_hist_op_game_pk ON public.cache_mlb_historical_opposing_pitcher (game_pk);

ALTER TABLE public.cache_mlb_historical_opposing_pitcher ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hist_op_service_all ON public.cache_mlb_historical_opposing_pitcher;
CREATE POLICY hist_op_service_all ON public.cache_mlb_historical_opposing_pitcher FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hist_op_auth_read ON public.cache_mlb_historical_opposing_pitcher;
CREATE POLICY hist_op_auth_read ON public.cache_mlb_historical_opposing_pitcher FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_historical_opposing_pitcher IS
  'D-303 SHIP 2: starting pitcher per historical event. Closes D-298 SHIP 1 gap.';
