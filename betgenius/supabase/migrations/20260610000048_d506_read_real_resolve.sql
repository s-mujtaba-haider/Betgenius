DO $$
DECLARE v_body TEXT; v_status INT; v_post_pending BIGINT; v_recent_resolved BIGINT;
BEGIN
  -- Wait for processing
  PERFORM pg_sleep(60);

  -- Read response
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'),
         status_code
    INTO v_body, v_status
    FROM net._http_response WHERE id = 12114;

  RAISE NOTICE '[D-506] resolve-picks response status=%, body len=%', v_status, length(v_body);
  FOR i IN 1..5 LOOP
    EXIT WHEN (i-1)*400 >= length(v_body);
    RAISE NOTICE 'chunk[%]: %', i, substring(v_body, (i-1)*400+1, 400);
  END LOOP;

  -- Post-trigger state
  SELECT count(*) INTO v_post_pending FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic = false AND game_date >= DATE '2026-05-30';
  RAISE NOTICE '[D-506] post-trigger pending: % (was 15961 → delta=%)',
    v_post_pending, 15961 - v_post_pending;

  -- How many resolved in last 5 minutes?
  SELECT count(*) INTO v_recent_resolved FROM public.pick_history
   WHERE resolved_at >= NOW() - INTERVAL '5 minutes';
  RAISE NOTICE '[D-506] picks resolved in last 5 min: %', v_recent_resolved;
END $$;
