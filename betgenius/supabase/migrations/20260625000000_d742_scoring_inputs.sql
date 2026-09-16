-- D-742 PART 3 — Permanent root fix: capture factor inputs at score time.
--
-- pick_history gets a new JSONB column `scoring_inputs` containing the FULL
-- scoring context (the ctx object passed to scorePitcherStrikeouts/etc.) at the
-- exact moment of scoring. This is the point-in-time snapshot.
--
-- Re-scoring functions (rescore-historic-pitcher-k) check for this column first;
-- if present, the formula replay is 100% parity by construction (no temporal
-- drift, no warehouse reconstruction needed). Existing pre-D-742 picks fall back
-- to historical-router reconstruction (with the temporal-drift caveat).

ALTER TABLE pick_history
  ADD COLUMN IF NOT EXISTS scoring_inputs jsonb;

COMMENT ON COLUMN pick_history.scoring_inputs IS
  'D-742: full PitcherKScoringContext / BatterScoringContext / GameScoringContext object captured at scoring time. Enables 100%-parity re-scoring by construction (no warehouse reconstruction, no MLB API re-fetch, no temporal drift). Populated by process-games-mlb starting at the D-742 deploy.';

-- Index on whether scoring_inputs is populated — useful for the shadow factor analysis
CREATE INDEX IF NOT EXISTS idx_pick_history_scoring_inputs_present
  ON pick_history ((scoring_inputs IS NOT NULL))
  WHERE scoring_inputs IS NOT NULL;
