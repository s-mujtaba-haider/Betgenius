-- D-808 — Complete the runs_scored factor stack. Adds:
--   * 6 new pick_history columns for the 8 deferred D-806 factors that lack
--     existing top-level columns (lineup_consistency already exists; the
--     others are MISSING per audit). Also sprint speed for D-810→D-808 merge.
--   * 1 new algorithm_weights column for sprint_speed.
--   * 1 new cache table for Baseball Savant sprint speed leaderboard data.
--
-- Why top-level columns: per D-758 best-practice, optimizer-relevant factor
-- scores live as dedicated NUMERIC columns. Breakdown JSONB is fine for
-- audit, but column reads are O(1) for the OOS-tune optimizer's per-bin reads.
--
-- Companion migration (20260628200100) extends upsert_pick_history RPC.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_pitcher_baa_vs_hand     NUMERIC,
  ADD COLUMN IF NOT EXISTS score_hitter_streak_fatigue   NUMERIC,
  ADD COLUMN IF NOT EXISTS score_day_after_night_fatigue NUMERIC,
  ADD COLUMN IF NOT EXISTS score_travel_getaway          NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_line_hit_rate    NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_sprint_speed     NUMERIC;

COMMENT ON COLUMN public.pick_history.score_pitcher_baa_vs_hand IS
  'D-808 — opposing pitcher BAA vs this batter handedness. ±3/±1 buckets at ±0.045/±0.020 from .245 LEAGUE_AVG_BA. Gated PA≥30 vs that hand.';
COMMENT ON COLUMN public.pick_history.score_hitter_streak_fatigue IS
  'D-808 — consecutive starts streak. -2 at ≥12, -1 at ≥8. Single-direction (fatigue penalty).';
COMMENT ON COLUMN public.pick_history.score_day_after_night_fatigue IS
  'D-808 — fatigue from yesterday night game → today day game (or last game 18-30h ago). Runs uses non-power bucket -2/-1 (HR uses -3/-2).';
COMMENT ON COLUMN public.pick_history.score_travel_getaway IS
  'D-808 — long EW flight from yesterdays venue. -3 ≥1500mi EW, -2 ≥1000mi EW, -1 ≥1500mi WE.';
COMMENT ON COLUMN public.pick_history.score_batter_line_hit_rate IS
  'D-808 — D-517 v2 penalty on l10 line-hit-rate. -3/-6/-10/-15 at 50/40/30/<30. NO sideFlip (recentHitRate already side-aware).';
COMMENT ON COLUMN public.pick_history.score_batter_sprint_speed IS
  'D-808 — Baseball Savant sprint speed (ft/sec). ±5/±3/±1 buckets at 30.0/28.5/27.5 vs 27 league avg. Runs-only baserunning signal.';

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_sprint_speed NUMERIC DEFAULT 1.0;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_sprint_speed IS
  'D-808 — sprint speed factor weight. Default 1.0 provisional. Tunable post-D-811 retune.';

-- D-808 — Baseball Savant sprint speed leaderboard cache.
-- One row per batter per snapshot_date. fetch-mlb-batter-sprint-speed
-- backfills weekly (or on-demand) from /leaderboard/sprint_speed CSV.
CREATE TABLE IF NOT EXISTS public.cache_statcast_batters_sprint_speed (
  player_id      BIGINT NOT NULL,
  player_name    TEXT,
  team           TEXT,
  position       TEXT,
  sprint_speed   NUMERIC NOT NULL,  -- ft/sec
  bolts          INTEGER,           -- top-10% sprint-runs in season
  hp_to_1b       NUMERIC,           -- secs to 1B (lower = faster)
  competitive_runs INTEGER,         -- baseline qualifying runs
  snapshot_date  DATE NOT NULL,
  PRIMARY KEY (player_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_sprint_speed_player_recent
  ON public.cache_statcast_batters_sprint_speed (player_id, snapshot_date DESC);

COMMENT ON TABLE public.cache_statcast_batters_sprint_speed IS
  'D-808 — Baseball Savant sprint speed leaderboard. Backfilled by fetch-mlb-batter-sprint-speed.';

COMMIT;
