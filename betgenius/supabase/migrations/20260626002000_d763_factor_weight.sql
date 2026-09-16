-- D-763 — Add w_mlb_outs_manager_hook to algorithm_weights. Seeded at 1.5
-- per DEFAULT_W.outsManagerHook (higher than the volatility_v2 proxy's 0.75
-- because manager-hook is the research-validated #1 missing predictor —
-- D-668-FOLLOWUP-PULL-FEED).

ALTER TABLE algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_outs_manager_hook NUMERIC DEFAULT 1.5;

UPDATE algorithm_weights
  SET w_mlb_outs_manager_hook = COALESCE(w_mlb_outs_manager_hook, 1.5)
  WHERE id = 1;

DO $$
DECLARE v NUMERIC;
BEGIN
  SELECT w_mlb_outs_manager_hook INTO v FROM algorithm_weights WHERE id = 1;
  IF v IS DISTINCT FROM 1.5 THEN
    RAISE EXCEPTION 'D-763 post-migration check failed: w_mlb_outs_manager_hook=% (expected 1.5)', v;
  END IF;
  RAISE NOTICE 'D-763 added + seeded: w_mlb_outs_manager_hook=1.5';
END $$;
