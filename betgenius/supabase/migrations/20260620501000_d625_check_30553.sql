DO $$ DECLARE r RECORD; BEGIN
  PERFORM pg_sleep(30);
  FOR r IN SELECT id, status_code, regexp_replace(LEFT(COALESCE(content::text,''),800), E'[\\n\\r]+', ' ', 'g') AS body, created FROM net._http_response WHERE id = 30553 LOOP
    RAISE NOTICE 'resp 30553 status=% created=% body=%', r.status_code, r.created, r.body;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE 'resp 30553 NOT YET — still in-flight'; END IF;
END $$;
