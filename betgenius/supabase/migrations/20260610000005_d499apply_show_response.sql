-- D-499-APPLY — show full process-games-mlb response body for SHIP 2 audit.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT status_code, content FROM net._http_response WHERE id = 10223 LOOP
    RAISE NOTICE '[D-499-APPLY response] status=% body=%', r.status_code, r.content;
  END LOOP;
END $$;
