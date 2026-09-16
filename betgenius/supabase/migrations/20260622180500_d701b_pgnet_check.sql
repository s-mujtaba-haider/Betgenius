DO $$
DECLARE rec record;
BEGIN
  RAISE NOTICE '=== pg_net last 5 min ===';
  FOR rec IN
    SELECT status_code, count(*) AS n
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '5 minutes'
    GROUP BY status_code ORDER BY n DESC
  LOOP
    RAISE NOTICE '  status=% n=%', COALESCE(rec.status_code::text,'pending'), rec.n;
  END LOOP;

  -- Show last 5 individual responses
  RAISE NOTICE '=== last 5 responses ===';
  FOR rec IN
    SELECT id, status_code, created, left(coalesce(content::text,''),120) AS body
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '10 minutes'
    ORDER BY created DESC LIMIT 5
  LOOP
    RAISE NOTICE '  id=% status=% % body=%', rec.id, COALESCE(rec.status_code,0), rec.created::text, rec.body;
  END LOOP;
END $$;
