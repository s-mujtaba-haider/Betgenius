DO $$
DECLARE r RECORD; v_body TEXT;
BEGIN
  RAISE NOTICE '[D-506 SHIP 3] last 6 function response bodies:';
  FOR r IN
    SELECT id, status_code, created,
           regexp_replace(content::text, E'[\n\r]+', ' ', 'g') AS body
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '30 minutes'
    ORDER BY created DESC LIMIT 6
  LOOP
    RAISE NOTICE '----- rid=% status=% at=% -----', r.id, r.status_code, r.created;
    FOR i IN 1..3 LOOP
      EXIT WHEN (i-1)*400 >= length(r.body);
      RAISE NOTICE '  body[%]: %', i, substring(r.body, (i-1)*400+1, 400);
    END LOOP;
  END LOOP;
END $$;
