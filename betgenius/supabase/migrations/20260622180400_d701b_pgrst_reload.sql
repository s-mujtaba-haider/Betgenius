-- D-701b — reload PostgREST schema cache. Same play as D-680 SHIP 4 (pg_notify('pgrst','reload schema')).
-- PGRST002 indicates PostgREST can't query DB for schema; a notify reload kick is the canonical fix.

DO $$
BEGIN
  RAISE NOTICE 'D-701b sending pgrst reload notifications...';
  PERFORM pg_notify('pgrst', 'reload schema');
  PERFORM pg_notify('pgrst', 'reload config');
  RAISE NOTICE 'D-701b: pg_notify dispatched';
END $$;

-- Verify by inspecting recent net._http_response for any 200s from edge functions in next few seconds
-- Note: this won't fire any new requests; just logs state
SELECT 'pg_notify dispatched; PostgREST will reload async (typically <5s)' AS done;
