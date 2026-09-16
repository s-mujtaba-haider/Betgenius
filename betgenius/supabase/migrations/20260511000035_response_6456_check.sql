DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT id, status_code, LEFT(content::TEXT, 500) AS body FROM net._http_response WHERE id = 6456 LIMIT 1
  LOOP RAISE NOTICE 'status=% body=%', r.status_code, r.body; END LOOP;
END $$;
