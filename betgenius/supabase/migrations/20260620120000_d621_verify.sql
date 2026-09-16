DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-621 verify AFTER cleanup + VACUUM (% UTC)', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — post-cleanup table sizes
  RAISE NOTICE '';
  RAISE NOTICE '[A] Sizes AFTER VACUUM (compare to BEFORE in diagnose §A):';
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS table_name,
           pg_total_relation_size(c.oid) AS total_bytes,
           pg_relation_size(c.oid) AS table_only_bytes,
           pg_indexes_size(c.oid) AS index_bytes
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname IN ('public','cron')
       AND c.relname IN ('error_log','run_log','props_cache','recommendations_cache','pick_history','sonnet_usage_log','job_run_details','cache_mlb_historical_odds')
       AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC
  LOOP
    RAISE NOTICE '  %.% : total=% table=% index=%',
      r.schema, r.table_name,
      pg_size_pretty(r.total_bytes), pg_size_pretty(r.table_only_bytes), pg_size_pretty(r.index_bytes);
  END LOOP;

  -- §B — dead-tuple ratio AFTER vacuum (should be much lower for vacuumed tables)
  RAISE NOTICE '';
  RAISE NOTICE '[B] Dead-tuple ratio AFTER vacuum:';
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS table_name,
           s.n_live_tup AS live, s.n_dead_tup AS dead,
           CASE WHEN s.n_live_tup > 0 THEN
             round(100.0 * s.n_dead_tup / NULLIF(s.n_live_tup,0), 1)
           ELSE NULL END AS dead_pct,
           s.last_vacuum, s.last_autovacuum
      FROM pg_stat_user_tables s
      JOIN pg_class c ON s.relid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE c.relname IN ('error_log','run_log','props_cache','recommendations_cache','pick_history','sonnet_usage_log')
     ORDER BY s.n_dead_tup DESC
  LOOP
    RAISE NOTICE '  %.% : live=% dead=% (% %%) last_vac=% last_autovac=%',
      r.schema, r.table_name, r.live, r.dead, r.dead_pct,
      COALESCE(to_char(r.last_vacuum,'YYYY-MM-DD HH24:MI'),'(never)'),
      COALESCE(to_char(r.last_autovacuum,'YYYY-MM-DD HH24:MI'),'(never)');
  END LOOP;

  -- §C — confirm pick_history row count unchanged from diagnose (130,621)
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_synthetic = true) AS synthetic,
           count(*) FILTER (WHERE is_synthetic = false) AS real
      FROM public.pick_history
  LOOP
    RAISE NOTICE '[C] pick_history POST: total=% synthetic=% real=% (expected 130,621 ± write since diagnose)',
      r.total, r.synthetic, r.real;
  END LOOP;

  -- §D — confirm cleanup target tables are smaller than before
  RAISE NOTICE '';
  RAISE NOTICE '[D] Log-table row counts (compare to BEFORE):';
  FOR r IN
    SELECT 'error_log' AS t, count(*) AS n FROM public.error_log
    UNION ALL
    SELECT 'run_log', count(*) FROM public.run_log
    UNION ALL
    SELECT 'cron.job_run_details', count(*) FROM cron.job_run_details
    UNION ALL
    SELECT 'sonnet_usage_log', count(*) FROM public.sonnet_usage_log
  LOOP
    RAISE NOTICE '  % : % rows', r.t, r.n;
  END LOOP;
END $$;
