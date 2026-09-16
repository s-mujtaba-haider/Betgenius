-- D-761 — Add 2 algorithm_weights columns for the new pitcher_outs early-hook
-- factors. Both seeded at 1.0 per DEFAULT_W. NO existing weight value changes.

ALTER TABLE algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_outs_third_time_through NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_outs_pitches_per_ip     NUMERIC DEFAULT 1.0;

UPDATE algorithm_weights
  SET w_mlb_outs_third_time_through = COALESCE(w_mlb_outs_third_time_through, 1.0),
      w_mlb_outs_pitches_per_ip     = COALESCE(w_mlb_outs_pitches_per_ip,     1.0);

DO $$
DECLARE v1 NUMERIC; v2 NUMERIC;
BEGIN
  SELECT w_mlb_outs_third_time_through, w_mlb_outs_pitches_per_ip
    INTO v1, v2 FROM algorithm_weights WHERE id = 1;
  IF v1 IS DISTINCT FROM 1.0 OR v2 IS DISTINCT FROM 1.0 THEN
    RAISE EXCEPTION 'D-761 post-migration check failed: third_time=% pitches_per_ip=% (expected 1.0 each)', v1, v2;
  END IF;
  RAISE NOTICE 'D-761 added + seeded: third_time_through=% / pitches_per_ip=%', v1, v2;
END $$;
