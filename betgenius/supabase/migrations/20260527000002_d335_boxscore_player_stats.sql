-- D-335 SHIP 1 — per-(player, gamePk) boxscore stats cache.
--
-- D-333 diagnosed two DATA_GAP zombies that need boxscore-level data:
--   - lineup_consistency: needs battingOrderSlot per game (MLB gameLog doesn't return it)
--   - pitch_count_trend: needs pitchesThrown per game (MLB gameLog doesn't return it)
--
-- The /api/v1/game/{gamePk}/boxscore endpoint DOES return both. This cache
-- stores one row per (player_id, game_pk) so per-player rolling lookups
-- (last N starts) are cheap.
--
-- Source: MLB Stats API /boxscore (free, no key required).
-- Backfill: D-335 SHIP 2 — 2026-03-20 → today via /tmp/d335_backfill_boxscores.py.
-- Ongoing: D-335 SHIP 3 daily cron (fetch-mlb-boxscores-daily) at 04:30 UTC.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_boxscore_player_stats CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_boxscore_player_stats (
  player_id INTEGER NOT NULL,
  game_pk INTEGER NOT NULL,
  game_date DATE NOT NULL,
  team_id INTEGER,
  player_name TEXT,
  position_type TEXT,            -- 'Pitcher' / 'Infielder' / 'Outfielder' / 'Catcher' / 'TwoWayPlayer' / 'Hitter'
  is_starter BOOLEAN NOT NULL DEFAULT FALSE,
  batting_order_slot INTEGER,    -- 1-9 (NULL for non-starters / pitchers)
  -- Batter stats
  at_bats INTEGER,
  hits INTEGER,
  home_runs INTEGER,
  total_bases INTEGER,
  rbi INTEGER,
  plate_appearances INTEGER,
  -- Pitcher stats (NULL for non-pitchers)
  innings_pitched NUMERIC(4,1),
  pitches_thrown INTEGER,
  strikeouts INTEGER,
  walks INTEGER,
  batters_faced INTEGER,
  pitcher_runs INTEGER,
  pitcher_earned_runs INTEGER,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_pk)
);

CREATE INDEX IF NOT EXISTS idx_mlb_bx_player_date
  ON public.cache_mlb_boxscore_player_stats (player_id, game_date DESC);
CREATE INDEX IF NOT EXISTS idx_mlb_bx_game_pk
  ON public.cache_mlb_boxscore_player_stats (game_pk);
CREATE INDEX IF NOT EXISTS idx_mlb_bx_game_date
  ON public.cache_mlb_boxscore_player_stats (game_date);

ALTER TABLE public.cache_mlb_boxscore_player_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bxstats_service_all ON public.cache_mlb_boxscore_player_stats;
CREATE POLICY bxstats_service_all ON public.cache_mlb_boxscore_player_stats
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bxstats_auth_read ON public.cache_mlb_boxscore_player_stats;
CREATE POLICY bxstats_auth_read ON public.cache_mlb_boxscore_player_stats
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_boxscore_player_stats IS
  'D-335 SHIP 1. Per-(player_id, game_pk) boxscore stats from MLB Stats API. '
  'Unblocks lineup_consistency (batting_order_slot) + pitch_count_trend (pitches_thrown) '
  'factors which were DATA_GAP zombies per D-333 because MLB gameLog endpoint omits both.';
