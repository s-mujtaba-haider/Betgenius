DO $$
DECLARE r RECORD; v_body TEXT; v_status INT;
BEGIN
  PERFORM pg_sleep(10);
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
    INTO v_body, v_status FROM net._http_response WHERE id = 12879;
  RAISE NOTICE '[D-508] status=% body=%', v_status, substring(v_body, 1, 400);
  FOR r IN
    SELECT created_at, error_message, context
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '5 minutes'
      AND function_name = 'process-games-mlb'
      AND error_type = 'checkpoint'
      AND error_message = 'post_d508_volume_shard'
    ORDER BY created_at DESC LIMIT 1
  LOOP RAISE NOTICE '  checkpoint context=%', r.context; END LOOP;
END $$;
