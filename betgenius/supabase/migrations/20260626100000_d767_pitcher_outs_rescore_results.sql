-- D-767 — Sister table for rescore-historic-pitcher-outs output. Original
-- pick_history.breakdown is PRESERVED — this is a parallel re-scoring table
-- (analog of pitcher_k_rescore_results from D-737f-B).

CREATE TABLE IF NOT EXISTS pitcher_outs_rescore_results (
  id                     BIGSERIAL PRIMARY KEY,
  pick_id                UUID NOT NULL,
  player_id              INTEGER,
  game_date              DATE NOT NULL,
  pick_side              TEXT NOT NULL,
  line                   NUMERIC NOT NULL,
  hit                    BOOLEAN,
  actual_value           NUMERIC,
  old_confidence         NUMERIC,
  new_confidence         NUMERIC,
  context_completeness   NUMERIC,
  context_missing        TEXT[],
  breakdown_rescored     JSONB,
  rescore_path           TEXT,         -- 'fast' (D-742 scoring_inputs) or 'historical' (router reconstruction)
  rescore_run            TEXT,         -- e.g. 'd767_real_scorer_import'
  rescored_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outs_rescore_pick   ON pitcher_outs_rescore_results (pick_id);
CREATE INDEX IF NOT EXISTS idx_outs_rescore_date   ON pitcher_outs_rescore_results (game_date DESC);
CREATE INDEX IF NOT EXISTS idx_outs_rescore_run    ON pitcher_outs_rescore_results (rescore_run);

-- D-726-style invariants
ALTER TABLE pitcher_outs_rescore_results
  DROP CONSTRAINT IF EXISTS d767_conf_range,
  DROP CONSTRAINT IF EXISTS d767_completeness_range,
  DROP CONSTRAINT IF EXISTS d767_pick_side;
ALTER TABLE pitcher_outs_rescore_results
  ADD CONSTRAINT d767_conf_range CHECK (new_confidence IS NULL OR (new_confidence >= 0 AND new_confidence <= 100)),
  ADD CONSTRAINT d767_completeness_range CHECK (context_completeness IS NULL OR (context_completeness >= 0 AND context_completeness <= 1)),
  ADD CONSTRAINT d767_pick_side CHECK (pick_side IN ('over','under'));
