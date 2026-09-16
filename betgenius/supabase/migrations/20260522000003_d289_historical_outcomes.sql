-- D-289 PHASE 1 (2026-05-22) — historical outcomes warehouse.
--
-- Per-event final result + per-player stat lines from MLB Stats API
-- boxscore. FREE data source (public MLB API). Enables resolving
-- historical odds against actual outcomes for backtest engine v3.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_historical_outcomes CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_outcomes (
  event_id TEXT PRIMARY KEY,
  commence_time TIMESTAMPTZ NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  game_completed BOOLEAN NOT NULL DEFAULT FALSE,
  game_pk INTEGER,
  -- Per-player stats keyed by player_name + position (jsonb for flexibility)
  -- Schema: { "Aaron Judge": { hits: 2, total_bases: 5, home_runs: 1, rbi: 3, at_bats: 4, pa: 4 },
  --          "Gerrit Cole":  { strikeouts: 8, innings_pitched: 6.1, hits_allowed: 4, walks: 1 } }
  resolution_data JSONB,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hist_outcomes_commence ON public.cache_mlb_historical_outcomes (commence_time);
CREATE INDEX IF NOT EXISTS idx_hist_outcomes_completed ON public.cache_mlb_historical_outcomes (game_completed, commence_time);

ALTER TABLE public.cache_mlb_historical_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hist_outcomes_service_all ON public.cache_mlb_historical_outcomes;
CREATE POLICY hist_outcomes_service_all ON public.cache_mlb_historical_outcomes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hist_outcomes_auth_read ON public.cache_mlb_historical_outcomes;
CREATE POLICY hist_outcomes_auth_read ON public.cache_mlb_historical_outcomes
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_historical_outcomes IS
  'D-289: per-event MLB game outcomes + player stat lines from MLB '
  'Stats API boxscore. FREE source. Used to resolve historical odds '
  'in backtest engine v3.';
