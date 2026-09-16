-- D-298 SHIP 1 (2026-05-24) — historical_replay_results table.
--
-- Foundation for the faithful algo replay engine. Each row is one
-- replayed pick: original odds + scoring inputs + replay output +
-- ground-truth outcome.
--
-- For this session (D-298), replay coverage is GAME-LEVEL markets
-- only (game_side, game_total) because D-293 warehouses don't yet
-- include batter season stats / batter game logs / pitcher full
-- season stats required for batter-market scoring contexts. Batter
-- market replay is queued for D-299+ pending warehouse expansion.
--
-- Rollback: DROP TABLE IF EXISTS historical_replay_results CASCADE;

CREATE TABLE IF NOT EXISTS public.historical_replay_results (
  replay_run_id UUID NOT NULL,
  event_id TEXT NOT NULL,
  snapshot_timestamp TIMESTAMPTZ NOT NULL,
  commence_time TIMESTAMPTZ NOT NULL,
  market_key TEXT NOT NULL,
  player_name TEXT NOT NULL,        -- for game-level: "Home vs Away (...)"; for player markets: batter/pitcher name
  line NUMERIC NOT NULL,
  odds INTEGER NOT NULL,
  book_key TEXT NOT NULL,
  -- replay scoring output
  algo_confidence NUMERIC NOT NULL,
  algo_pick_side TEXT NOT NULL,     -- 'over'|'under'|'home'|'away'
  algo_verdict TEXT,
  algo_breakdown JSONB,
  -- context completeness: 0.0-1.0 fraction of expected factors that had real historical data
  context_completeness NUMERIC NOT NULL DEFAULT 0,
  context_missing TEXT[],            -- which factors fell back to defaults
  -- ground truth (filled from cache_mlb_historical_outcomes)
  hit BOOLEAN,                       -- NULL if push or no outcome
  push BOOLEAN NOT NULL DEFAULT FALSE,
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  actual_value NUMERIC,              -- realized stat (total runs / margin / etc.)
  -- bookkeeping
  replayed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (replay_run_id, event_id, snapshot_timestamp, market_key, player_name, line, book_key)
);

CREATE INDEX IF NOT EXISTS idx_replay_run ON public.historical_replay_results (replay_run_id);
CREATE INDEX IF NOT EXISTS idx_replay_commence ON public.historical_replay_results (commence_time);
CREATE INDEX IF NOT EXISTS idx_replay_market ON public.historical_replay_results (market_key, algo_confidence);

ALTER TABLE public.historical_replay_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS historical_replay_results_service_all ON public.historical_replay_results;
CREATE POLICY historical_replay_results_service_all ON public.historical_replay_results FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS historical_replay_results_auth_read ON public.historical_replay_results;
CREATE POLICY historical_replay_results_auth_read ON public.historical_replay_results FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.historical_replay_results IS
  'D-298: faithful algo replay output. One row per historical pick × replay run. '
  'D-298 coverage: game_side + game_total only. Batter markets queued for D-299+ '
  'pending warehouse expansion (BatterSeasonStats + gameLog).';
