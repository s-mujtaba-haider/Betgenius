DO $$
DECLARE r RECORD;
BEGIN
  -- 1. algorithm_weights schema first
  RAISE NOTICE '[D-512 §a] algorithm_weights columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='algorithm_weights'
    ORDER BY ordinal_position
  LOOP RAISE NOTICE '  % %', r.column_name, r.data_type; END LOOP;

  -- 2. recent algorithm_weights changes
  RAISE NOTICE '[D-512 §b] algorithm_weights recent updates (2026-06-10 onward):';
  FOR r IN
    SELECT * FROM public.algorithm_weights
    WHERE updated_at::DATE >= '2026-06-10'::DATE
    ORDER BY updated_at LIMIT 25
  LOOP RAISE NOTICE '  row=%', row_to_json(r); END LOOP;

  -- 3. D-499 specific weights (look at MLB optimizer apply commit)
  -- d499apply migration filename: 20260610000001_d499apply_patch_7_weights.sql
  -- Let me look at the migrations table for D-499 patches
  RAISE NOTICE '[D-512 §c] D-499 migration applied?';
  FOR r IN
    SELECT version FROM supabase_migrations.schema_migrations
    WHERE version LIKE '%' ORDER BY version DESC LIMIT 250
  LOOP
    IF r.version LIKE '20260610%' OR r.version LIKE '20260609%' THEN
      RAISE NOTICE '  %', r.version;
    END IF;
  END LOOP;
END $$;
