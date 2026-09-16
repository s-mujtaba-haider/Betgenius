DO $$ DECLARE r RECORD; v_def text; BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-623 real_money_bets 500 diagnose — READ-ONLY — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §1 — Is real_money_bets a view, materialized view, or table?
  RAISE NOTICE '';
  RAISE NOTICE '[1] real_money_bets object type:';
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
           CASE c.relkind
             WHEN 'r' THEN 'TABLE'
             WHEN 'v' THEN 'VIEW'
             WHEN 'm' THEN 'MATVIEW'
             WHEN 'f' THEN 'FOREIGN TABLE'
             ELSE c.relkind::text
           END AS kind_name
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
     WHERE c.relname = 'real_money_bets'
  LOOP
    RAISE NOTICE '  %.% : kind=% (%)', r.schema, r.name, r.kind, r.kind_name;
  END LOOP;

  -- §2 — View definition (full text)
  RAISE NOTICE '';
  RAISE NOTICE '[2] View definition for public.real_money_bets:';
  SELECT pg_get_viewdef('public.real_money_bets'::regclass, true) INTO v_def;
  IF v_def IS NOT NULL THEN
    RAISE NOTICE '%', v_def;
  ELSE
    RAISE NOTICE '  (not a view or definition unavailable)';
  END IF;

  -- §3 — Columns of the view
  RAISE NOTICE '';
  RAISE NOTICE '[3] Columns:';
  FOR r IN
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='real_money_bets'
     ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  % : % (nullable=%)', r.column_name, r.data_type, r.is_nullable;
  END LOOP;

  -- §4 — Recent error_log rows mentioning real_money_bets or 500-class issues
  RAISE NOTICE '';
  RAISE NOTICE '[4] error_log rows mentioning real_money_bets or 500/57014 (last 24h):';
  FOR r IN
    SELECT created_at, error_type, function_name,
           LEFT(COALESCE(error_message,''), 200) AS msg,
           LEFT(COALESCE(context::text,''), 300) AS ctx
      FROM public.error_log
     WHERE created_at >= now() - interval '24 hours'
       AND (
         error_message ILIKE '%real_money_bets%'
         OR context::text ILIKE '%real_money_bets%'
         OR error_message ILIKE '%57014%'
         OR error_message ILIKE '%statement timeout%'
         OR error_message ILIKE '%500%'
       )
     ORDER BY created_at DESC
     LIMIT 12
  LOOP
    RAISE NOTICE '  at=% type=% fn=%', r.created_at, r.error_type, r.function_name;
    RAISE NOTICE '    msg=%', r.msg;
    RAISE NOTICE '    ctx=%', r.ctx;
  END LOOP;

  -- §5 — d609 system-health or monitor checkpoints
  RAISE NOTICE '';
  RAISE NOTICE '[5] system-health / monitor checkpoints last 24h:';
  FOR r IN
    SELECT created_at, error_type, error_message,
           LEFT(COALESCE(context::text,''), 400) AS ctx
      FROM public.error_log
     WHERE created_at >= now() - interval '24 hours'
       AND (function_name = 'system-health' OR error_type ILIKE '%health%' OR error_message ILIKE '%health%')
     ORDER BY created_at DESC
     LIMIT 8
  LOOP
    RAISE NOTICE '  at=% type=% msg=%', r.created_at, r.error_type, r.error_message;
    RAISE NOTICE '    ctx=%', r.ctx;
  END LOOP;

  -- §6 — Underlying base tables of the view (and their sizes/row counts)
  RAISE NOTICE '';
  RAISE NOTICE '[6] Tables referenced by the view definition:';
  FOR r IN
    SELECT DISTINCT d.refobjid::regclass::text AS referenced_object
      FROM pg_depend d
      JOIN pg_rewrite rw ON d.objid = rw.oid
      JOIN pg_class c ON rw.ev_class = c.oid
     WHERE c.relname = 'real_money_bets'
       AND d.deptype = 'n'
       AND d.refobjid::regclass::text NOT LIKE 'pg_%'
  LOOP
    RAISE NOTICE '  %', r.referenced_object;
  END LOOP;
END $$;
