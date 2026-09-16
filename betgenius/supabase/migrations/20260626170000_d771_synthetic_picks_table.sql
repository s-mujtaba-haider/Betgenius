-- D-771 — Sister table for synthetic pitcher_outs picks. Created from the
-- (D-769 backfilled odds) × (D-770 backfilled actual outs) join, scored with
-- the REAL deployed scorePitcherOuts.
--
-- These are NOT real bets — they're "what would the model have predicted
-- on this historical line, and did it hit?" The cohort closes the gap
-- D-769 found: pick_history has no 2025 picks; this table provides the
-- 2025 cohort needed for OOS tuning (D-774).

CREATE TABLE IF NOT EXISTS pitcher_outs_synthetic_picks (
  id                      BIGSERIAL PRIMARY KEY,
  event_id                TEXT NOT NULL,
  game_pk                 INTEGER NOT NULL,
  player_id               INTEGER NOT NULL,
  player_name             TEXT,
  game_date               DATE NOT NULL,
  consensus_line          NUMERIC NOT NULL,
  consensus_over_odds     INTEGER,
  actual_outs             INTEGER NOT NULL,
  pick_side               TEXT NOT NULL,
  confidence              NUMERIC,
  hit                     BOOLEAN,   -- NULL means push (actual == line)
  context_completeness    NUMERIC,
  context_missing         TEXT[],
  breakdown_synthetic     JSONB,
  generator_run           TEXT,
  generated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outs_synth_event   ON pitcher_outs_synthetic_picks (event_id);
CREATE INDEX IF NOT EXISTS idx_outs_synth_date    ON pitcher_outs_synthetic_picks (game_date);
CREATE INDEX IF NOT EXISTS idx_outs_synth_player  ON pitcher_outs_synthetic_picks (player_id);
CREATE INDEX IF NOT EXISTS idx_outs_synth_gen_run ON pitcher_outs_synthetic_picks (generator_run);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outs_synth_event_player_run
  ON pitcher_outs_synthetic_picks (event_id, player_id, generator_run);

ALTER TABLE pitcher_outs_synthetic_picks
  DROP CONSTRAINT IF EXISTS d771_conf_range,
  DROP CONSTRAINT IF EXISTS d771_pick_side,
  DROP CONSTRAINT IF EXISTS d771_outs_sane;
ALTER TABLE pitcher_outs_synthetic_picks
  ADD CONSTRAINT d771_conf_range CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  ADD CONSTRAINT d771_pick_side CHECK (pick_side IN ('over','under')),
  ADD CONSTRAINT d771_outs_sane CHECK (actual_outs >= 0 AND actual_outs <= 35);
