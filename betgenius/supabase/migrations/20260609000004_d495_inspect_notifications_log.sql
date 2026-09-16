-- D-495 follow-up inspect: notifications_log (plural). The name was
-- changed from singular notification_log → plural notifications_log in
-- migration 20260506000007 (D-CEO refactor, May 6). D-494 doc had the
-- wrong (singular) name. READ-ONLY — RAISE NOTICE only.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=========================================';
  RAISE NOTICE '[D-495] TABLE public.notifications_log:';
  RAISE NOTICE '=========================================';
  RAISE NOTICE '--- COLUMNS ---';
  FOR r IN
    SELECT column_name, data_type, character_maximum_length,
           numeric_precision, numeric_scale, is_nullable, column_default,
           ordinal_position
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notifications_log'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '[%] % : % | nullable=% | default=%',
      r.ordinal_position, r.column_name,
      CASE
        WHEN r.character_maximum_length IS NOT NULL
          THEN r.data_type || '(' || r.character_maximum_length || ')'
        WHEN r.numeric_precision IS NOT NULL AND r.numeric_scale IS NOT NULL
          THEN r.data_type || '(' || r.numeric_precision || ',' || r.numeric_scale || ')'
        ELSE r.data_type
      END,
      r.is_nullable, COALESCE(r.column_default, '<none>');
  END LOOP;

  RAISE NOTICE '--- CONSTRAINTS ---';
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'public.notifications_log'::regclass
    ORDER BY conname
  LOOP
    RAISE NOTICE '% : %', r.conname, r.def;
  END LOOP;

  RAISE NOTICE '--- INDEXES ---';
  FOR r IN
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname='public' AND tablename='notifications_log'
    ORDER BY indexname
  LOOP
    RAISE NOTICE '% : %', r.indexname, r.indexdef;
  END LOOP;

  RAISE NOTICE '--- ROW COUNT ---';
  FOR r IN
    SELECT n_live_tup AS row_count
    FROM pg_stat_user_tables
    WHERE schemaname='public' AND relname='notifications_log'
  LOOP
    RAISE NOTICE 'n_live_tup = %', r.row_count;
  END LOOP;

  -- ALSO: get the constraint + index dumps for error_log + bets + run_log
  -- since the first migration's loop showed empty CONSTRAINTS/INDEXES for
  -- two of them (probably because the constraints/indexes don't print
  -- on the first loop iteration of a multi-table FOREACH for some PG
  -- versions). Re-query each individually:
  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'public.error_log'::regclass
    ORDER BY conname
  LOOP
    RAISE NOTICE '[error_log CONSTRAINT] % : %', r.conname, r.def;
  END LOOP;
  FOR r IN
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='error_log'
    ORDER BY indexname
  LOOP
    RAISE NOTICE '[error_log INDEX] % : %', r.indexname, r.indexdef;
  END LOOP;

  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'public.bets'::regclass
    ORDER BY conname
  LOOP
    RAISE NOTICE '[bets CONSTRAINT] % : %', r.conname, r.def;
  END LOOP;
  FOR r IN
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='bets'
    ORDER BY indexname
  LOOP
    RAISE NOTICE '[bets INDEX] % : %', r.indexname, r.indexdef;
  END LOOP;

  FOR r IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = 'public.run_log'::regclass
    ORDER BY conname
  LOOP
    RAISE NOTICE '[run_log CONSTRAINT] % : %', r.conname, r.def;
  END LOOP;
  FOR r IN
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='run_log'
    ORDER BY indexname
  LOOP
    RAISE NOTICE '[run_log INDEX] % : %', r.indexname, r.indexdef;
  END LOOP;
END $$;
