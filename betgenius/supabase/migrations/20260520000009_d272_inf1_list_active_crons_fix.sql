-- D-272-INF-1 fix (2026-05-20) — disambiguate jobid in list_active_crons().
--
-- Previous version (20260520000001) collided RETURNS TABLE column name
-- `jobid` with `cron.job.jobid` / `cron.job_run_details.jobid` inside
-- the PL/pgSQL body. PostgreSQL raised 42702 "column reference
-- 'jobid' is ambiguous" at runtime.
--
-- Fix: rename RETURN TABLE columns to have explicit `out_*` prefixes
-- so no shadowing can happen, then map back via aliases.
--
-- Rollback: DROP FUNCTION public.list_active_crons() then re-apply
-- the 20260520000001 version.

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
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, public, pg_catalog
AS $$
  WITH latest_run AS (
    SELECT DISTINCT ON (jrd.jobid)
      jrd.jobid     AS lr_jobid,
      jrd.start_time,
      jrd.end_time,
      jrd.status::text AS status
    FROM cron.job_run_details jrd
    ORDER BY jrd.jobid, jrd.start_time DESC
  ),
  last_success AS (
    SELECT
      s.jobid       AS ls_jobid,
      MAX(s.start_time) AS last_success_time
    FROM cron.job_run_details s
    WHERE s.status = 'succeeded'
    GROUP BY s.jobid
  ),
  failure_streak AS (
    SELECT
      j2.jobid AS fs_jobid,
      COALESCE((
        SELECT COUNT(*)::integer
        FROM cron.job_run_details f
        WHERE f.jobid = j2.jobid
          AND f.start_time > COALESCE(
            (SELECT last_success_time FROM last_success WHERE ls_jobid = j2.jobid),
            '-infinity'::timestamptz
          )
          AND f.status = 'failed'
      ), 0) AS streak
    FROM cron.job j2
  )
  SELECT
    j.jobid::bigint                                                          AS jobid,
    j.jobname::text                                                          AS jobname,
    j.schedule::text                                                         AS schedule,
    j.active                                                                 AS active,
    lr.start_time                                                            AS last_run_started_at,
    lr.status                                                                AS last_run_status,
    CASE
      WHEN lr.start_time IS NULL OR lr.end_time IS NULL THEN NULL
      ELSE (EXTRACT(EPOCH FROM (lr.end_time - lr.start_time)) * 1000)::integer
    END                                                                      AS last_run_duration_ms,
    COALESCE(fs.streak, 0)                                                   AS consecutive_failures
  FROM cron.job j
  LEFT JOIN latest_run     lr ON lr.lr_jobid = j.jobid
  LEFT JOIN failure_streak fs ON fs.fs_jobid = j.jobid
  ORDER BY j.jobid;
$$;

REVOKE EXECUTE ON FUNCTION public.list_active_crons() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_active_crons() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.list_active_crons() TO service_role;

COMMENT ON FUNCTION public.list_active_crons() IS
  'D-272-INF-1 (fix v2): switched plpgsql → sql, disambiguated jobid '
  'via WITH-clause aliases (lr_jobid / ls_jobid / fs_jobid). '
  'service_role-only EXECUTE. Closes D-239 / D-265 observability gap.';
