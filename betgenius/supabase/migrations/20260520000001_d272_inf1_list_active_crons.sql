-- D-272-INF-1 (2026-05-20) — list_active_crons() RPC.
--
-- Closes D-239 / D-265 observability gap: there was no admin-safe way
-- to enumerate active pg_cron jobs + recent run details without direct
-- access to the cron schema (which is service-role-only and not
-- exposed via PostgREST).
--
-- SECURITY DEFINER so the function runs with the migration creator's
-- privileges (postgres role inside Supabase), which can read cron.*.
-- EXECUTE is restricted to service_role; anon and authenticated are
-- REVOKE'd. Edge functions reach this via the service-role key.
--
-- Returns one row per scheduled cron job with:
--   jobid                   — pg_cron primary key
--   jobname                 — human-readable name (NULL if anonymous)
--   schedule                — cron expression
--   active                  — pg_cron.job.active
--   last_run_started_at     — most recent run start (NULL if never run)
--   last_run_status         — succeeded / failed / running / sending /
--                             starting (per cron.job_run_details)
--   last_run_duration_ms    — end - start in milliseconds (NULL if not
--                             finished yet)
--   consecutive_failures    — count of trailing failed runs since last
--                             succeeded run (0 if last run succeeded)
--
-- Rollback:
--   DROP FUNCTION public.list_active_crons();

CREATE OR REPLACE FUNCTION public.list_active_crons()
RETURNS TABLE (
  jobid                 bigint,
  jobname               text,
  schedule              text,
  active                boolean,
  last_run_started_at   timestamptz,
  last_run_status       text,
  last_run_duration_ms  integer,
  consecutive_failures  integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = cron, public, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  WITH latest_run AS (
    SELECT DISTINCT ON (jrd.jobid)
      jrd.jobid,
      jrd.start_time,
      jrd.status,
      CASE
        WHEN jrd.end_time IS NULL OR jrd.start_time IS NULL THEN NULL
        ELSE EXTRACT(MILLISECOND FROM (jrd.end_time - jrd.start_time))::integer
             + (EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time))::integer * 1000)
             - (EXTRACT(MILLISECOND FROM (jrd.end_time - jrd.start_time))::integer)
      END AS duration_ms,
      EXTRACT(EPOCH FROM (jrd.end_time - jrd.start_time)) * 1000 AS duration_secs_ms
    FROM cron.job_run_details jrd
    ORDER BY jrd.jobid, jrd.start_time DESC
  ),
  failure_streak AS (
    SELECT
      j.jobid,
      COALESCE((
        SELECT COUNT(*)::integer
        FROM cron.job_run_details f
        WHERE f.jobid = j.jobid
          AND f.start_time > COALESCE((
            SELECT MAX(s.start_time)
            FROM cron.job_run_details s
            WHERE s.jobid = j.jobid AND s.status = 'succeeded'
          ), '-infinity'::timestamptz)
          AND f.status = 'failed'
      ), 0) AS streak
    FROM cron.job j
  )
  SELECT
    j.jobid,
    j.jobname::text,
    j.schedule::text,
    j.active,
    lr.start_time AS last_run_started_at,
    lr.status::text AS last_run_status,
    -- Use EXTRACT EPOCH for ms — cleaner than nested calls.
    CASE
      WHEN lr.start_time IS NULL THEN NULL
      ELSE (EXTRACT(EPOCH FROM (
        (SELECT end_time FROM cron.job_run_details
         WHERE jobid = j.jobid AND start_time = lr.start_time LIMIT 1)
        - lr.start_time
      )) * 1000)::integer
    END AS last_run_duration_ms,
    COALESCE(fs.streak, 0) AS consecutive_failures
  FROM cron.job j
  LEFT JOIN latest_run lr ON lr.jobid = j.jobid
  LEFT JOIN failure_streak fs ON fs.jobid = j.jobid
  ORDER BY j.jobid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.list_active_crons() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_active_crons() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_active_crons() TO service_role;

COMMENT ON FUNCTION public.list_active_crons() IS
  'D-272-INF-1: admin-only enumeration of pg_cron jobs + recent run '
  'details. SECURITY DEFINER + service_role-only EXECUTE. Closes the '
  'D-239 / D-265 observability gap (no admin-safe cron enumeration '
  'path existed before). Caller: edge functions with the service-role '
  'key. Rollback: DROP FUNCTION public.list_active_crons().';
