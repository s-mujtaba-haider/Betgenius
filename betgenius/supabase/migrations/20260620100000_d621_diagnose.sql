DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-621 disk IO diagnose — READ-ONLY — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — top 15 tables by total size (table + indexes + toast)
  RAISE NOTICE '';
  RAISE NOTICE '[A] Top 15 PUBLIC + CRON tables by total_relation_size:';
  RAISE NOTICE '   table | rows | total_size | table_only | indexes';
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS table_name,
           pg_total_relation_size(c.oid) AS total_bytes,
           pg_relation_size(c.oid) AS table_only_bytes,
           pg_indexes_size(c.oid) AS index_bytes,
           c.reltuples::bigint AS est_rows
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE n.nspname IN ('public','cron')
       AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC
     LIMIT 15
  LOOP
    RAISE NOTICE '  %.% : rows~% | total=% | table=% | index=%',
      r.schema, r.table_name, r.est_rows,
      pg_size_pretty(r.total_bytes), pg_size_pretty(r.table_only_bytes), pg_size_pretty(r.index_bytes);
  END LOOP;

  -- §B — dead-tuple ratio for the top suspects
  RAISE NOTICE '';
  RAISE NOTICE '[B] Dead-tuple ratio (n_dead/n_live) — VACUUM candidates:';
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
     WHERE (s.n_live_tup + s.n_dead_tup) > 1000
     ORDER BY s.n_dead_tup DESC
     LIMIT 15
  LOOP
    RAISE NOTICE '  %.% : live=% dead=% (% %%) last_vac=% last_autovac=%',
      r.schema, r.table_name, r.live, r.dead, r.dead_pct,
      COALESCE(to_char(r.last_vacuum,'YYYY-MM-DD HH24:MI'),'(never)'),
      COALESCE(to_char(r.last_autovacuum,'YYYY-MM-DD HH24:MI'),'(never)');
  END LOOP;

  -- §C — error_log breakdown by type
  RAISE NOTICE '';
  RAISE NOTICE '[C] error_log breakdown by error_type (current state):';
  FOR r IN
    SELECT error_type, count(*) AS n,
           count(*) FILTER (WHERE created_at < now() - interval '30 days') AS older_30d,
           count(*) FILTER (WHERE created_at < now() - interval '90 days') AS older_90d,
           min(created_at) AS oldest, max(created_at) AS newest
      FROM public.error_log
     GROUP BY error_type
     ORDER BY count(*) DESC
     LIMIT 15
  LOOP
    RAISE NOTICE '  type=% : total=% (>30d=% >90d=%) oldest=% newest=%',
      r.error_type, r.n, r.older_30d, r.older_90d,
      to_char(r.oldest,'YYYY-MM-DD'), to_char(r.newest,'YYYY-MM-DD');
  END LOOP;

  -- §D — cron.job_run_details size and counts
  RAISE NOTICE '';
  RAISE NOTICE '[D] cron.job_run_details retention:';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE start_time < now() - interval '30 days') AS older_30d,
           count(*) FILTER (WHERE start_time < now() - interval '90 days') AS older_90d,
           min(start_time) AS oldest, max(start_time) AS newest
      FROM cron.job_run_details
  LOOP
    RAISE NOTICE '  total=% (>30d=% >90d=%) oldest=% newest=%',
      r.total, r.older_30d, r.older_90d,
      to_char(r.oldest,'YYYY-MM-DD'), to_char(r.newest,'YYYY-MM-DD');
  END LOOP;

  -- §E — sonnet_usage_log retention
  RAISE NOTICE '';
  RAISE NOTICE '[E] sonnet_usage_log retention:';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE created_at < now() - interval '30 days') AS older_30d,
           count(*) FILTER (WHERE created_at < now() - interval '90 days') AS older_90d,
           min(created_at) AS oldest, max(created_at) AS newest,
           coalesce(sum(computed_cost_usd),0)::numeric(12,4) AS total_cost
      FROM public.sonnet_usage_log
  LOOP
    RAISE NOTICE '  total=% (>30d=% >90d=%) oldest=% newest=% lifetime_cost=$%',
      r.total, r.older_30d, r.older_90d,
      to_char(r.oldest,'YYYY-MM-DD'), to_char(r.newest,'YYYY-MM-DD'), r.total_cost;
  END LOOP;

  -- §F — run_log retention (if exists)
  RAISE NOTICE '';
  RAISE NOTICE '[F] run_log retention:';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE created_at < now() - interval '30 days') AS older_30d,
           min(created_at) AS oldest, max(created_at) AS newest
      FROM public.run_log
  LOOP
    RAISE NOTICE '  total=% (>30d=%) oldest=% newest=%',
      r.total, r.older_30d,
      to_char(r.oldest,'YYYY-MM-DD'), to_char(r.newest,'YYYY-MM-DD');
  END LOOP;

  -- §G — pick_history (DO NOT TOUCH — core data, just measure)
  RAISE NOTICE '';
  RAISE NOTICE '[G] pick_history (CORE DATA — vacuum only, never delete):';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE is_synthetic = true) AS synthetic,
           count(*) FILTER (WHERE is_synthetic = false) AS real,
           min(created_at) AS oldest, max(created_at) AS newest
      FROM public.pick_history
  LOOP
    RAISE NOTICE '  total=% (synthetic=% real=%) oldest=% newest=%',
      r.total, r.synthetic, r.real,
      to_char(r.oldest,'YYYY-MM-DD'), to_char(r.newest,'YYYY-MM-DD');
  END LOOP;

  -- §H — props_cache (refreshed daily, retention?)
  RAISE NOTICE '';
  RAISE NOTICE '[H] props_cache retention:';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE game_date::text < to_char(now()::date - interval '7 days','YYYYMMDD')) AS older_7d,
           count(*) FILTER (WHERE game_date::text < to_char(now()::date - interval '30 days','YYYYMMDD')) AS older_30d,
           count(DISTINCT game_date) AS distinct_dates
      FROM public.props_cache
     WHERE sport = 'mlb'
  LOOP
    RAISE NOTICE '  MLB total=% (>7d=% >30d=% distinct_dates=%)',
      r.total, r.older_7d, r.older_30d, r.distinct_dates;
  END LOOP;

  -- §I — recommendations_cache retention
  RAISE NOTICE '';
  RAISE NOTICE '[I] recommendations_cache retention:';
  FOR r IN
    SELECT count(*) AS total,
           count(DISTINCT game_date) AS distinct_dates,
           min(game_date) AS oldest_date, max(game_date) AS newest_date
      FROM public.recommendations_cache
  LOOP
    RAISE NOTICE '  total=% (distinct_dates=% oldest=% newest=%)',
      r.total, r.distinct_dates, r.oldest_date, r.newest_date;
  END LOOP;

END $$;
