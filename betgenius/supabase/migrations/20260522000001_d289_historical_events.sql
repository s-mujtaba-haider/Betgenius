-- D-289 PHASE 1 (2026-05-22) — historical events master list.
--
-- Per CEO-approved Option C: pull 2023-05-03 through 2025-10-31
-- MLB events. Used as the iteration list for Phase 3 odds backfill
-- and Phase 4 outcomes backfill.
--
-- Cost per event row: 1 credit (one /historical/events?date call
-- per UTC date returns all events for that date).
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_historical_events CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_events (
  event_id TEXT PRIMARY KEY,
  sport_key TEXT NOT NULL DEFAULT 'baseball_mlb',
  commence_time TIMESTAMPTZ NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  -- D-289 PHASE 3 — checkpoint for resumable odds backfill
  odds_backfill_status TEXT NOT NULL DEFAULT 'pending',
  odds_backfill_at TIMESTAMPTZ,
  outcomes_backfill_status TEXT NOT NULL DEFAULT 'pending',
  outcomes_backfill_at TIMESTAMPTZ,
  game_pk INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hist_events_commence ON public.cache_mlb_historical_events (commence_time);
CREATE INDEX IF NOT EXISTS idx_hist_events_odds_status ON public.cache_mlb_historical_events (odds_backfill_status, commence_time);
CREATE INDEX IF NOT EXISTS idx_hist_events_outcomes_status ON public.cache_mlb_historical_events (outcomes_backfill_status, commence_time);

ALTER TABLE public.cache_mlb_historical_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hist_events_service_all ON public.cache_mlb_historical_events;
CREATE POLICY hist_events_service_all ON public.cache_mlb_historical_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hist_events_auth_read ON public.cache_mlb_historical_events;
CREATE POLICY hist_events_auth_read ON public.cache_mlb_historical_events
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_historical_events IS
  'D-289: master list of MLB events 2023-05-03 → 2025-10-31. '
  'Source: /v4/historical/sports/baseball_mlb/events. Backfilled '
  'once; subsequent Phase 3/4 iterations use this as input.';
