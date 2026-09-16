DO $$ DECLARE r RECORD; BEGIN
  FOR r IN
    SELECT id, status_code, created, content::JSONB AS body FROM net._http_response
    WHERE created >= NOW() - INTERVAL '3 minutes' ORDER BY created DESC LIMIT 2
  LOOP
    RAISE NOTICE 'resp id=% status=% claimed=% dispatched=% failed=% skipped=% dur_ms=%',
      r.id, r.status_code, r.body->>'claimed', r.body->>'dispatched',
      r.body->>'failed', r.body->>'skipped', r.body->>'duration_ms';
  END LOOP;
  -- yesterday pending now
  DECLARE v_n INT; BEGIN
    SELECT COUNT(*) INTO v_n FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_time::timestamptz >= '2026-06-21T00:00:00Z'
      AND game_time::timestamptz < '2026-06-22T00:00:00Z'
      AND hit IS NULL AND resolved_at IS NULL;
    RAISE NOTICE 'D-694 yesterday-cohort pending NOW: % (was 1467)', v_n;
  END;
END $$;
