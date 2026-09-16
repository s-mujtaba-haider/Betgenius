DO $$
DECLARE r RECORD; v_body TEXT;
BEGIN
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g') INTO v_body
  FROM net._http_response WHERE id = 12103;
  RAISE NOTICE '[D-506] flattened response body (len=%):', length(v_body);
  -- chunk-print 400 chars at a time
  FOR i IN 1..6 LOOP
    EXIT WHEN (i-1)*400 >= length(v_body);
    RAISE NOTICE 'chunk[%]: %', i, substring(v_body, (i-1)*400+1, 400);
  END LOOP;
END $$;
