-- D-816 — HR factor stack completion. Adds:
--   * cache_statcast_batters_pull_rate (Baseball Savant batted-ball leaderboard)
--   * 4 new pick_history columns: score_batter_pull_rate (PART 1) + 3 promoted
--     from breakdown-only (score_pitcher_gb_fb_rate, score_pitcher_hr_per_9,
--     score_wind_direction_hr — D-811 PART 3 finding).
--   * 1 new algorithm_weights column for pull_rate.
--
-- PART 1: pull_rate is THE missing HR factor per D-811 audit (pull-heavy
-- flyball hitters = HR setup). Pattern mirrors D-808 sprint_speed ingestion.
-- PART 3: 3 promoted columns enable optimizer per-bin O(1) reads vs the slower
-- breakdown JSONB extraction for OOS retunes.
--
-- Companion migration (20260628300100) extends upsert_pick_history RPC.

BEGIN;

-- PART 1 — pull_rate cache + factor column + weight
CREATE TABLE IF NOT EXISTS public.cache_statcast_batters_pull_rate (
  player_id        BIGINT NOT NULL,
  player_name      TEXT,
  year             INTEGER NOT NULL,
  bbe              INTEGER,          -- batted ball events (sample-size proxy)
  pull_rate        NUMERIC NOT NULL, -- 0.0 to 1.0 (fraction of batted balls pulled)
  pull_air_rate    NUMERIC,          -- 0.0 to 1.0 (pulled-AIR fraction — THE HR signal)
  oppo_rate        NUMERIC,
  straight_rate    NUMERIC,
  fb_rate          NUMERIC,          -- flyball rate
  gb_rate          NUMERIC,          -- groundball rate
  ld_rate          NUMERIC,          -- line drive rate
  snapshot_date    DATE NOT NULL,
  PRIMARY KEY (player_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_pull_rate_player_recent
  ON public.cache_statcast_batters_pull_rate (player_id, snapshot_date DESC);
COMMENT ON TABLE public.cache_statcast_batters_pull_rate IS
  'D-816 — Baseball Savant batted-ball direction leaderboard. Pull-rate and pull-air-rate are HR-prediction signals.';

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_batter_pull_rate NUMERIC,
  -- PART 3 — promote 3 breakdown-only columns to top-level
  ADD COLUMN IF NOT EXISTS score_pitcher_gb_fb_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS score_pitcher_hr_per_9 NUMERIC,
  ADD COLUMN IF NOT EXISTS score_wind_direction_hr NUMERIC;

COMMENT ON COLUMN public.pick_history.score_batter_pull_rate IS
  'D-816 — HR-market factor. Pull-air rate vs league avg ~20%. High pull-air → favor OVER (pull-heavy fly-ball power profile = HR setup). Bucket bands ±5/±3/±1 at ±5/±3/±1 percentage points from 0.20.';
COMMENT ON COLUMN public.pick_history.score_pitcher_gb_fb_rate IS
  'D-661 (D-816 promoted from breakdown-only). Pitcher ground-out/air-out ratio. Flyball pitchers allow more XBH+HR. ±5/±3/±1 buckets gated TB/HR/RBI.';
COMMENT ON COLUMN public.pick_history.score_pitcher_hr_per_9 IS
  'D-284 (D-816 promoted from breakdown-only). HR-market-only deep signal vs league avg HR/9. Gated IP≥30.';
COMMENT ON COLUMN public.pick_history.score_wind_direction_hr IS
  'D-287 (D-816 promoted from breakdown-only). HR-market wind direction × ballpark CF bearing. Tailwind out boosts HRs.';

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_pull_rate NUMERIC DEFAULT 1.0;
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_pull_rate IS
  'D-816 — pull-rate factor weight. Default 1.0 provisional pending OOS tune (D-820+).';

COMMIT;
