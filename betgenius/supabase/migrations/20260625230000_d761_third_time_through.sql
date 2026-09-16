-- D-761 — Add 3rd-time-through-order columns to cache_mlb_pitcher_inn1.
--
-- BUG CLASS CONTEXT: D-760 found pitcher_outs unders structurally lose (35.9%
-- WR on n=64) because the model can't see EARLY HOOKS. Research says 3rd-time-
-- through-order is a major pull trigger (~80-100 OPS jump). Data is reachable
-- from the same MLB Stats API endpoint we already use for i01 — just need to
-- request sitCode=i06 instead of just i01.
--
-- VERIFIED via D-761 probe call to Logan Webb (pid 657277, 2026 season):
--   i01: ERA 0.69, IP 13.0  (existing)
--   i06: ERA 1.80, IP 10.0, OBP .237, OPS .408  (3rd time through)
--   i07: ERA 0.00, IP  7.0  (4th+ time, only ingest if 3rd-time signal warrants)
--
-- We add i06_era/ip/bf/ops to keep the same row-per-pitcher pattern. i07
-- omitted — 4th time through almost never happens with the modern bullpen
-- and the sample sizes are too small to score on.
--
-- Pure additive: existing inn1_* columns unchanged; nullable on legacy rows.

ALTER TABLE cache_mlb_pitcher_inn1
  ADD COLUMN IF NOT EXISTS i06_era NUMERIC,
  ADD COLUMN IF NOT EXISTS i06_ip  NUMERIC,
  ADD COLUMN IF NOT EXISTS i06_bf  INTEGER,
  ADD COLUMN IF NOT EXISTS i06_ops NUMERIC;

ALTER TABLE cache_mlb_pitcher_inn1
  DROP CONSTRAINT IF EXISTS d761_i06_era_nonneg,
  DROP CONSTRAINT IF EXISTS d761_i06_ip_nonneg,
  DROP CONSTRAINT IF EXISTS d761_i06_bf_nonneg,
  DROP CONSTRAINT IF EXISTS d761_i06_ops_sane;
ALTER TABLE cache_mlb_pitcher_inn1
  ADD CONSTRAINT d761_i06_era_nonneg CHECK (i06_era IS NULL OR i06_era >= 0),
  ADD CONSTRAINT d761_i06_ip_nonneg  CHECK (i06_ip  IS NULL OR i06_ip  >= 0),
  ADD CONSTRAINT d761_i06_bf_nonneg  CHECK (i06_bf  IS NULL OR i06_bf  >= 0),
  ADD CONSTRAINT d761_i06_ops_sane   CHECK (i06_ops IS NULL OR (i06_ops >= 0 AND i06_ops <= 4));
