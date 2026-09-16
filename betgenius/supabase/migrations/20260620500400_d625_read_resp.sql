DO $$ DECLARE r RECORD; BEGIN
  -- Read the previous response
  FOR r IN
    SELECT id, status_code, LEFT(content::text, 2500) AS body, created
      FROM net._http_response
     WHERE id = 30546
  LOOP
    RAISE NOTICE '[resp 30546] status=%', r.status_code;
    RAISE NOTICE '  body=%', r.body;
  END LOOP;
END $$;
