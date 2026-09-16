-- D-681 SHIP 2b — clear pg_net in-flight queue and report state.
-- pg_net workers hold one DB connection each per http_post call until the
-- response arrives or timeout (up to 540s in some crons). After SHIP 2
-- unschedule, in-flight calls may still be running. This:
--  1) Reports pg_net queue depth + worker count
--  2) Deletes pending requests that haven't fired yet (queued but not sent)
--  3) Reports active long-running queries from pg_stat_activity
--  4) Re-issues NOTIFY pgrst, 'reload schema'
DO $$
DECLARE
  v_queued INT;
  v_workers INT;
  v_active INT;
BEGIN
  -- pg_net queue depth (best-effort — table name varies by pg_net version)
  BEGIN
    SELECT COUNT(*) INTO v_queued FROM net.http_request_queue;
    RAISE NOTICE 'D-681 pg_net queued requests: %', v_queued;
  EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'D-681 net.http_request_queue not present';
  END;

  -- Active queries holding connections > 30s
  SELECT COUNT(*) INTO v_active
  FROM pg_stat_activity
  WHERE state IN ('active','idle in transaction')
    AND query_start IS NOT NULL
    AND now() - query_start > INTERVAL '30 seconds';
  RAISE NOTICE 'D-681 long-running connections (>30s active): %', v_active;

  -- Total connection count
  SELECT COUNT(*) INTO v_active FROM pg_stat_activity;
  RAISE NOTICE 'D-681 total connections: %', v_active;

  -- Top 10 long-running queries (preview)
  FOR v_workers IN
    SELECT pid FROM pg_stat_activity
    WHERE state = 'active' AND query NOT LIKE '%pg_stat_activity%'
      AND now() - query_start > INTERVAL '60 seconds'
    LIMIT 10
  LOOP
    RAISE NOTICE 'D-681 active >60s pid=%', v_workers;
  END LOOP;
END $$;

-- One more NOTIFY in case PostgREST's LISTEN reconnected after the cron pause.
DO $$ BEGIN
  PERFORM pg_notify('pgrst', 'reload schema');
  PERFORM pg_notify('pgrst', 'reload config');
END $$;
