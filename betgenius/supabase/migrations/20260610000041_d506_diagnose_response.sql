DO $$
DECLARE r RECORD;
BEGIN
  PERFORM pg_sleep(8);
  RAISE NOTICE '[D-506] diagnose response (request_id=12103):';
  FOR r IN
    SELECT id, status_code, content_type, length(content::text) AS blen,
           substring(content::text, 1, 2000) AS body_head
    FROM net._http_response WHERE id = 12103
  LOOP
    RAISE NOTICE '  status=% ctype=% blen=%', r.status_code, r.content_type, r.blen;
    RAISE NOTICE '  body[0..2000]=%', r.body_head;
  END LOOP;
END $$;
