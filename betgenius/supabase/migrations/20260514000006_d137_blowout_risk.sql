-- D-137 Tier 2 #6 score_blowout_risk V0-B (CEO §19.3, May 13, 2026).
-- Single atomic migration: new cache_game_lines table + 3 column additions
-- to pick_history / recommendations_cache / algorithm_weights.
-- Pre-audit confirmed clean state (migration 20260513000051).
-- Paired §1.12 verification: 20260514000007_d137_verification.sql.
-- =============================================================================
-- The cache_game_lines table is also load-bearing for future Tier 2 #5
-- (line movement signal). RLS pattern + indexes match cache_player_game_logs
-- (D-043 / 20260501000000_cache_foundation_phase1.sql).

CREATE TABLE IF NOT EXISTS public.cache_game_lines (
  event_id     TEXT PRIMARY KEY,
  game_date    DATE NOT NULL,
  home_team    TEXT NOT NULL,
  away_team    TEXT NOT NULL,
  spread_line  NUMERIC,
  total_line   NUMERIC,
  favored_team TEXT,
  bookmaker    TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cache_game_lines_game_date
  ON public.cache_game_lines(game_date);
CREATE INDEX IF NOT EXISTS idx_cache_game_lines_fetched_at
  ON public.cache_game_lines(fetched_at);

ALTER TABLE public.cache_game_lines ENABLE ROW LEVEL SECURITY;

-- RLS pattern mirrors D-043 cache_* tables: authenticated read, service_role write.
DROP POLICY IF EXISTS cache_game_lines_select_authed ON public.cache_game_lines;
CREATE POLICY cache_game_lines_select_authed ON public.cache_game_lines
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_game_lines IS
  'D-137 Tier 2 #6 (May 13, 2026). Per-event spread/total snapshot written '
  'by fetch-odds via dedicated /v4/sports/{sport}/odds?markets=spreads,totals '
  'call (V0-B architecture). Read by process-games at player-prop scoring '
  'time for score_blowout_risk factor and by future Tier 2 #5 (line movement). '
  'PK on event_id; one row per upcoming event, updated on every fetch-odds tick.';

-- Three column additions for the factor itself.
ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_blowout_risk INT NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.pick_history.score_blowout_risk IS
  'D-137 Tier 2 #6 (May 13, 2026). Penalty (negative on over side, positive '
  'on under side via side-flip) when (a) player is on the favored team, '
  '(b) absolute spread > 10, (c) prop is minute-bound (points/rebounds/'
  'assists/PRA/PR/PA/RA + player_* variants). Three magnitude bands: -6 '
  '(spread>10), -12 (>13), -18 (>16). Excludes blocks/steals/turnovers/threes.';

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS score_blowout_risk NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_blowout_risk NUMERIC NOT NULL DEFAULT 1.0
    CHECK (w_blowout_risk >= 0);
COMMENT ON COLUMN public.algorithm_weights.w_blowout_risk IS
  'Multiplier on score_blowout_risk before adding to finalScore. Starting '
  'value 1.0 per CEO "gut-bucket" philosophy. Re-tune via D-118 calibration '
  'loop after ~2 weeks of organic data (NBA Finals 3-week constraint applies; '
  'most playoff games have spread < 10 so calibration may need October '
  'preseason data).';
