-- D-612 — full cron schedule inventory. READ-ONLY.
--
-- Surfaces:
--   §A — every active job in cron.job (name, schedule, command excerpt)
--   §B — last run + status per job (cron.job_run_details, last 7d)
--   §C — recent-run frequency per job (last 24h) → catches stale crons
--   §D — overlapping schedules (same-minute fires) → contention candidates
--
-- All four parts run in one DO block; output via RAISE NOTICE.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-612 — cron schedule inventory';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  --
  -- §A — every active job in cron.job
  --
  RAISE NOTICE '';
  RAISE NOTICE '[A] cron.job (active=true), ordered by schedule:';
  RAISE NOTICE '  jobid | jobname | schedule | active | command-excerpt';
  FOR r IN
    SELECT jobid, jobname, schedule, active, LEFT(command, 200) AS cmd_excerpt
      FROM cron.job
     WHERE active = true
     ORDER BY jobname
  LOOP
    RAISE NOTICE '  jobid=% name=% schedule=% active=% cmd=%',
      r.jobid, r.jobname, r.schedule, r.active, r.cmd_excerpt;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[A.disabled] cron.job (active=false), if any:';
  FOR r IN
    SELECT jobid, jobname, schedule
      FROM cron.job
     WHERE active = false
     ORDER BY jobname
  LOOP
    RAISE NOTICE '  jobid=% name=% schedule=%', r.jobid, r.jobname, r.schedule;
  END LOOP;

  --
  -- §B — last 3 runs per job from cron.job_run_details (last 7d window)
  --
  RAISE NOTICE '';
  RAISE NOTICE '[B] last 3 runs per job (cron.job_run_details, 7d):';
  FOR r IN
    SELECT
      j.jobname,
      d.start_time,
      d.end_time,
      d.status,
      LEFT(COALESCE(d.return_message,''), 100) AS msg_excerpt
    FROM cron.job j
    LEFT JOIN LATERAL (
      SELECT * FROM cron.job_run_details rd
       WHERE rd.jobid = j.jobid
         AND rd.start_time >= (now() - interval '7 days')
       ORDER BY rd.start_time DESC LIMIT 3
    ) d ON true
    WHERE j.active = true
    ORDER BY j.jobname, d.start_time DESC NULLS LAST
  LOOP
    RAISE NOTICE '  job=% start=% end=% status=% msg=%',
      r.jobname,
      r.start_time,
      r.end_time,
      COALESCE(r.status, '(NEVER RUN in 7d)'),
      r.msg_excerpt;
  END LOOP;

  --
  -- §C — per-job run counts last 24h vs cron expression cadence
  --
  RAISE NOTICE '';
  RAISE NOTICE '[C] run counts last 24h per active job (catches stale/failing):';
  FOR r IN
    SELECT
      j.jobname,
      j.schedule,
      count(d.runid) AS n_runs_24h,
      count(d.runid) FILTER (WHERE d.status = 'succeeded') AS n_ok,
      count(d.runid) FILTER (WHERE d.status = 'failed') AS n_fail,
      max(d.start_time) AS latest
    FROM cron.job j
    LEFT JOIN cron.job_run_details d
      ON d.jobid = j.jobid
     AND d.start_time >= (now() - interval '24 hours')
    WHERE j.active = true
    GROUP BY j.jobname, j.schedule
    ORDER BY j.jobname
  LOOP
    RAISE NOTICE '  job=% schedule=% n_24h=% ok=% fail=% latest=%',
      r.jobname, r.schedule, r.n_runs_24h, r.n_ok, r.n_fail, r.latest;
  END LOOP;

  --
  -- §D — minute-collision detector: jobs sharing the same schedule minute
  -- across the hour (rough overlap heuristic for hourly+ crons)
  --
  RAISE NOTICE '';
  RAISE NOTICE '[D] schedule-text grouping (exact match = stacking on same fire):';
  FOR r IN
    SELECT schedule, count(*) AS n_jobs, string_agg(jobname, ' / ') AS jobs
      FROM cron.job
     WHERE active = true
     GROUP BY schedule
     ORDER BY count(*) DESC, schedule
  LOOP
    RAISE NOTICE '  schedule=`%` n_jobs=% jobs=%', r.schedule, r.n_jobs, r.jobs;
  END LOOP;

  --
  -- §E — total counts
  --
  RAISE NOTICE '';
  RAISE NOTICE '[E] summary counts:';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE active = true) AS active_jobs,
      count(*) FILTER (WHERE active = false) AS inactive_jobs,
      count(*) AS total_jobs
      FROM cron.job
  LOOP
    RAISE NOTICE '  active=% inactive=% total=%', r.active_jobs, r.inactive_jobs, r.total_jobs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'D-612 inventory complete.';
END $$;
