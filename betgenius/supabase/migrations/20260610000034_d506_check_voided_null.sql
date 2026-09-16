DO $$
DECLARE r RECORD; v_count BIGINT;
BEGIN
  -- breakdown of voided values on stalled picks
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND is_synthetic = false
     AND game_date >= DATE '2026-05-30' AND voided IS NULL;
  RAISE NOTICE '[D-506] stalled picks with voided IS NULL: %', v_count;

  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND is_synthetic = false
     AND game_date >= DATE '2026-05-30' AND voided = false;
  RAISE NOTICE '[D-506] stalled picks with voided = false: %', v_count;

  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND is_synthetic = false
     AND game_date >= DATE '2026-05-30' AND voided = true;
  RAISE NOTICE '[D-506] stalled picks with voided = true: %', v_count;

  -- And how the PostgREST filter "voided=neq.true" sees them
  -- (this matches the picks query at resolve-picks/index.ts:1324)
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND is_synthetic = false
     AND game_date >= DATE '2026-05-30' AND voided IS DISTINCT FROM true;
  RAISE NOTICE '[D-506] using IS DISTINCT FROM true (== resolve-picks intent): %', v_count;

  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND is_synthetic = false
     AND game_date >= DATE '2026-05-30' AND voided <> true;
  RAISE NOTICE '[D-506] using `voided <> true` (PostgREST neq.true behavior, NULL EXCLUDED): %', v_count;

  -- Check whether the OLDEST 200 picks (which is what resolve-picks fetches)
  -- have voided null on the cutoff date and pick state
  -- (cutoff = today - 14 days = 2026-05-27)
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND is_synthetic = false
     AND game_date >= DATE '2026-05-27'
     AND voided <> true;
  RAISE NOTICE '[D-506] resolve-picks effective candidate (voided<>true with 14d cutoff): %', v_count;
END $$;
