-- D-289 PHASE 1 (2026-05-22) — historical odds warehouse.
--
-- Permanent storage of historical odds snapshots. One row per
-- (event, snapshot, bookmaker, market, player, line). Unlimited
-- re-runs possible against this cache without further API spend.
--
-- Cost per fill: 10 credits per market per snapshot.
-- Full backfill estimate: 5,000 events × 3 snapshots × 8 markets
-- × 10 = ~1,200,000 credits (24% of 5M tier — CEO approved).
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_historical_odds CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_historical_odds (
  event_id TEXT NOT NULL,
  snapshot_timestamp TIMESTAMPTZ NOT NULL,
  commence_time TIMESTAMPTZ NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  bookmaker_key TEXT NOT NULL,
  bookmaker_title TEXT,
  market_key TEXT NOT NULL,
  player_name TEXT NOT NULL DEFAULT '',  -- '' for game-level markets (h2h/spreads/totals)
  line NUMERIC NOT NULL DEFAULT 0,
  over_odds INTEGER,
  under_odds INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, snapshot_timestamp, bookmaker_key, market_key, player_name, line)
);

CREATE INDEX IF NOT EXISTS idx_hist_odds_event ON public.cache_mlb_historical_odds (event_id, snapshot_timestamp);
CREATE INDEX IF NOT EXISTS idx_hist_odds_commence ON public.cache_mlb_historical_odds (commence_time);
CREATE INDEX IF NOT EXISTS idx_hist_odds_market ON public.cache_mlb_historical_odds (market_key, commence_time);

ALTER TABLE public.cache_mlb_historical_odds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hist_odds_service_all ON public.cache_mlb_historical_odds;
CREATE POLICY hist_odds_service_all ON public.cache_mlb_historical_odds
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hist_odds_auth_read ON public.cache_mlb_historical_odds;
CREATE POLICY hist_odds_auth_read ON public.cache_mlb_historical_odds
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_historical_odds IS
  'D-289: permanent storage of historical MLB odds snapshots. '
  'Source: /v4/historical/sports/baseball_mlb/events/{id}/odds. '
  '3 snapshots per event (T-6h, T-1h, T-15min). 8 markets. '
  'One-time spend; unlimited re-runs of backtest/optimizer.';
