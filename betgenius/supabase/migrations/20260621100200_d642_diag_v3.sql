-- D-642 — diag v3: drop the role-switching attempt; instead read
-- pg_stat_statements for the slow / failing pick_history queries.

DROP FUNCTION IF EXISTS public.d642_perf_query_actual();
DROP FUNCTION IF EXISTS public.d642_perf_explain(TEXT);

CREATE OR REPLACE FUNCTION public.d642_slow_queries()
RETURNS TABLE (
  calls       BIGINT,
  total_ms    NUMERIC,
  mean_ms     NUMERIC,
  max_ms      NUMERIC,
  rows_avg    NUMERIC,
  query_snip  TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '60s';
  RETURN QUERY
  SELECT pss.calls,
         ROUND(pss.total_exec_time::NUMERIC, 1) AS total_ms,
         ROUND(pss.mean_exec_time::NUMERIC, 1)  AS mean_ms,
         ROUND(pss.max_exec_time::NUMERIC, 1)   AS max_ms,
         ROUND((pss.rows::NUMERIC / GREATEST(pss.calls,1)), 1) AS rows_avg,
         LEFT(REGEXP_REPLACE(pss.query, '\s+', ' ', 'g'), 320) AS query_snip
  FROM pg_stat_statements pss
  WHERE pss.query ILIKE '%pick_history%'
  ORDER BY pss.mean_exec_time DESC NULLS LAST
  LIMIT 25;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_slow_queries() TO service_role;

-- The simpler diagnostic: run the Performance query as service_role
-- and time it (gives a baseline) + EXPLAIN.
CREATE OR REPLACE FUNCTION public.d642_perf_explain_simple()
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  out TEXT := '';
  r RECORD;
BEGIN
  SET LOCAL statement_timeout = '60s';
  FOR r IN
    EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, VERBOSE FALSE)
    SELECT id, game_date, hit, odds, prop_type, pick_side
    FROM public.pick_history
    WHERE sport = 'mlb' AND recommendation_shown = TRUE
      AND voided = FALSE AND hit IS NOT NULL
    ORDER BY game_date ASC, id ASC LIMIT 1000
  LOOP
    out := out || r."QUERY PLAN" || E'\n';
  END LOOP;
  RETURN out;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_perf_explain_simple() TO service_role;

-- Recent errors / longest queries seen at REST layer might be visible
-- in pg_stat_activity (currently running). Snapshot it.
CREATE OR REPLACE FUNCTION public.d642_active_queries()
RETURNS TABLE (
  pid         INT,
  state       TEXT,
  wait_event  TEXT,
  duration_s  NUMERIC,
  app_name    TEXT,
  usename     TEXT,
  query_snip  TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '15s';
  RETURN QUERY
  SELECT a.pid,
         a.state::TEXT,
         a.wait_event::TEXT,
         ROUND(EXTRACT(EPOCH FROM (NOW() - a.query_start))::NUMERIC, 1) AS duration_s,
         a.application_name::TEXT,
         a.usename::TEXT,
         LEFT(REGEXP_REPLACE(a.query, '\s+', ' ', 'g'), 250) AS query_snip
  FROM pg_stat_activity a
  WHERE a.query ILIKE '%pick_history%'
    AND a.pid <> pg_backend_pid()
  ORDER BY a.query_start NULLS LAST;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_active_queries() TO service_role;
