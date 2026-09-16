DO $$
DECLARE v_body TEXT;
BEGIN
  SET LOCAL statement_timeout TO '180s';
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g')
    INTO v_body FROM net._http_response WHERE id = 13993;
  IF v_body IS NOT NULL THEN
    FOR i IN 1..14 LOOP
      EXIT WHEN (i-1)*400 >= length(v_body);
      RAISE NOTICE 'body[%]: %', i, substring(v_body, (i-1)*400+1, 400);
    END LOOP;
  END IF;
END $$;
