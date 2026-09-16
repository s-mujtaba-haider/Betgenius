-- D-204 Batch 3 Task 3.0 — MLB-specific factor columns on pick_history.
--
-- §1.17 SCHEMA CHANGE AUDIT:
--   Two writer paths to pick_history:
--   1. upsert_pick_history RPC — regen in paired migration 20260517000015
--   2. backfill-bdl-historical direct POST — N/A for MLB (NBA-only)
--   Plus future writer: process-games-mlb (D-205) — will use upsert_pick_history RPC
--
-- All new columns NULLable, no NOT NULL DEFAULT — safe for pre-D-204 rows
-- which correctly stay NULL.

ALTER TABLE public.pick_history
  -- Pitcher K factor scores (D-205)
  ADD COLUMN IF NOT EXISTS score_pitcher_k_rate         INTEGER,
  ADD COLUMN IF NOT EXISTS score_pitcher_form           INTEGER,
  ADD COLUMN IF NOT EXISTS score_opposing_lineup_k      INTEGER,
  ADD COLUMN IF NOT EXISTS score_handedness_matchup     INTEGER,
  ADD COLUMN IF NOT EXISTS score_pitch_count_trend      INTEGER,
  ADD COLUMN IF NOT EXISTS score_rest_pitcher           INTEGER,
  -- Ballpark + weather + umpire (shared across multiple markets)
  ADD COLUMN IF NOT EXISTS score_ballpark_factor        INTEGER,
  ADD COLUMN IF NOT EXISTS score_weather_wind           INTEGER,
  ADD COLUMN IF NOT EXISTS score_weather_temp           INTEGER,
  ADD COLUMN IF NOT EXISTS score_umpire_k_zone          INTEGER,
  -- Lineup context (batter markets)
  ADD COLUMN IF NOT EXISTS score_lineup_consistency     INTEGER,
  -- MLB metadata
  ADD COLUMN IF NOT EXISTS mlb_market_type              TEXT,
  ADD COLUMN IF NOT EXISTS is_mlb_beta                  BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS mlb_beta_resolved_picks      INTEGER;

-- Constraint: mlb_market_type values match D-203 spec
ALTER TABLE public.pick_history
  DROP CONSTRAINT IF EXISTS pick_history_mlb_market_type_check;
ALTER TABLE public.pick_history
  ADD CONSTRAINT pick_history_mlb_market_type_check CHECK (
    mlb_market_type IS NULL OR mlb_market_type IN (
      'pitcher_k', 'batter_hits', 'batter_hr', 'batter_total_bases',
      'batter_rbis', 'game_side', 'game_total'
    )
  );

CREATE INDEX IF NOT EXISTS idx_ph_mlb_market_type
  ON public.pick_history (mlb_market_type, sport) WHERE mlb_market_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ph_mlb_beta
  ON public.pick_history (sport, is_mlb_beta, mlb_market_type) WHERE sport = 'mlb';

COMMENT ON COLUMN public.pick_history.mlb_market_type IS
  'D-204 — MLB market enum: pitcher_k | batter_hits | batter_hr | batter_total_bases | batter_rbis | game_side | game_total. NULL for non-MLB picks.';
COMMENT ON COLUMN public.pick_history.is_mlb_beta IS
  'D-204 — defaults true for MLB picks; CEO §19.3 manual UPDATE to false when market clears Beta exit gate per §13.2 (60% rolling-30d 70+ WR for 14 days + n>=100/200).';
COMMENT ON COLUMN public.pick_history.mlb_beta_resolved_picks IS
  'D-204 — running counter populated by resolve-picks-mlb on settlement. Drives "Early Beta — n={count} picks resolved" subscriber copy per CEO Batch 3 decision #5.';

DO $$
DECLARE
  col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pick_history'
      AND column_name IN (
        'score_pitcher_k_rate', 'score_pitcher_form', 'score_opposing_lineup_k',
        'score_handedness_matchup', 'score_pitch_count_trend', 'score_rest_pitcher',
        'score_ballpark_factor', 'score_weather_wind', 'score_weather_temp',
        'score_umpire_k_zone', 'score_lineup_consistency',
        'mlb_market_type', 'is_mlb_beta', 'mlb_beta_resolved_picks'
      );
  RAISE NOTICE 'D-204 VERIFY: % of 14 MLB columns added to pick_history', col_count;
  IF col_count <> 14 THEN
    RAISE EXCEPTION 'D-204 VERIFY FAIL: expected 14 MLB columns, got %', col_count;
  END IF;
END $$;
