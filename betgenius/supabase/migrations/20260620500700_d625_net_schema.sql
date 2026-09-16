DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'Tables in net schema:';
  FOR r IN SELECT table_name FROM information_schema.tables WHERE table_schema='net' LOOP
    RAISE NOTICE '  %', r.table_name;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Recent net._http_response (last 24h, all):';
  FOR r IN
    SELECT id, status_code, LEFT(COALESCE(content::text,''), 300) AS body, created
      FROM net._http_response
     WHERE created >= now() - interval '24 hours'
     ORDER BY created DESC LIMIT 30
  LOOP
    RAISE NOTICE '  id=% status=% created=% body=%',
      r.id, r.status_code, r.created, LEFT(r.body, 100);
  END LOOP;
END $$;
