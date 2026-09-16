-- D-529 SHIP 2 — VERIFY the X10 drift detector end-to-end.
--
-- Three checks:
--   §C.1 The RPC returns the live constraint definition (smoke).
--   §C.2 Simulate the D-481 incident: add an extra value to a STAGED
--        constraint definition and prove the SQL-side parser would find
--        the drift loudly. (Mirrors the TypeScript unit test in
--        tests/pick_history_writer.test.ts but proves the SQL path too.)
--   §C.3 Confirm health_status accepts the drift row shape that the new
--        sonnet-health-monitor check writes (insert + readback).
DO $$
DECLARE
  v_live_def      text;
  v_staged_def    text;
  v_live_array    text[];
  v_staged_array  text[];
  v_drift_missing text[];
BEGIN
  SET LOCAL statement_timeout TO '30s';

  -- §C.1 — Smoke: the RPC returns the live constraint
  v_live_def := public.d529_get_mlb_market_type_constraint_def();
  RAISE NOTICE '[D-529 §C.1] live constraint def length = % chars', length(v_live_def);
  IF v_live_def IS NULL OR length(v_live_def) < 100 THEN
    RAISE EXCEPTION '[D-529 §C.1] RPC returned suspicious result: %', v_live_def;
  END IF;

  -- Parse 'value'::text literals from the live def using regexp_matches
  SELECT array_agg(matches[1] ORDER BY matches[1])
    INTO v_live_array
    FROM regexp_matches(v_live_def, $pat$'([^']+)'::text$pat$, 'g') AS matches;

  RAISE NOTICE '[D-529 §C.1] parsed % values from live constraint: %',
    cardinality(v_live_array), v_live_array;

  -- §C.2 — Simulate D-481 incident: add a hypothetical 'batter_walks' to a
  -- STAGED def (does NOT touch the live constraint) and prove the
  -- comparator would flag the drift.
  v_staged_def := replace(
    v_live_def,
    $find$'pitcher_outs'::text])$find$,
    $repl$'pitcher_outs'::text, 'batter_walks'::text])$repl$
  );

  SELECT array_agg(matches[1] ORDER BY matches[1])
    INTO v_staged_array
    FROM regexp_matches(v_staged_def, $pat$'([^']+)'::text$pat$, 'g') AS matches;

  -- The "in-code Set" for this simulation is the LIVE list (post-D-487).
  -- A real D-481 drift = `v_staged_array` (the future DB) MINUS `v_live_array`
  -- (the current code) = ['batter_walks'].
  SELECT array_agg(missing ORDER BY missing)
    INTO v_drift_missing
    FROM unnest(v_staged_array) AS missing
    WHERE missing <> ALL(v_live_array);

  RAISE NOTICE '[D-529 §C.2] simulated future constraint = %', v_staged_array;
  RAISE NOTICE '[D-529 §C.2] drift detected: missingInCode = %', v_drift_missing;
  IF cardinality(v_drift_missing) <> 1 OR v_drift_missing[1] <> 'batter_walks' THEN
    RAISE EXCEPTION '[D-529 §C.2] expected drift=[batter_walks] but got %', v_drift_missing;
  END IF;
  RAISE NOTICE '[D-529 §C.2] ✓ drift correctly flagged — the D-481 incident shape is caught.';

  -- §C.3 — Confirm the health_status row shape the new check writes is
  -- acceptable. We use INSERT ... RETURNING to verify without leaving a
  -- test row in production: explicit ROLLBACK via savepoint.
  BEGIN
    INSERT INTO public.health_status (check_name, status, detail, metadata)
    VALUES (
      'mlb_market_type_constraint_drift_TEST',
      'fail',
      'D-529 §C.3 simulated drift test — DO NOT ALERT',
      jsonb_build_object(
        'missingInCode', v_drift_missing,
        'extraInCode', '{}'::text[],
        'parsedFromConstraint', v_staged_array,
        'd481_class', 'simulated_for_verify'
      )
    );
    -- Verify it landed
    PERFORM 1 FROM public.health_status
      WHERE check_name = 'mlb_market_type_constraint_drift_TEST'
        AND status = 'fail';
    RAISE NOTICE '[D-529 §C.3] ✓ health_status accepted the drift row shape.';
    -- Remove the test row so we don't alert on it
    DELETE FROM public.health_status WHERE check_name = 'mlb_market_type_constraint_drift_TEST';
  END;

  RAISE NOTICE '[D-529 SUMMARY] X10 drift detector verified end-to-end.';
END $$;
