-- D-701c — diagnose resource exhaustion + cut load.
-- All DB-level via direct SQL (REST is 503).

SET statement_timeout = '120s';

-- ===== DIAGNOSE =====
DROP TABLE IF EXISTS d701c_diag;
CREATE TABLE d701c_diag (section text, info text, n bigint);

-- 1. Connection breakdown
INSERT INTO d701c_diag(section, info, n)
SELECT 'conn_total', 'all_connections', count(*) FROM pg_stat_activity;

INSERT INTO d701c_diag(section, info, n)
SELECT 'conn_by_state', state::text, count(*) FROM pg_stat_activity GROUP BY state;

INSERT INTO d701c_diag(section, info, n)
SELECT 'conn_by_app', COALESCE(application_name,'(none)'), count(*)
FROM pg_stat_activity GROUP BY application_name ORDER BY count(*) DESC;

-- 2. Long queries (capture pid for kill targets)
DROP TABLE IF EXISTS d701c_long_queries;
CREATE TABLE d701c_long_queries AS
SELECT pid, application_name, usename, state,
       EXTRACT(EPOCH FROM (NOW() - query_start))::int AS query_sec,
       EXTRACT(EPOCH FROM (NOW() - xact_start))::int AS xact_sec,
       left(coalesce(query, ''), 200) AS q
FROM pg_stat_activity
WHERE state != 'idle' AND query_start IS NOT NULL
  AND NOW() - query_start > INTERVAL '60 seconds'
ORDER BY query_start;

INSERT INTO d701c_diag(section, info, n)
SELECT 'long_queries_count', '>60s active', count(*) FROM d701c_long_queries;

-- 3. Idle in transaction sessions (these hold locks/resources)
INSERT INTO d701c_diag(section, info, n)
SELECT 'idle_in_tx',
       'duration_sec_'||EXTRACT(EPOCH FROM (NOW() - state_change))::int,
       1
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change;

-- 4. Locks
INSERT INTO d701c_diag(section, info, n)
SELECT 'locks_total', 'pg_locks', count(*) FROM pg_locks;

INSERT INTO d701c_diag(section, info, n)
SELECT 'locks_not_granted', 'waiting', count(*) FROM pg_locks WHERE NOT granted;

-- 5. d700 temp tables — how big are they?
INSERT INTO d701c_diag(section, info, n)
SELECT 'd700_table_size',
       relname,
       pg_total_relation_size(c.oid)
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public'
  AND (relname LIKE 'd700_%' OR relname LIKE 'd701_%' OR relname LIKE 'd701b_%')
  AND relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;

-- ===== KILL STUCK QUERIES =====
-- Cancel any non-idle query >60s (except our own session)
DO $$
DECLARE rec record; v_killed int := 0;
BEGIN
  FOR rec IN
    SELECT pid, application_name, state,
           EXTRACT(EPOCH FROM (NOW() - query_start))::int AS sec,
           left(query, 100) AS q
    FROM pg_stat_activity
    WHERE pid != pg_backend_pid()
      AND state != 'idle'
      AND query_start IS NOT NULL
      AND NOW() - query_start > INTERVAL '60 seconds'
  LOOP
    RAISE NOTICE 'CANCEL pid=% app=% state=% sec=% q=%', rec.pid, rec.application_name, rec.state, rec.sec, rec.q;
    PERFORM pg_cancel_backend(rec.pid);
    v_killed := v_killed + 1;
  END LOOP;
  RAISE NOTICE 'D-701c: cancelled % long queries', v_killed;
END $$;

-- Also terminate idle-in-tx sessions >5min — they hold resources
DO $$
DECLARE rec record; v_term int := 0;
BEGIN
  FOR rec IN
    SELECT pid, application_name,
           EXTRACT(EPOCH FROM (NOW() - state_change))::int AS sec
    FROM pg_stat_activity
    WHERE pid != pg_backend_pid()
      AND state = 'idle in transaction'
      AND NOW() - state_change > INTERVAL '5 minutes'
  LOOP
    RAISE NOTICE 'TERMINATE idle-in-tx pid=% app=% sec=%', rec.pid, rec.application_name, rec.sec;
    PERFORM pg_terminate_backend(rec.pid);
    v_term := v_term + 1;
  END LOOP;
  RAISE NOTICE 'D-701c: terminated % idle-in-tx', v_term;
END $$;

-- ===== DROP D-700 DIAG TABLES =====
DROP TABLE IF EXISTS d700_inventory CASCADE;
DROP TABLE IF EXISTS d700_tablespec CASCADE;
DROP TABLE IF EXISTS d700_table_counts CASCADE;
DROP TABLE IF EXISTS d700_coverage CASCADE;
DROP TABLE IF EXISTS d700_join CASCADE;

-- Also drop d701b diag tables (will recreate if needed)
DROP TABLE IF EXISTS d701b_kickoff_log CASCADE;
DROP TABLE IF EXISTS d701b_pause_audit CASCADE;
DROP TABLE IF EXISTS d701b_cron_state CASCADE;

-- ===== ECHO post-kill state =====
DROP TABLE IF EXISTS d701c_postkill;
CREATE TABLE d701c_postkill AS
SELECT pid, application_name, state,
       EXTRACT(EPOCH FROM (NOW() - query_start))::int AS query_sec,
       left(coalesce(query, ''), 150) AS q
FROM pg_stat_activity
WHERE state != 'idle' OR application_name LIKE '%pgrst%' OR application_name LIKE '%PostgREST%'
ORDER BY state, pid;

-- Send pgrst reload after clearing resources
DO $$ BEGIN PERFORM pg_notify('pgrst', 'reload schema'); END $$;

SELECT 'D-701c diagnose+kill+drop complete' AS done;
