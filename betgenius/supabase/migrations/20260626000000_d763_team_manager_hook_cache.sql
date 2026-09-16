-- D-763 — cache_mlb_team_manager_hook. Per-team manager-hook profile from
-- MLB Stats API starter-only team aggregate (/teams/{id}/stats?stats=statSplits
-- &sitCodes=sp&group=pitching). This is the REAL historical exit data D-761
-- proved necessary — D-668-FOLLOWUP-PULL-FEED is no longer queued.
--
-- Source per D-763 probe (Pittsburgh Pirates, 2026 season):
--   sitCodes=sp returns 1 split with stat = {
--     gamesStarted: 81, inningsPitched: 415.1, numberOfPitches: 6741,
--     pitchesPerInning: 16.23
--   }
--   → avg_starter_pitches_per_start = 6741/81 = 83.2
--   → avg_starter_ip_per_start = 415.1/81 = 5.12
--
-- LOWER avg_starter_pitches_per_start = quick-hook manager (favor UNDER).
-- HIGHER = patient manager letting starters go deep (favor OVER).
-- Combined with bullpen state (D-668 own_pen_rest) for interaction.
--
-- This is BOX-SCORE-DERIVED — no real-time play-by-play needed. Refreshed
-- daily by fetch-mlb-team-manager-hook-daily.

CREATE TABLE IF NOT EXISTS cache_mlb_team_manager_hook (
  team_id        INTEGER NOT NULL,
  team_name      TEXT,
  snapshot_date  DATE NOT NULL,
  -- Raw starter-only team aggregate (sitCodes=sp)
  starter_games_started   INTEGER,
  starter_ip              NUMERIC,
  starter_pitches         INTEGER,
  starter_pitches_per_inning NUMERIC,
  -- Derived per-start metrics
  avg_pitches_per_start   NUMERIC,
  avg_ip_per_start        NUMERIC,
  -- Hook index: (avg_pitches_per_start - 88) so 0 = league avg, negative = quick hook
  hook_index              NUMERIC,
  fetched_at              TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (team_id, snapshot_date)
);

-- D-726-style invariants — keep the data sane.
ALTER TABLE cache_mlb_team_manager_hook
  DROP CONSTRAINT IF EXISTS d763_gs_sane,
  DROP CONSTRAINT IF EXISTS d763_ip_sane,
  DROP CONSTRAINT IF EXISTS d763_pitches_sane,
  DROP CONSTRAINT IF EXISTS d763_pps_sane;
ALTER TABLE cache_mlb_team_manager_hook
  ADD CONSTRAINT d763_gs_sane CHECK (starter_games_started IS NULL OR (starter_games_started >= 0 AND starter_games_started <= 200)),
  ADD CONSTRAINT d763_ip_sane CHECK (starter_ip IS NULL OR (starter_ip >= 0 AND starter_ip <= 2000)),
  ADD CONSTRAINT d763_pitches_sane CHECK (starter_pitches IS NULL OR (starter_pitches >= 0 AND starter_pitches <= 50000)),
  ADD CONSTRAINT d763_pps_sane CHECK (avg_pitches_per_start IS NULL OR (avg_pitches_per_start >= 0 AND avg_pitches_per_start <= 200));

CREATE INDEX IF NOT EXISTS idx_team_manager_hook_snapshot
  ON cache_mlb_team_manager_hook (snapshot_date DESC);
