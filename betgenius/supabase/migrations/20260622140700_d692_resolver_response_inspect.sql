DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '──── resolver full response (most recent drain) ────';
  FOR r IN
    SELECT id, status_code, created, content::TEXT AS full_body
    FROM net._http_response
    WHERE created >= NOW() - INTERVAL '5 minutes'
    ORDER BY created DESC LIMIT 1
  LOOP
    RAISE NOTICE 'resp id=% status=%', r.id, r.status_code;
    RAISE NOTICE 'BODY (full): %', r.full_body;
  END LOOP;
END $$;
