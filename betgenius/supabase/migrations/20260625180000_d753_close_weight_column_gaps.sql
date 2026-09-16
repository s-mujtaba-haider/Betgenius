-- D-753 — Close two DB column gaps found in the post-D-752 sweep.
--
-- (A) w_mlb_pitch_type_matchup — newly referenced by D-753 loader entry
--     for DEFAULT_W.pitchTypeMatchup (D-596 factor). Pre-D-753 the loader
--     didn't reference this key; the factor body at scoring_mlb_v2.ts:904
--     used `W.pitchTypeMatchup ?? 1.0` so undefined never produced NaN.
--     D-753 wires the loader; this migration adds the column so the
--     loader's num() reads a real value (not the fallback) when tuned.
--
-- (B) w_mlb_batter_opp_pitcher_pitchtype_quality — loader has been
--     referencing this column for some time (D-664-era addition), but the
--     migration was never run. num() fell back to DEFAULT_W_BATTER on
--     every read; no active bug, but the loader's reference shows up as
--     "missing in DB" in any audit. Adding the column closes that audit
--     hit + makes the weight DB-tunable.
--
-- Both are PURE WIRING repairs. No weight VALUES changed — both seed at
-- their existing DEFAULT_W{,_BATTER} numbers (1.0 each). §19.3 satisfied.

ALTER TABLE algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_pitch_type_matchup NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_opp_pitcher_pitchtype_quality NUMERIC DEFAULT 1.0;

UPDATE algorithm_weights
  SET w_mlb_pitch_type_matchup = COALESCE(w_mlb_pitch_type_matchup, 1.0),
      w_mlb_batter_opp_pitcher_pitchtype_quality = COALESCE(w_mlb_batter_opp_pitcher_pitchtype_quality, 1.0);

DO $$
DECLARE v1 NUMERIC; v2 NUMERIC;
BEGIN
  SELECT w_mlb_pitch_type_matchup, w_mlb_batter_opp_pitcher_pitchtype_quality
    INTO v1, v2 FROM algorithm_weights WHERE id = 1;
  IF v1 IS DISTINCT FROM 1.0 OR v2 IS DISTINCT FROM 1.0 THEN
    RAISE EXCEPTION 'D-753 post-migration check failed: pitch_type_matchup=% opp_pitcher_pitchtype_quality=% (expected 1.0 each)', v1, v2;
  END IF;
  RAISE NOTICE 'D-753 columns added + seeded: pitch_type_matchup=% / opp_pitcher_pitchtype_quality=%', v1, v2;
END $$;
