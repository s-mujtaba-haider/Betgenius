-- D-358 — historical odds snapshot table for 2026 backfill proof-of-concept.
--
-- Stores per-event per-market per-snapshot historical odds from The Odds API
-- /v4/historical/sports/baseball_mlb endpoints (bulk + per-event). PK across
-- (event_id, snapshot_timestamp, market, bookmaker) so per-event per-market
-- per-cycle stays unique; raw outcomes preserved as JSONB so player-prop
-- markets retain (player_name, point, over_price, under_price) tuples for
-- D-358 SHIP 3 minting.
--
-- Schema design notes:
--   - `outcomes_jsonb`: full markets[].outcomes[] array from Odds API. For
--     player props this contains per-player Over/Under lines. For game
--     markets this contains home/away/total outcomes.
--   - `market` enum-like: h2h / spreads / totals (bulk endpoint) +
--     batter_hits / batter_total_bases / batter_home_runs / batter_rbis /
--     pitcher_strikeouts (per-event endpoint).
--   - `commence_time` captured per-row for fast game_date filtering without
--     re-joining cache_mlb_historical_outcomes.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_historical_odds_snapshot CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_odds_snapshot (
  event_id            TEXT NOT NULL,
  snapshot_timestamp  TIMESTAMPTZ NOT NULL,
  commence_time       TIMESTAMPTZ NOT NULL,
  home_team           TEXT NOT NULL,
  away_team           TEXT NOT NULL,
  market              TEXT NOT NULL,
  bookmaker           TEXT NOT NULL,
  outcomes_jsonb      JSONB NOT NULL,
  fetched_at          TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (event_id, snapshot_timestamp, market, bookmaker)
);

-- Fast game-date filtering for minting iteration (SHIP 3).
-- Range scan on commence_time handles per-day filtering; ::date cast isn't
-- IMMUTABLE under TIMESTAMPTZ (timezone-dependent), so we index the raw column.
CREATE INDEX IF NOT EXISTS idx_hist_odds_commence_market
  ON public.cache_mlb_historical_odds_snapshot (commence_time, market);

-- Fast per-event lookup.
CREATE INDEX IF NOT EXISTS idx_hist_odds_event
  ON public.cache_mlb_historical_odds_snapshot (event_id, market);

ALTER TABLE public.cache_mlb_historical_odds_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hist_odds_service_all ON public.cache_mlb_historical_odds_snapshot;
CREATE POLICY hist_odds_service_all ON public.cache_mlb_historical_odds_snapshot
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS hist_odds_authenticated_read ON public.cache_mlb_historical_odds_snapshot;
CREATE POLICY hist_odds_authenticated_read ON public.cache_mlb_historical_odds_snapshot
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_historical_odds_snapshot IS
  'D-358 SHIP 1: per-event per-market historical odds snapshots from The Odds API '
  '/v4/historical. Game markets (h2h/spreads/totals) from bulk endpoint; player '
  'props (batter_*, pitcher_strikeouts) from per-event endpoint. Used by D-358 '
  'SHIP 3 minting to reconstruct synthetic pick_history rows for T11 corpus.';
