-- D-614 SHIP 1 — read the D-611 instrument's captured rows to identify
-- the exact NaN factor for batter_hits/hr/tb.

DO $$
DECLARE r RECORD; v_total bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-614 SHIP 1 — D-611 diagnostic rows';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Total count
  SELECT count(*) INTO v_total FROM public.error_log
   WHERE error_type = 'd611_confidence_nan_diag';
  RAISE NOTICE '';
  RAISE NOTICE '[A] total d611_confidence_nan_diag rows: %', v_total;

  -- Count by market
  RAISE NOTICE '';
  RAISE NOTICE '[B] by market:';
  FOR r IN
    SELECT context->>'market' AS market, count(*) AS n
      FROM public.error_log
     WHERE error_type = 'd611_confidence_nan_diag'
     GROUP BY context->>'market' ORDER BY count(*) DESC
  LOOP RAISE NOTICE '  market=% n=%', r.market, r.n; END LOOP;

  -- nan_factors aggregated — which factors are NaN
  RAISE NOTICE '';
  RAISE NOTICE '[C] which factors are non-finite (across all rows):';
  FOR r IN
    SELECT
      jsonb_array_elements_text(context->'nan_factors') AS factor_kv,
      count(*) AS n
    FROM public.error_log
    WHERE error_type = 'd611_confidence_nan_diag'
    GROUP BY factor_kv
    ORDER BY count(*) DESC LIMIT 30
  LOOP RAISE NOTICE '  %  n=%', r.factor_kv, r.n; END LOOP;

  -- nan_inputs aggregated — which inputs are non-finite
  RAISE NOTICE '';
  RAISE NOTICE '[D] which inputs are non-finite (across all rows):';
  FOR r IN
    SELECT
      jsonb_array_elements_text(context->'nan_inputs') AS input_kv,
      count(*) AS n
    FROM public.error_log
    WHERE error_type = 'd611_confidence_nan_diag'
    GROUP BY input_kv
    ORDER BY count(*) DESC LIMIT 30
  LOOP RAISE NOTICE '  %  n=%', r.input_kv, r.n; END LOOP;

  -- 3 most-recent full samples — see all factor + input values
  RAISE NOTICE '';
  RAISE NOTICE '[E] 3 most-recent sample rows (full context):';
  FOR r IN
    SELECT created_at,
           context->>'market' AS market,
           context->>'player' AS player,
           context->'nan_factors' AS nan_factors,
           context->'nan_inputs'  AS nan_inputs,
           context->'all_inputs'  AS all_inputs
      FROM public.error_log
     WHERE error_type = 'd611_confidence_nan_diag'
     ORDER BY created_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '  at=% market=% player=%', r.created_at, r.market, r.player;
    RAISE NOTICE '    nan_factors=%', r.nan_factors;
    RAISE NOTICE '    nan_inputs=%',  r.nan_inputs;
    RAISE NOTICE '    all_inputs=%',  r.all_inputs;
  END LOOP;
END $$;
