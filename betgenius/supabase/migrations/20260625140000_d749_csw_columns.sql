-- D-749 — Add CSW% columns to cache_statcast_pitcher_arsenal.
-- CSW (Called Strike + Whiff) is the #1 K predictor per public research.
-- Source: Baseball Savant custom leaderboard
--   selections=p_total_pitches,p_called_strike,p_swinging_strike
--
-- Sparse columns: cache rows from older snapshots will have NULL CSW until
-- backfilled. Historical context router treats NULL as "factor doesn't fire"
-- the same way as expected_whiff_pct.

ALTER TABLE cache_statcast_pitcher_arsenal
  ADD COLUMN IF NOT EXISTS csw_pct                NUMERIC,  -- 0-100, 1 dp
  ADD COLUMN IF NOT EXISTS called_strike_pct      NUMERIC,
  ADD COLUMN IF NOT EXISTS swinging_strike_pct    NUMERIC,
  ADD COLUMN IF NOT EXISTS total_pitches_csw      INTEGER;

-- D-726-style invariants — keep the data sane.
ALTER TABLE cache_statcast_pitcher_arsenal
  DROP CONSTRAINT IF EXISTS d749_csw_pct_range,
  DROP CONSTRAINT IF EXISTS d749_called_pct_range,
  DROP CONSTRAINT IF EXISTS d749_swing_pct_range,
  DROP CONSTRAINT IF EXISTS d749_pitches_non_neg;
ALTER TABLE cache_statcast_pitcher_arsenal
  ADD CONSTRAINT d749_csw_pct_range CHECK (csw_pct IS NULL OR (csw_pct >= 0 AND csw_pct <= 100)),
  ADD CONSTRAINT d749_called_pct_range CHECK (called_strike_pct IS NULL OR (called_strike_pct >= 0 AND called_strike_pct <= 100)),
  ADD CONSTRAINT d749_swing_pct_range CHECK (swinging_strike_pct IS NULL OR (swinging_strike_pct >= 0 AND swinging_strike_pct <= 100)),
  ADD CONSTRAINT d749_pitches_non_neg CHECK (total_pitches_csw IS NULL OR total_pitches_csw >= 0);
