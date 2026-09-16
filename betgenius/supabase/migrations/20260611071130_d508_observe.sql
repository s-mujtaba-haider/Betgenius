-- D-508 SHIP 2 verify, step 3: observe the trigger's response + checkpoints.
DO $$
DECLARE r RECORD; v_body TEXT; v_status INT; v_now BIGINT;
BEGIN
  SET LOCAL statement_timeout TO '300s';
  PERFORM pg_sleep(110);  -- let the function complete (up to 200s budget)

  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
   INTO v_body, v_status FROM net._http_response WHERE id = 12892;
  RAISE NOTICE '[D-508 step3] response status=%', v_status;
  IF v_body IS NOT NULL THEN
    FOR i IN 1..5 LOOP
      EXIT WHEN (i-1)*400 >= length(v_body);
      RAISE NOTICE '  body[%]: %', i, substring(v_body, (i-1)*400+1, 400);
    END LOOP;
  END IF;

  -- D-508 checkpoint
  RAISE NOTICE '[D-508 step3] post_d508_volume_shard checkpoint:';
  FOR r IN
    SELECT created_at, context FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '5 minutes'
      AND function_name = 'process-games-mlb'
      AND error_message = 'post_d508_volume_shard'
    ORDER BY created_at DESC LIMIT 1
  LOOP RAISE NOTICE '  at=% ctx=%', r.created_at, r.context::text; END LOOP;

  -- All checkpoints from this run
  RAISE NOTICE '[D-508 step3] all process-games-mlb checkpoints last 5 min:';
  FOR r IN
    SELECT created_at, error_message,
           context->>'elapsed_ms' AS elapsed_ms,
           context->>'selected_for_this_tick' AS picked
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '5 minutes'
      AND function_name = 'process-games-mlb'
    ORDER BY created_at ASC LIMIT 20
  LOOP RAISE NOTICE '  at=% step=% elapsed_ms=% picked=%',
    r.created_at, r.error_message, r.elapsed_ms, r.picked; END LOOP;

  -- post-trigger mlb_scoring_progress state
  RAISE NOTICE '[D-508 step3] mlb_scoring_progress today after run:';
  FOR r IN SELECT count(*) AS n FROM public.mlb_scoring_progress WHERE game_date='20260611'
  LOOP RAISE NOTICE '  scored=%', r.n; END LOOP;

  -- Any runtime alerts in last 5 min?
  RAISE NOTICE '[D-508 step3] timeout/error alerts last 5 min:';
  FOR r IN
    SELECT created_at, error_type, left(COALESCE(error_message,''), 200) AS msg
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '5 minutes'
      AND function_name = 'process-games-mlb'
      AND error_type NOT IN ('checkpoint')
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% type=% msg=%', r.created_at, r.error_type, r.msg; END LOOP;
END $$;
