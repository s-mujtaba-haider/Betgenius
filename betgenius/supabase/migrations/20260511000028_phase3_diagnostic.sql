-- Diagnose why Phase 3 backfill produced identical output to Phase 2.

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== net.http_post 6453 (Phase 3 invoke) response ===';
  FOR r IN
    SELECT id, status_code, LEFT(content::TEXT, 700) AS body
    FROM net._http_response WHERE id = 6453 LIMIT 1
  LOOP
    RAISE NOTICE 'status=% body=%', r.status_code, r.body;
  END LOOP;
END $$;
