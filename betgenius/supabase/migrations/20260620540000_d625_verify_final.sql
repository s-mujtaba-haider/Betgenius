DO $$ DECLARE r RECORD; v_total bigint; v_pending bigint; v_resolved_30m bigint; v_resolved_5m bigint; BEGIN
  -- Total pending (all-time, mlb, real, not voided, before today)
  SELECT count(*) INTO v_pending
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false AND voided IS NOT TRUE
     AND hit IS NULL AND resolved_at IS NULL
     AND game_date IS NOT NULL AND game_date::date <= now()::date;
  RAISE NOTICE '[1] Total MLB pending (game_date <= today): % (BEFORE 8,349)', v_pending;
  RAISE NOTICE '    NET drop: % picks resolved', 8349 - v_pending;

  -- By market
  RAISE NOTICE '';
  RAISE NOTICE '[2] By market AFTER backfill:';
  FOR r IN
    SELECT COALESCE(mlb_market_type,'(null)') AS market, count(*) AS n
      FROM public.pick_history
     WHERE sport = 'mlb' AND is_synthetic = false AND voided IS NOT TRUE
       AND hit IS NULL AND resolved_at IS NULL
       AND game_date IS NOT NULL AND game_date::date <= now()::date
     GROUP BY mlb_market_type
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  market=% pending=%', r.market, r.n;
  END LOOP;

  -- Resolved windows
  RAISE NOTICE '';
  SELECT count(*) INTO v_resolved_30m
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false
     AND resolved_at >= now() - interval '30 minutes';
  SELECT count(*) INTO v_resolved_5m
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false
     AND resolved_at >= now() - interval '5 minutes';
  RAISE NOTICE '[3] MLB picks resolved last 30m: % (last 5m: %)', v_resolved_30m, v_resolved_5m;

  -- Async backfill response status (req 30574-30578)
  RAISE NOTICE '';
  RAISE NOTICE '[4] Status of the 5 backfill HTTP calls:';
  FOR r IN
    SELECT id, status_code, regexp_replace(LEFT(COALESCE(content::text,''),250), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response
     WHERE id IN (30574, 30575, 30576, 30577, 30578)
     ORDER BY id
  LOOP
    RAISE NOTICE '  id=% status=% body=%', r.id, r.status_code, r.body;
  END LOOP;
END $$;
