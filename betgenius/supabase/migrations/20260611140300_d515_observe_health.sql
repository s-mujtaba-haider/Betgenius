DO $$
DECLARE r RECORD; v_body TEXT; v_status INT;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
   INTO v_body, v_status FROM net._http_response WHERE id=13978;
  RAISE NOTICE '[D-515 verify] status=%', v_status;
  IF v_body IS NOT NULL THEN
    FOR i IN 1..10 LOOP
      EXIT WHEN (i-1)*400 >= length(v_body);
      RAISE NOTICE 'body[%]: %', i, substring(v_body, (i-1)*400+1, 400);
    END LOOP;
  END IF;

  -- Also pull the 11 fresh health_status rows
  RAISE NOTICE '[D-515 verify] fresh health_status rows (last 3 min):';
  FOR r IN
    SELECT check_name, status, left(detail, 250) AS detail
    FROM public.health_status
    WHERE created_at > NOW() - INTERVAL '3 minutes'
    ORDER BY check_name
  LOOP RAISE NOTICE '  check=% status=% detail=%', r.check_name, r.status, r.detail; END LOOP;
END $$;
