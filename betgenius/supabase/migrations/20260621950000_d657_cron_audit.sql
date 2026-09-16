-- D-657 — read-only audit of pg_cron + net._http_response for snapshot/odds/process crons.
-- All in a SECURITY DEFINER RPC so the service-role PostgREST can read pg_cron tables.
CREATE OR REPLACE FUNCTION public.d657_cron_audit()
RETURNS TABLE(section TEXT, k TEXT, v TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout = '120s';

  -- 1. Active MLB cron schedules
  RETURN QUERY
    SELECT 'jobs'::TEXT,
           jobname::TEXT,
           format('schedule=%s  active=%s  command_excerpt=%s',
                  schedule, active, substring(command, 1, 90))
    FROM cron.job
    WHERE jobname LIKE '%mlb%' OR jobname LIKE '%odds%' OR jobname LIKE '%snapshot%'
    ORDER BY jobname;

  -- 2. Most recent 30 invocations of each relevant job (last 3 hours)
  RETURN QUERY
    SELECT 'runs'::TEXT,
           j.jobname::TEXT,
           format('%s start=%s end=%s status=%s ret=%s',
                  to_char(jrd.start_time, 'HH24:MI:SS'),
                  jrd.start_time::TEXT,
                  COALESCE(jrd.end_time::TEXT, 'NULL_END'),
                  COALESCE(jrd.status, 'NULL'),
                  COALESCE(substring(jrd.return_message, 1, 80), 'NULL'))
    FROM cron.job_run_details jrd
    JOIN cron.job j ON j.jobid = jrd.jobid
    WHERE jrd.start_time > NOW() - INTERVAL '3 hours'
      AND (j.jobname LIKE '%snapshot-odds-writer%'
         OR j.jobname LIKE '%fetch-odds-mlb%'
         OR j.jobname LIKE '%process-games-mlb%'
         OR j.jobname LIKE '%lineup-confirmation%')
    ORDER BY jrd.start_time DESC
    LIMIT 60;

  -- 3. Most recent net._http_response per request_id in last 3 hours that point at these fns
  RETURN QUERY
    SELECT 'http'::TEXT,
           SPLIT_PART(SPLIT_PART(SPLIT_PART(jrd.command, '/functions/v1/', 2), '''',1), '?', 1)::TEXT AS fn,
           format('%s status=%s req_id=%s',
                  jrd.start_time::TEXT,
                  COALESCE(jrd.status, '?'),
                  COALESCE(substring(jrd.return_message, 1, 60), '?'))
    FROM cron.job_run_details jrd
    WHERE jrd.start_time > NOW() - INTERVAL '3 hours'
      AND jrd.command LIKE '%functions/v1/snapshot-odds-writer%'
    ORDER BY jrd.start_time DESC
    LIMIT 10;

  -- 4. props_cache last_seen — heartbeat that fetch-odds-mlb is writing
  RETURN QUERY
    SELECT 'props_cache'::TEXT,
           'max_last_seen'::TEXT,
           (SELECT MAX(last_seen)::TEXT FROM props_cache WHERE sport='mlb');

  -- 5. Count fetch-odds inserts (props_cache last_seen) in last 3h, bucketed 30-min
  RETURN QUERY
    SELECT 'props_cache_buckets'::TEXT,
           to_char(date_trunc('hour', last_seen) + INTERVAL '30 min' * (EXTRACT(MINUTE FROM last_seen)::int / 30), 'YYYY-MM-DD HH24:MI'),
           COUNT(*)::TEXT
    FROM props_cache
    WHERE sport='mlb' AND last_seen > NOW() - INTERVAL '3 hours'
    GROUP BY 1, 2
    ORDER BY 2;

  -- 6. cache_odds_snapshots same — bucketed 30-min over last 3h
  RETURN QUERY
    SELECT 'snapshots_buckets'::TEXT,
           to_char(date_trunc('hour', snapshot_time) + INTERVAL '30 min' * (EXTRACT(MINUTE FROM snapshot_time)::int / 30), 'YYYY-MM-DD HH24:MI'),
           COUNT(*)::TEXT
    FROM cache_odds_snapshots
    WHERE snapshot_time > NOW() - INTERVAL '3 hours'
    GROUP BY 1, 2
    ORDER BY 2;

  -- 7. recent net._http_response status codes for these fn URLs (last 3h)
  RETURN QUERY
    SELECT 'http_resp'::TEXT,
           COALESCE(r.status_code::TEXT, 'no_resp') || ' ' || COALESCE(substring(SPLIT_PART(jrd.command, '/functions/v1/', 2), 1, 30), '?'),
           format('%s err=%s', r.created::TEXT, COALESCE(substring(r.error_msg, 1, 60), '-'))
    FROM cron.job_run_details jrd
    LEFT JOIN net._http_response r ON r.id = (jrd.return_message::JSONB ->> 'request_id')::BIGINT
    WHERE jrd.start_time > NOW() - INTERVAL '3 hours'
      AND (jrd.command LIKE '%snapshot-odds-writer%' OR jrd.command LIKE '%fetch-odds-mlb%')
    ORDER BY jrd.start_time DESC
    LIMIT 20;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_cron_audit() TO service_role;
