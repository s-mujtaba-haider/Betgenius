-- D-642 — diag v2: actual timing under each role + capture an explain plan.

CREATE OR REPLACE FUNCTION public.d642_perf_query_actual()
RETURNS TABLE (role_name TEXT, rows_returned INT, elapsed_ms INT, error_text TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  start_ts TIMESTAMPTZ;
  rcount INT;
  errt TEXT;
BEGIN
  SET LOCAL statement_timeout = '60s';

  -- as service_role (baseline)
  start_ts := clock_timestamp();
  errt := NULL;
  BEGIN
    SELECT COUNT(*) INTO rcount FROM (
      SELECT id FROM public.pick_history
      WHERE sport = 'mlb' AND recommendation_shown = TRUE
        AND voided = FALSE AND hit IS NOT NULL
      ORDER BY game_date ASC, id ASC LIMIT 1000
    ) t;
  EXCEPTION WHEN OTHERS THEN
    rcount := 0;
    errt := SQLERRM || ' (state=' || SQLSTATE || ')';
  END;
  RETURN QUERY SELECT 'service_role'::TEXT, rcount,
    EXTRACT(MILLISECOND FROM clock_timestamp() - start_ts)::INT + 1000 * EXTRACT(SECOND FROM clock_timestamp() - start_ts)::INT,
    errt;

  -- as authenticated
  start_ts := clock_timestamp();
  errt := NULL;
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT COUNT(*) INTO rcount FROM (
      SELECT id FROM public.pick_history
      WHERE sport = 'mlb' AND recommendation_shown = TRUE
        AND voided = FALSE AND hit IS NOT NULL
      ORDER BY game_date ASC, id ASC LIMIT 1000
    ) t;
  EXCEPTION WHEN OTHERS THEN
    rcount := -1;
    errt := SQLERRM || ' (state=' || SQLSTATE || ')';
  END;
  RESET ROLE;
  RETURN QUERY SELECT 'authenticated'::TEXT, rcount,
    EXTRACT(MILLISECOND FROM clock_timestamp() - start_ts)::INT + 1000 * EXTRACT(SECOND FROM clock_timestamp() - start_ts)::INT,
    errt;

  -- as anon
  start_ts := clock_timestamp();
  errt := NULL;
  SET LOCAL ROLE anon;
  BEGIN
    SELECT COUNT(*) INTO rcount FROM (
      SELECT id FROM public.pick_history
      WHERE sport = 'mlb' AND recommendation_shown = TRUE
        AND voided = FALSE AND hit IS NOT NULL
      ORDER BY game_date ASC, id ASC LIMIT 1000
    ) t;
  EXCEPTION WHEN OTHERS THEN
    rcount := -1;
    errt := SQLERRM || ' (state=' || SQLSTATE || ')';
  END;
  RESET ROLE;
  RETURN QUERY SELECT 'anon'::TEXT, rcount,
    EXTRACT(MILLISECOND FROM clock_timestamp() - start_ts)::INT + 1000 * EXTRACT(SECOND FROM clock_timestamp() - start_ts)::INT,
    errt;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_perf_query_actual() TO service_role;

-- Capture the EXPLAIN as text in a single STRING column.
CREATE OR REPLACE FUNCTION public.d642_perf_explain(p_role TEXT)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  out TEXT := '';
  r RECORD;
BEGIN
  SET LOCAL statement_timeout = '60s';
  IF p_role = 'authenticated' THEN SET LOCAL ROLE authenticated;
  ELSIF p_role = 'anon' THEN SET LOCAL ROLE anon;
  END IF;
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
  RESET ROLE;
  RETURN out;
END $$;
GRANT EXECUTE ON FUNCTION public.d642_perf_explain(TEXT) TO service_role;
