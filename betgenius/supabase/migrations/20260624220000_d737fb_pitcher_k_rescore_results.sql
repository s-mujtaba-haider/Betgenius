-- D-737f-B — pitcher_k_rescore_results table for the clean re-scored breakdown.
-- Sister table to pick_history; original pick_history.breakdown is PRESERVED.
-- The rescore-historic-pitcher-k edge function writes to this table.

CREATE TABLE IF NOT EXISTS pitcher_k_rescore_results (
  id           bigserial PRIMARY KEY,
  pick_id      uuid NOT NULL REFERENCES pick_history(id) ON DELETE CASCADE,
  player_id    bigint,
  game_date    date NOT NULL,
  pick_side    text NOT NULL,
  line         numeric,
  hit          boolean,
  actual_value numeric,
  old_confidence integer,
  new_confidence integer,
  old_projected_k numeric,
  new_projected_k numeric,
  context_completeness numeric,
  context_missing jsonb,
  breakdown_rescored jsonb NOT NULL,
  rescored_at  timestamptz NOT NULL DEFAULT now(),
  -- one rescore record per (pick_id, run); allow multiple runs
  rescore_run  text DEFAULT 'd737fb_initial'
);

CREATE INDEX IF NOT EXISTS idx_pitcher_k_rescore_pick_id ON pitcher_k_rescore_results(pick_id);
CREATE INDEX IF NOT EXISTS idx_pitcher_k_rescore_game_date ON pitcher_k_rescore_results(game_date);
CREATE INDEX IF NOT EXISTS idx_pitcher_k_rescore_hit ON pitcher_k_rescore_results(hit);

COMMENT ON TABLE pitcher_k_rescore_results IS
  'D-737f-B: clean re-scored pitcher_k breakdown values, produced by running historical picks through the real post-D-737d scorePitcherStrikeouts function. Used as fit data for D-737e-actual optimizer re-run.';
