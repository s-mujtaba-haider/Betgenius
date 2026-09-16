-- D-634 SHIP 2 — cache_odds_snapshots table.
-- Foundation for line-movement scoring, RLM detection, "opened → now"
-- display, and per-bet line-history queries. Mirrors the
-- OddsSnapshot shape in supabase/functions/_shared/odds_source.ts 1:1.
--
-- DELTA-ONLY persistence: the snapshot writer inserts ONLY when at
-- least one of (line, odds) differs from the prior snapshot for the
-- same (sport, event_id, market, player_name, prop_type, pick_side,
-- bookmaker). Bounds row growth: instead of 22K rows × 30 snapshots/day
-- = 660K/day, the realistic rate is more like 5-15M rows/year.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS public.cache_odds_snapshots CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_odds_snapshots (
  sport          text        NOT NULL,
  event_id       text        NOT NULL,
  game_date      text        NOT NULL,   -- YYYY-MM-DD ET
  game_time      timestamptz NULL,
  home_team      text        NOT NULL,
  away_team      text        NOT NULL,
  market         text        NOT NULL,   -- canonical in-house vocabulary
  prop_type      text        NOT NULL,   -- book-vocabulary prop_type
  player_name    text        NOT NULL,
  pick_side      text        NOT NULL,
  line           numeric     NOT NULL,
  odds           integer     NOT NULL,
  bookmaker      text        NOT NULL,
  snapshot_time  timestamptz NOT NULL DEFAULT now(),
  source_name    text        NOT NULL DEFAULT 'the-odds-api', -- adapter name (D-634 swap-enabler)
  PRIMARY KEY (sport, event_id, market, player_name, prop_type, pick_side, bookmaker, snapshot_time)
);

-- Index for "movement over time per pick" — the hot query for the
-- line-movement factor + display. Orders by snapshot_time DESC so
-- "current vs prior" reads use a single index scan with LIMIT 2.
CREATE INDEX IF NOT EXISTS idx_odds_snap_per_pick_time
  ON public.cache_odds_snapshots
  (sport, event_id, market, player_name, prop_type, pick_side, bookmaker, snapshot_time DESC);

-- Index for game-day rollups (e.g. "all snapshots for this game today"
-- used by RLM detector to compute multi-book steam moves).
CREATE INDEX IF NOT EXISTS idx_odds_snap_per_game_day
  ON public.cache_odds_snapshots
  (sport, game_date, event_id, snapshot_time DESC);

-- Index for time-range queries (cron retention prune; "what changed
-- in the last 6 h" admin queries).
CREATE INDEX IF NOT EXISTS idx_odds_snap_time
  ON public.cache_odds_snapshots (snapshot_time DESC);

-- RLS — service_role writes, authenticated read-only.
ALTER TABLE public.cache_odds_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS odds_snap_service_all ON public.cache_odds_snapshots;
CREATE POLICY odds_snap_service_all ON public.cache_odds_snapshots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS odds_snap_auth_read ON public.cache_odds_snapshots;
CREATE POLICY odds_snap_auth_read ON public.cache_odds_snapshots
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_odds_snapshots IS
  'D-634 — Source-abstracted odds snapshots for line-movement / RLM / '
  'display. Adapters (OddsSourceAdapter) normalize providers to the '
  'OddsSnapshot shape; the writer is provider-agnostic. See '
  'docs/loop/reports/d634_source_abstraction.md.';

COMMENT ON COLUMN public.cache_odds_snapshots.source_name IS
  'Adapter name that produced this row. "the-odds-api" today; future '
  'rows from a different provider tag their adapter name for audits.';
