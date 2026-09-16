DO $$ DECLARE r RECORD; v_pending bigint; v_pending_total bigint; BEGIN
  -- §A — current pending count
  SELECT count(*) INTO v_pending
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false AND voided IS NOT TRUE
     AND hit IS NULL AND resolved_at IS NULL
     AND game_date IS NOT NULL AND game_date::date <= now()::date - interval '1 day';
  RAISE NOTICE '[A] CURRENT MLB pending (game_date <= yesterday): %', v_pending;
  RAISE NOTICE '    BEFORE was 7,005. NET drop: % picks', 7005 - v_pending;

  -- §A2 — total all-time pending (any game_date)
  SELECT count(*) INTO v_pending_total
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false AND voided IS NOT TRUE
     AND hit IS NULL AND resolved_at IS NULL
     AND game_date IS NOT NULL AND game_date::date <= now()::date;
  RAISE NOTICE '[A2] CURRENT MLB pending (including today): %', v_pending_total;
  RAISE NOTICE '    BEFORE was 8,349. NET drop: % picks', 8349 - v_pending_total;

  -- §B — response bodies from 3 invocations
  RAISE NOTICE '';
  RAISE NOTICE '[B] Response bodies from backfill invocations (30560, 30562, 30564):';
  FOR r IN
    SELECT id, status_code, regexp_replace(LEFT(COALESCE(content::text,''),400), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response WHERE id IN (30560, 30562, 30564)
     ORDER BY id
  LOOP
    RAISE NOTICE '  id=% status=% body=%', r.id, r.status_code, r.body;
  END LOOP;

  -- §C — pending by market AFTER
  RAISE NOTICE '';
  RAISE NOTICE '[C] Pending by market AFTER 3 backfill invocations:';
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

  -- §D — MLB picks resolved in last 30 min (proves resolver IS firing now)
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS n
      FROM public.pick_history
     WHERE sport = 'mlb' AND is_synthetic = false
       AND resolved_at >= now() - interval '30 minutes'
  LOOP
    RAISE NOTICE '[D] MLB picks resolved in last 30 min: %', r.n;
  END LOOP;
END $$;
