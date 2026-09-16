-- D-495 SHIP 1+2 inspection migration. READ-ONLY — no data changes.
-- Dumps live schema for 4 [UNVERIFIED] tables + the full cron job list
-- via RAISE NOTICE so the apply output captures everything. After
-- the apply runs, I read the NOTICEs back and write retroactive
-- CREATE migrations matching exactly.
--
-- This migration creates NO TABLES, ALTERS NO DATA, GRANTS NOTHING.
-- It only inspects.

DO $$
DECLARE
  r RECORD;
  t TEXT;
  tables TEXT[] := ARRAY['error_log','bets','notification_log','run_log'];
  table_found BOOLEAN;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) INTO table_found;

    IF NOT table_found THEN
      RAISE NOTICE '[D-495] PHANTOM TABLE: public.% does not exist', t;
      CONTINUE;
    END IF;

    RAISE NOTICE '=========================================';
    RAISE NOTICE '[D-495] TABLE public.%:', t;
    RAISE NOTICE '=========================================';

    -- 1. Columns
    RAISE NOTICE '--- COLUMNS ---';
    FOR r IN
      SELECT column_name, data_type, character_maximum_length,
             numeric_precision, numeric_scale,
             is_nullable, column_default, ordinal_position
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t
      ORDER BY ordinal_position
    LOOP
      RAISE NOTICE '[%] % : % | nullable=% | default=%',
        r.ordinal_position,
        r.column_name,
        CASE
          WHEN r.character_maximum_length IS NOT NULL
            THEN r.data_type || '(' || r.character_maximum_length || ')'
          WHEN r.numeric_precision IS NOT NULL AND r.numeric_scale IS NOT NULL
            THEN r.data_type || '(' || r.numeric_precision || ',' || r.numeric_scale || ')'
          ELSE r.data_type
        END,
        r.is_nullable,
        COALESCE(r.column_default, '<none>');
    END LOOP;

    -- 2. Constraints
    RAISE NOTICE '--- CONSTRAINTS ---';
    FOR r IN
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = ('public.' || t)::regclass
      ORDER BY conname
    LOOP
      RAISE NOTICE '% : %', r.conname, r.def;
    END LOOP;

    -- 3. Indexes
    RAISE NOTICE '--- INDEXES ---';
    FOR r IN
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname='public' AND tablename=t
      ORDER BY indexname
    LOOP
      RAISE NOTICE '% : %', r.indexname, r.indexdef;
    END LOOP;

    -- 4. Approximate row count
    RAISE NOTICE '--- ROW COUNT (approx via pg_stat_user_tables) ---';
    FOR r IN
      SELECT n_live_tup AS row_count
      FROM pg_stat_user_tables
      WHERE schemaname='public' AND relname=t
    LOOP
      RAISE NOTICE 'n_live_tup = %', r.row_count;
    END LOOP;
  END LOOP;

  -- 5. ALL cron jobs
  RAISE NOTICE '=========================================';
  RAISE NOTICE '[D-495] CRON JOBS (active + inactive)';
  RAISE NOTICE '=========================================';
  FOR r IN
    SELECT jobid, jobname, schedule, active, command
    FROM cron.job
    ORDER BY jobid
  LOOP
    RAISE NOTICE 'jobid=% | jobname=% | schedule=% | active=% | cmd_excerpt=%',
      r.jobid, r.jobname, r.schedule, r.active,
      substring(r.command, 1, 200);
  END LOOP;

  RAISE NOTICE '[D-495] inspection complete';
END $$;
