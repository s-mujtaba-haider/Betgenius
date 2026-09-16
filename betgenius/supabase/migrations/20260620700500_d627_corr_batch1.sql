DO $$ DECLARE r RECORD; v_cutoff date := '2026-06-10'; BEGIN
  SET LOCAL statement_timeout TO '300s';
  -- Single-factor probe to confirm whether the per-factor query is feasible.
  FOR r IN
    SELECT
      count(*) AS n,
      round(corr(actual_value::numeric, line::numeric)::numeric, 4) AS r_line_actual
    FROM public.pick_history
    WHERE mlb_market_type = 'batter_total_bases'
      AND game_date >= v_cutoff
      AND is_synthetic = false AND hit IS NOT NULL AND voided IS NOT TRUE
      AND actual_value IS NOT NULL
  LOOP
    RAISE NOTICE 'D-627 SINGLE-FACTOR BASELINE (game_date>=%): N=%, r(line, actual)=%', v_cutoff, r.n, r.r_line_actual;
  END LOOP;
END $$;
