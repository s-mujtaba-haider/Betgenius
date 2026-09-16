-- D-347 — add 3 new batter-side factor weight columns.
--
-- Factors being wired:
--   - score_lineup_spot                   (tonight's batting order 1-9, top→PA boost)
--   - score_day_after_night_fatigue       (yesterday night game + today day game, batter started)
--   - score_travel_getaway                (long flight east-to-west since yesterday's venue)
--
-- All 3 are previously-placeholder concepts; w_mlb_lineup_spot existed at 0.0 from D-340
-- migration but had no scorer code. D-347 ships the scorer code + enables weights to 1.0/0.5/0.5.
-- The other two are new columns (no D-340 placeholder existed).
--
-- Initial weights set conservatively pending T11 optimizer tuning:
--   w_mlb_lineup_spot              = 1.0  (mechanical signal; PA volume directly maps to opportunity)
--   w_mlb_day_after_night_fatigue  = 0.5  (research-backed ~5-8% performance dip; smaller weight)
--   w_mlb_travel_getaway           = 0.5  (circadian impact; smaller because effect varies)
--
-- Rollback: ALTER TABLE algorithm_weights DROP COLUMN w_mlb_X (per column).

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_day_after_night_fatigue NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS w_mlb_travel_getaway          NUMERIC NOT NULL DEFAULT 0.5;

-- w_mlb_lineup_spot already exists from D-340 (default 0.0). Set it to 1.0 now that scorer ships.
UPDATE public.algorithm_weights SET w_mlb_lineup_spot = 1.0 WHERE w_mlb_lineup_spot = 0.0;
