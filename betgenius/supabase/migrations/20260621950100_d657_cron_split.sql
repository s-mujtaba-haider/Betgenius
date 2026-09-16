-- D-657 — split the heavy audit into smaller RPCs to dodge the 8s PostgREST timeout.
CREATE OR REPLACE FUNCTION public.d657_jobs()
RETURNS TABLE(jobname TEXT, schedule TEXT, active BOOLEAN, command_excerpt TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '20s';
  RETURN QUERY
    SELECT j.jobname::TEXT, j.schedule::TEXT, j.active, substring(j.command, 1, 110)::TEXT
    FROM cron.job j
    WHERE j.jobname ILIKE '%mlb%' OR j.jobname ILIKE '%odds%' OR j.jobname ILIKE '%snapshot%' OR j.jobname ILIKE '%lineup%' OR j.jobname ILIKE '%process-games%'
    ORDER BY j.jobname;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_jobs() TO service_role;

CREATE OR REPLACE FUNCTION public.d657_runs(p_pattern TEXT, p_hours INT)
RETURNS TABLE(jobname TEXT, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, status TEXT, return_message TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '20s';
  RETURN QUERY
    SELECT j.jobname::TEXT, jrd.start_time, jrd.end_time, jrd.status::TEXT, substring(jrd.return_message, 1, 200)::TEXT
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE j.jobname ILIKE p_pattern
      AND jrd.start_time > NOW() - (p_hours || ' hours')::INTERVAL
    ORDER BY jrd.start_time DESC
    LIMIT 50;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_runs(TEXT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.d657_props_cache_heartbeat()
RETURNS TABLE(bucket TEXT, n BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '20s';
  RETURN QUERY
    SELECT to_char(date_trunc('hour', last_seen) + INTERVAL '30 min' * (EXTRACT(MINUTE FROM last_seen)::int / 30), 'YYYY-MM-DD HH24:MI')::TEXT,
           COUNT(*)::BIGINT
    FROM props_cache
    WHERE sport='mlb' AND last_seen > NOW() - INTERVAL '4 hours'
    GROUP BY 1
    ORDER BY 1 DESC;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_props_cache_heartbeat() TO service_role;

CREATE OR REPLACE FUNCTION public.d657_snapshots_heartbeat()
RETURNS TABLE(bucket TEXT, n BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '20s';
  RETURN QUERY
    SELECT to_char(date_trunc('hour', snapshot_time) + INTERVAL '30 min' * (EXTRACT(MINUTE FROM snapshot_time)::int / 30), 'YYYY-MM-DD HH24:MI')::TEXT,
           COUNT(*)::BIGINT
    FROM cache_odds_snapshots
    WHERE snapshot_time > NOW() - INTERVAL '4 hours'
    GROUP BY 1
    ORDER BY 1 DESC;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_snapshots_heartbeat() TO service_role;
