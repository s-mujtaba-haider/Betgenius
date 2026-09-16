-- D-198 §1.12 paired verification migration.
-- Documents post-deploy checks. Kept on disk per D-138.
--
-- Query 1: confirm table + seed.
DO $$
DECLARE
  tbl_count INT;
  modifier_count INT;
  nonidentity_count INT;
BEGIN
  SELECT COUNT(*) INTO tbl_count FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'algorithm_weights_tier_modifiers';
  SELECT COUNT(*) INTO modifier_count FROM public.algorithm_weights_tier_modifiers;
  SELECT COUNT(*) INTO nonidentity_count FROM public.algorithm_weights_tier_modifiers WHERE multiplier <> 1.0;
  IF tbl_count = 0 THEN
    RAISE EXCEPTION 'D-198 VERIFY FAIL: algorithm_weights_tier_modifiers table missing';
  END IF;
  RAISE NOTICE 'D-198 VERIFY: table OK, seed_count=%, nonidentity_count=%', modifier_count, nonidentity_count;
  -- Identity seed expectation: 5 tiers × 26 factors = 130 rows, all 1.0 multiplier.
  IF modifier_count < 130 THEN
    RAISE WARNING 'D-198 VERIFY: seed undercount (expected 130, got %)', modifier_count;
  END IF;
END $$;

-- Query 2: confirm audit column exists on pick_history.
DO $$
DECLARE
  col_count INT;
BEGIN
  SELECT COUNT(*) INTO col_count FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pick_history'
      AND column_name = 'confidence_pre_tier_aware';
  IF col_count = 0 THEN
    RAISE EXCEPTION 'D-198 VERIFY FAIL: pick_history.confidence_pre_tier_aware column missing';
  END IF;
  RAISE NOTICE 'D-198 VERIFY: pick_history.confidence_pre_tier_aware column present';
END $$;

-- Query 3 (post-deploy, manual): confirm RPC accepts the new column.
-- (Skipped here — RPC body change is tested empirically by next cron tick
-- writing a row with confidence_pre_tier_aware populated.)

-- Query 4 (post-deploy, manual run after one cron tick): confirm rows
-- written post-deploy populate confidence_pre_tier_aware.
--
--   SELECT COUNT(*) FROM public.pick_history
--   WHERE created_at > '2026-05-17T18:00:00Z'
--     AND source = 'process-games'
--     AND confidence_pre_tier_aware IS NOT NULL;
--
-- Expected: > 0 within 30 min of next cron tick (once scoring.ts is wired).

-- Query 5: confirm identity invariant on initial ship.
-- All multipliers must equal 1.0 immediately post-seed (CEO §19.3
-- approval required to UPDATE any multiplier ≠ 1.0 going forward).
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM public.algorithm_weights_tier_modifiers
    WHERE multiplier <> 1.0;
  IF bad_count > 0 THEN
    RAISE WARNING 'D-198 VERIFY: % multiplier(s) ≠ 1.0 (post-§19.3 tuning expected; flag if pre-tuning state)', bad_count;
  ELSE
    RAISE NOTICE 'D-198 VERIFY: identity invariant holds (all 130 modifiers = 1.0)';
  END IF;
END $$;
