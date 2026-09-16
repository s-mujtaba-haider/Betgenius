-- D-752 fix — add w_mlb_pitcher_csw column to algorithm_weights.
--
-- WHAT: pure wiring repair. D-749 added score_pitcher_csw factor + the
-- DEFAULT_W.pitcherCsw=1.0 fallback, but never added the DB column nor the
-- loader mapping. setMlbWeights REPLACES W (not merges), so a loader-missing
-- key becomes undefined at runtime. That produced an NaN cascade through
-- factor_sum → λ → win_prob → raw_conf → applyD743IsotonicCalibrationPitcherK
-- silently returning 71 for every pick. Zero pitcher_k picks since 2026-06-25
-- 04:05 UTC (and pitcher_outs since the same boundary).
--
-- WHY: this column makes the weight DB-tunable for future optimizer iterations.
-- The loader's fallback chain (DEFAULT_W.pitcherCsw=1.0) is what actually
-- prevents the NaN cascade once the loader wires the field — the column adds
-- tunability, not correctness. Adding both is the right pattern.
--
-- WHEN: D-749 deployed 2026-06-25 15:13 UTC (CSW live, gate-flipped). Bug went
-- undetected until D-751 read-only diagnostic at 17:25 UTC. This migration
-- closes the gap on the column side; mlb_weights.ts:223 closes it on the
-- loader side; scoring_mlb_v2.ts:83 NaN-safe guard prevents recurrence.
--
-- VALUE: 1.0. UNCHANGED from D-749's DEFAULT_W.pitcherCsw=1.0 seed. Not a
-- weight VALUE change — it's the same number the fallback would have used
-- once wired. CEO §19.3 is satisfied because no scoring weight value moves.

ALTER TABLE algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_csw NUMERIC DEFAULT 1.0;

UPDATE algorithm_weights
  SET w_mlb_pitcher_csw = 1.0
  WHERE w_mlb_pitcher_csw IS NULL;

-- Sanity check on the row we just touched. NOTICE if value isn't exactly 1.0.
DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT w_mlb_pitcher_csw INTO v FROM algorithm_weights WHERE id = 1;
  IF v IS NULL OR v <> 1.0 THEN
    RAISE EXCEPTION 'D-752 post-migration check failed: w_mlb_pitcher_csw=% (expected 1.0)', v;
  END IF;
  RAISE NOTICE 'D-752 column added + seeded: w_mlb_pitcher_csw=1.0';
END $$;
