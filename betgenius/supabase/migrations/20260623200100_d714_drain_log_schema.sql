SET statement_timeout = '30s';
DO $$ DECLARE rec record; cnt int;
BEGIN
  RAISE NOTICE '=== resolve_backlog_run_log columns ===';
  FOR rec IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='resolve_backlog_run_log'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  % %', rec.column_name, rec.data_type;
  END LOOP;

  RAISE NOTICE '=== Total entries in resolve_backlog_run_log ===';
  BEGIN
    SELECT count(*) INTO cnt FROM resolve_backlog_run_log;
    RAISE NOTICE '  total rows: %', cnt;
    FOR rec IN
      SELECT row_to_json(t) AS r FROM (
        SELECT * FROM resolve_backlog_run_log ORDER BY 1 DESC LIMIT 10
      ) t
    LOOP
      RAISE NOTICE '  %', rec.r;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '  err: %', SQLERRM;
  END;

  -- Resolved-in-last-24h count by mlb_market_type
  RAISE NOTICE '=== Picks RESOLVED in last 24h by mlb_market_type ===';
  FOR rec IN
    SELECT mlb_market_type, count(*) AS n
    FROM pick_history
    WHERE resolved_at > NOW() - INTERVAL '24 hours'
    GROUP BY 1 ORDER BY n DESC
  LOOP
    RAISE NOTICE '  % n=%', rec.mlb_market_type, rec.n;
  END LOOP;

  -- Specifically overnight (03-13 UTC today)
  RAISE NOTICE '=== Picks RESOLVED overnight 03:00-13:00 UTC today ===';
  SELECT count(*) INTO cnt FROM pick_history
    WHERE resolved_at >= NOW()::date + INTERVAL '3 hours'
      AND resolved_at < NOW()::date + INTERVAL '13 hours';
  RAISE NOTICE '  total overnight resolutions: %', cnt;

  -- Source-code change detection (overnight)
  RAISE NOTICE '=== algorithm_weights last update ===';
  FOR rec IN
    SELECT id, updated_at FROM algorithm_weights ORDER BY updated_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '  id=% updated_at=%', rec.id, rec.updated_at;
  END LOOP;
END $$;
