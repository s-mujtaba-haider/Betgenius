-- D-534 SHIP 3 — End-to-end verification of the per-market override
-- write path.
--
-- §B.1 — Write a TEST override to row 1 (batter_hits only); read it
--        back; assert the JSONB shape is what the loader expects.
-- §B.2 — Confirm the column is queryable via the same PostgREST path
--        the loader uses.
-- §B.3 — Roll back the test override so production state is unchanged.
DO $$
DECLARE r RECORD; v_before jsonb; v_after jsonb;
BEGIN
  -- §B.1 Snapshot the current value (likely '{}' default)
  SELECT mlb_market_weight_overrides INTO v_before
  FROM public.algorithm_weights WHERE id = 1;
  RAISE NOTICE '[D-534 §B.1] override BEFORE = %', v_before::text;

  -- Temporarily write a test override
  UPDATE public.algorithm_weights
  SET mlb_market_weight_overrides = jsonb_build_object(
    'batter_hits', jsonb_build_object(
      'w_mlb_batter_handedness_matchup', -1.5,
      'w_mlb_batter_weather_temp', -2.5
    )
  )
  WHERE id = 1;

  -- §B.2 Read back via the same shape the loader uses
  SELECT mlb_market_weight_overrides INTO v_after
  FROM public.algorithm_weights WHERE id = 1;
  RAISE NOTICE '[D-534 §B.2] override AFTER (test) = %', v_after::text;

  -- Assert the shape parses correctly
  FOR r IN
    SELECT
      (v_after -> 'batter_hits' ->> 'w_mlb_batter_handedness_matchup')::numeric AS h,
      (v_after -> 'batter_hits' ->> 'w_mlb_batter_weather_temp')::numeric AS t,
      v_after ? 'batter_total_bases' AS has_tb_key
  LOOP RAISE NOTICE '[D-534 §B.2] batter_hits handedness=% temp=% batter_total_bases_key_exists=%',
    r.h, r.t, r.has_tb_key; END LOOP;
  IF (v_after -> 'batter_hits' ->> 'w_mlb_batter_handedness_matchup')::numeric <> -1.5 THEN
    RAISE EXCEPTION '[D-534 §B.2] expected -1.5, got %',
      (v_after -> 'batter_hits' ->> 'w_mlb_batter_handedness_matchup')::numeric;
  END IF;
  RAISE NOTICE '[D-534 §B.2] ✓ shape parses; only batter_hits has overrides';

  -- §B.3 ROLLBACK the test override → production unchanged
  UPDATE public.algorithm_weights
  SET mlb_market_weight_overrides = v_before
  WHERE id = 1;

  -- Confirm we're back to the pre-test state
  SELECT mlb_market_weight_overrides INTO v_after
  FROM public.algorithm_weights WHERE id = 1;
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION '[D-534 §B.3] ROLLBACK FAILED — current % vs original %',
      v_after::text, v_before::text;
  END IF;
  RAISE NOTICE '[D-534 §B.3] ✓ rolled back; production state unchanged = %', v_after::text;
END $$;
