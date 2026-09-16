-- Comprehensive dependency probe for C33 Phase 6 (May 8, 2026).
--
-- We hit a 2BP01 dependent_objects_still_exist when trying to DROP COLUMN
-- pick_history.game_date — real_money_bets view depends on it. Need a full
-- dependency map for BOTH pick_history.game_date AND recommendations_cache.game_date
-- before constructing the cutover transaction.
--
-- Read-only. NOTICE output only.

DO $$
DECLARE
  v_row RECORD;
  v_view_def TEXT;
  v_bets_cols TEXT;
  v_pick_history_cols TEXT;
  v_rec_cache_cols TEXT;
  v_index_def TEXT;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 1: pg_depend — every object that references pick_history.game_date or recommendations_cache.game_date';
  RAISE NOTICE '================================================================';

  FOR v_row IN
    WITH target_cols AS (
      SELECT
        c.oid AS table_oid,
        a.attnum,
        c.relname AS table_name,
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS column_type,
        a.attnotnull AS not_null
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relname IN ('pick_history', 'recommendations_cache')
        AND a.attname IN ('game_date', 'game_date_new')
        AND a.attnum > 0
    )
    SELECT
      tc.table_name || '.' || tc.column_name AS source_col,
      tc.column_type AS source_type,
      tc.not_null AS source_not_null,
      d.deptype AS dep_kind,
      CASE
        WHEN dep_class.relname IS NOT NULL THEN dep_class.relname
        WHEN dep_proc.proname IS NOT NULL THEN 'function:' || dep_proc.proname
        WHEN dep_rewrite.rulename IS NOT NULL THEN 'rule:' || dep_rewrite.rulename || ' on ' || dep_rewrite_class.relname
        WHEN dep_constraint.conname IS NOT NULL THEN 'constraint:' || dep_constraint.conname
        ELSE 'classid=' || d.classid::TEXT || ' objid=' || d.objid::TEXT
      END AS dependent_object,
      CASE WHEN dep_class.relkind IS NOT NULL THEN
        CASE dep_class.relkind
          WHEN 'r' THEN 'table'
          WHEN 'v' THEN 'view'
          WHEN 'm' THEN 'materialized view'
          WHEN 'i' THEN 'index'
          WHEN 'S' THEN 'sequence'
          WHEN 'c' THEN 'composite type'
          WHEN 'p' THEN 'partitioned table'
          ELSE dep_class.relkind::TEXT
        END
      ELSE '(non-relation)'
      END AS dep_kind_human
    FROM pg_depend d
    JOIN target_cols tc ON tc.table_oid = d.refobjid AND tc.attnum = d.refobjsubid
    LEFT JOIN pg_class dep_class ON dep_class.oid = d.objid AND d.classid = 'pg_class'::regclass
    LEFT JOIN pg_proc dep_proc ON dep_proc.oid = d.objid AND d.classid = 'pg_proc'::regclass
    LEFT JOIN pg_rewrite dep_rewrite ON dep_rewrite.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
    LEFT JOIN pg_class dep_rewrite_class ON dep_rewrite_class.oid = dep_rewrite.ev_class
    LEFT JOIN pg_constraint dep_constraint ON dep_constraint.oid = d.objid AND d.classid = 'pg_constraint'::regclass
    WHERE d.refclassid = 'pg_class'::regclass
      AND d.deptype <> 'i'  -- skip implicit (catalog-internal) deps
    ORDER BY tc.table_name, tc.column_name, dep_kind_human, dependent_object
  LOOP
    RAISE NOTICE '  % (%) [not_null=%]  →  % %  [deptype=%]',
      v_row.source_col, v_row.source_type, v_row.source_not_null,
      v_row.dep_kind_human, v_row.dependent_object, v_row.dep_kind;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 2: real_money_bets view full definition';
  RAISE NOTICE '================================================================';

  BEGIN
    SELECT pg_get_viewdef('public.real_money_bets'::regclass, true) INTO v_view_def;
    RAISE NOTICE '%', v_view_def;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  view real_money_bets not found OR pg_get_viewdef failed: %', SQLERRM;
  END;

  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 3: bets table — column types (esp. anything *_date* or *date*)';
  RAISE NOTICE '================================================================';

  FOR v_row IN
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bets'
      AND (column_name ILIKE '%date%' OR column_name = 'pick_id' OR column_name = 'placed_at')
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  bets.% type=% nullable=% default=%',
      v_row.column_name, v_row.data_type, v_row.is_nullable, COALESCE(v_row.column_default, '(none)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 4: pick_history columns currently — confirm dual-write columns + types';
  RAISE NOTICE '================================================================';

  FOR v_row IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pick_history'
      AND column_name IN ('game_date', 'game_date_new', 'id', 'created_at')
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  pick_history.% type=% nullable=%',
      v_row.column_name, v_row.data_type, v_row.is_nullable;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 5: recommendations_cache columns — confirm dual-write columns + types';
  RAISE NOTICE '================================================================';

  FOR v_row IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'recommendations_cache'
      AND column_name IN ('game_date', 'game_date_new', 'id', 'created_at')
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  recommendations_cache.% type=% nullable=%',
      v_row.column_name, v_row.data_type, v_row.is_nullable;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 6: indexes on pick_history + recommendations_cache referencing game_date or game_date_new';
  RAISE NOTICE '================================================================';

  FOR v_row IN
    SELECT
      i.relname AS index_name,
      c.relname AS table_name,
      pg_get_indexdef(i.oid) AS index_def
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class c ON c.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('pick_history', 'recommendations_cache')
      AND pg_get_indexdef(i.oid) ILIKE '%game_date%'
    ORDER BY c.relname, i.relname
  LOOP
    RAISE NOTICE '  % (on %): %', v_row.index_name, v_row.table_name, v_row.index_def;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 7: triggers on pick_history or recommendations_cache that might reference game_date';
  RAISE NOTICE '================================================================';

  FOR v_row IN
    SELECT
      t.tgname AS trigger_name,
      c.relname AS table_name,
      pg_get_triggerdef(t.oid) AS trigger_def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('pick_history', 'recommendations_cache', 'bets')
      AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname
  LOOP
    RAISE NOTICE '  trigger % on % :: %', v_row.trigger_name, v_row.table_name,
      LEFT(v_row.trigger_def, 200);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '================================================================';
  RAISE NOTICE 'PART 8: functions whose body references game_date (text-search of pg_proc.prosrc)';
  RAISE NOTICE '================================================================';

  FOR v_row IN
    SELECT
      n.nspname || '.' || p.proname AS func_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
      LENGTH(p.prosrc) AS body_len
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public')
      AND p.prosrc ILIKE '%game_date%'
    ORDER BY n.nspname, p.proname
  LOOP
    RAISE NOTICE '  % (%) body_len=%', v_row.func_name, v_row.args, v_row.body_len;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== END DEPENDENCY MAP ===';
END $$;
