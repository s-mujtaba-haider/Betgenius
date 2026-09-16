-- D-503 SHIP 2 — replicate the Admin Algorithm Performance query at
-- Admin.tsx:323 + step through each filter cohort to find where it
-- becomes empty. READ-ONLY.
DO $$
DECLARE v_count BIGINT;
BEGIN
  -- Total pick_history rows
  SELECT count(*) INTO v_count FROM public.pick_history;
  RAISE NOTICE '[D-503 PERF] pick_history total rows: %', v_count;

  -- Step 1: voided != true (so NULL or false passes)
  SELECT count(*) INTO v_count FROM public.pick_history WHERE voided IS DISTINCT FROM true;
  RAISE NOTICE '[D-503 PERF] STEP 1 — voided != true: %', v_count;

  -- Step 2: + is_synthetic = false
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE voided IS DISTINCT FROM true AND is_synthetic = false;
  RAISE NOTICE '[D-503 PERF] STEP 2 — + is_synthetic=false: %', v_count;

  -- Step 3: + (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE voided IS DISTINCT FROM true
     AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false);
  RAISE NOTICE '[D-503 PERF] STEP 3 — + is_d214_quarantined coalesce: %', v_count;

  -- Step 4: + game_date IS NOT NULL (the exact Admin query)
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE voided IS DISTINCT FROM true
     AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL;
  RAISE NOTICE '[D-503 PERF] STEP 4 — + game_date NOT NULL: % (this is what Admin fetches)', v_count;

  -- Step 5: client filters confidence >= 70 (picks70Plus)
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE voided IS DISTINCT FROM true
     AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL
     AND confidence >= 70;
  RAISE NOTICE '[D-503 PERF] STEP 5 — picks70Plus (+confidence>=70): %', v_count;

  -- Step 6: client filters hit !== null (resolved)
  SELECT count(*) INTO v_count FROM public.pick_history
   WHERE voided IS DISTINCT FROM true
     AND is_synthetic = false
     AND (is_d214_quarantined IS NULL OR is_d214_quarantined = false)
     AND game_date IS NOT NULL
     AND confidence >= 70
     AND hit IS NOT NULL;
  RAISE NOTICE '[D-503 PERF] STEP 6 — resolved 70+: % ← THE NUMBER THAT DRIVES THE PANEL', v_count;

  -- Diagnostic: pick_history columns relevant to filtering
  -- check what is_synthetic / voided / is_d214_quarantined look like
  RAISE NOTICE '[D-503 PERF] column null-rates (for filtering surface):';
  SELECT count(*) FILTER (WHERE voided IS NULL) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  voided IS NULL: %', v_count;
  SELECT count(*) FILTER (WHERE voided = true) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  voided = true: %', v_count;
  SELECT count(*) FILTER (WHERE is_synthetic IS NULL) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  is_synthetic IS NULL: %', v_count;
  SELECT count(*) FILTER (WHERE is_synthetic = true) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  is_synthetic = true: %', v_count;
  SELECT count(*) FILTER (WHERE game_date IS NULL) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  game_date IS NULL: %', v_count;
  SELECT count(*) FILTER (WHERE is_d214_quarantined = true) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  is_d214_quarantined = true: %', v_count;
  SELECT count(*) FILTER (WHERE confidence >= 70) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  confidence >= 70: %', v_count;
  SELECT count(*) FILTER (WHERE hit IS NOT NULL) INTO v_count FROM public.pick_history;
  RAISE NOTICE '  hit IS NOT NULL: %', v_count;
END $$;
