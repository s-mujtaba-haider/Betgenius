DO $$
DECLARE v_body TEXT;
BEGIN
  PERFORM pg_sleep(8);
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g') INTO v_body
  FROM net._http_response WHERE id = 12110;
  RAISE NOTICE '[D-506] post-index diagnose response (len=%):', length(v_body);
  FOR i IN 1..6 LOOP
    EXIT WHEN (i-1)*400 >= length(v_body);
    RAISE NOTICE 'chunk[%]: %', i, substring(v_body, (i-1)*400+1, 400);
  END LOOP;
END $$;
