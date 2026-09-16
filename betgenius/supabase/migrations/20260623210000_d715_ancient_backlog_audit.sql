SET statement_timeout = '60s';
DO $$ DECLARE rec record; n int;
BEGIN
  -- 1. Total count + date range of 14+d unresolved
  SELECT count(*) INTO n FROM pick_history
   WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days';
  RAISE NOTICE 'Total 14+d unresolved: %', n;

  -- 2. Date range
  FOR rec IN
    SELECT min(created_at) AS oldest, max(created_at) AS newest
    FROM pick_history WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
  LOOP
    RAISE NOTICE 'Date range: % → %', rec.oldest, rec.newest;
  END LOOP;

  -- 3. By sport
  RAISE NOTICE '=== By sport ===';
  FOR rec IN
    SELECT sport, count(*) AS n
    FROM pick_history WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
    GROUP BY sport ORDER BY n DESC
  LOOP
    RAISE NOTICE '  sport=% n=%', rec.sport, rec.n;
  END LOOP;

  -- 4. By is_synthetic
  RAISE NOTICE '=== By is_synthetic ===';
  FOR rec IN
    SELECT is_synthetic, source, count(*) AS n
    FROM pick_history WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
    GROUP BY is_synthetic, source ORDER BY n DESC
  LOOP
    RAISE NOTICE '  is_synthetic=% source=% n=%', rec.is_synthetic, rec.source, rec.n;
  END LOOP;

  -- 5. By market type (MLB)
  RAISE NOTICE '=== By mlb_market_type (top 10) ===';
  FOR rec IN
    SELECT COALESCE(mlb_market_type, prop_type) AS market, count(*) AS n
    FROM pick_history WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
    GROUP BY 1 ORDER BY n DESC LIMIT 15
  LOOP
    RAISE NOTICE '  market=% n=%', rec.market, rec.n;
  END LOOP;

  -- 6. By creation month
  RAISE NOTICE '=== By creation month ===';
  FOR rec IN
    SELECT to_char(created_at, 'YYYY-MM') AS ym, count(*) AS n
    FROM pick_history WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE '  %  n=%', rec.ym, rec.n;
  END LOOP;

  -- 7. Distinct game_date count
  SELECT count(DISTINCT game_date) INTO n FROM pick_history
   WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days';
  RAISE NOTICE 'Distinct game_dates: %', n;

  -- 8. Synthetic vs real split with resolved_at status
  RAISE NOTICE '=== Resolved_at status (does resolver have a stuck attempt or never tried?) ===';
  FOR rec IN
    SELECT
      CASE WHEN resolved_at IS NULL THEN 'never_attempted' ELSE 'resolved_but_hit_null' END AS status,
      is_synthetic,
      count(*) AS n
    FROM pick_history WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
    GROUP BY 1,2 ORDER BY n DESC
  LOOP
    RAISE NOTICE '  status=% synth=% n=%', rec.status, rec.is_synthetic, rec.n;
  END LOOP;
END $$;
