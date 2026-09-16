DO $$
DECLARE r2 RECORD; v_body TEXT; v_status INT;
BEGIN
  PERFORM pg_sleep(15);
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
   INTO v_body, v_status FROM net._http_response WHERE id = 12869;
  RAISE NOTICE '[D-508] trigger response status=%, body len=%', v_status, length(v_body);
  FOR i IN 1..8 LOOP
    EXIT WHEN (i-1)*400 >= length(v_body);
    RAISE NOTICE 'b[%]: %', i, substring(v_body, (i-1)*400+1, 400);
  END LOOP;

  RAISE NOTICE '[D-508] checkpoints from process-games-mlb in last 5 min:';
  FOR r2 IN
    SELECT created_at, error_type, left(error_message, 250) AS msg
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '5 minutes'
      AND function_name = 'process-games-mlb'
    ORDER BY created_at DESC LIMIT 30
  LOOP RAISE NOTICE '  at=% type=% msg=%', r2.created_at, r2.error_type, r2.msg; END LOOP;
END $$;
