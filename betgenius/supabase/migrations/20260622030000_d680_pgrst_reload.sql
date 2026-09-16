-- D-680 — recover PostgREST from PGRST002 "schema cache" outage.
-- The project's PostgREST process returned 503 PGRST002 on every table
-- (subscriptions, user_preferences, pick_history, algorithm_weights, etc.),
-- which the browser surfaces as "access control" / CORS errors because
-- 503 responses are missing Access-Control-Allow-Origin headers.
--
-- The standard cure is NOTIFY pgrst, 'reload schema' which PostgREST listens
-- for and reloads its schema view from pg_catalog. Wrap in DO block to make
-- migration re-runnable safely.
DO $$
BEGIN
  PERFORM pg_notify('pgrst', 'reload schema');
  PERFORM pg_notify('pgrst', 'reload config');
END
$$;
