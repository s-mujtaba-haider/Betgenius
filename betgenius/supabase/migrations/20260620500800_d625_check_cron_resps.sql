DO $$ DECLARE r RECORD; v_body text; BEGIN
  RAISE NOTICE 'Looking for cron resolve-picks responses (search for "mlb" + "resolved" in body):';
  FOR r IN
    SELECT id, status_code, created,
           regexp_replace(LEFT(COALESCE(content::text,''), 400), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response
     WHERE created >= now() - interval '24 hours'
       AND (content::text ILIKE '%"mlb"%' OR content::text ILIKE '%resolve%' OR content::text ILIKE '%betsUpdated%')
     ORDER BY created DESC LIMIT 20
  LOOP
    RAISE NOTICE '  id=% created=% status=% body=%', r.id, r.created, r.status_code, r.body;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'Responses near 15:00 UTC today (cron resolve-picks-daily):';
  FOR r IN
    SELECT id, status_code, created,
           regexp_replace(LEFT(COALESCE(content::text,''), 400), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response
     WHERE created BETWEEN '2026-06-19 14:59:00+00' AND '2026-06-19 15:35:00+00'
     ORDER BY created LIMIT 20
  LOOP
    RAISE NOTICE '  id=% created=% status=% body=%', r.id, r.created, r.status_code, r.body;
  END LOOP;
END $$;
