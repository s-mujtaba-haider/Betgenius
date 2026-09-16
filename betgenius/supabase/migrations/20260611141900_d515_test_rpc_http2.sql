DO $$
DECLARE v_body TEXT; v_status INT; r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';
  -- Look at the LAST few net._http_response entries to find our RPC test
  RAISE NOTICE '[D-515 test2] last 5 net._http_response entries:';
  FOR r IN
    SELECT id, status_code, created, content_type,
           left(content::text, 200) AS body_head
    FROM net._http_response
    ORDER BY created DESC LIMIT 5
  LOOP RAISE NOTICE '  rid=% status=% at=% ctype=% body=%',
    r.id, r.status_code, r.created, r.content_type, r.body_head; END LOOP;
END $$;
