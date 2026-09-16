DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  -- §1 error_log: error_type counts last 48h
  RAISE NOTICE '[D-DAILY §1] error_log error_type counts last 48h:';
  FOR r IN
    SELECT error_type, count(*) AS n,
           max(created_at) AS last_at
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '48 hours'
    GROUP BY error_type ORDER BY n DESC
  LOOP RAISE NOTICE '  type=% n=% last_at=%',
    COALESCE(r.error_type, '<null>'), r.n, r.last_at; END LOOP;

  -- §2 health_status warn/fail last 48h
  RAISE NOTICE '[D-DAILY §2] health_status warn/fail last 48h:';
  FOR r IN
    SELECT check_name, status, count(*) AS n, max(created_at) AS last_at,
           left(max(detail), 250) AS last_detail
    FROM public.health_status
    WHERE status IN ('warn','fail') AND created_at > NOW() - INTERVAL '48 hours'
    GROUP BY check_name, status ORDER BY n DESC
  LOOP RAISE NOTICE '  check=% status=% n=% last_at=% detail=%',
    r.check_name, r.status, r.n, r.last_at, r.last_detail; END LOOP;

  -- §3 cron failures last 48h
  RAISE NOTICE '[D-DAILY §3] cron job run summary last 48h:';
  FOR r IN
    SELECT j.jobname, jrd.status, count(*) AS n, max(jrd.start_time) AS last_at
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE jrd.start_time > NOW() - INTERVAL '48 hours'
    GROUP BY j.jobname, jrd.status ORDER BY jrd.status DESC, n DESC
  LOOP RAISE NOTICE '  job=% status=% n=% last_at=%',
    r.jobname, r.status, r.n, r.last_at; END LOOP;

  -- §3b — explicit any-failed list (named)
  RAISE NOTICE '[D-DAILY §3b] failed cron runs last 48h (named):';
  FOR r IN
    SELECT j.jobname, jrd.start_time, jrd.status,
           left(COALESCE(jrd.return_message,''), 300) AS msg
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE jrd.start_time > NOW() - INTERVAL '48 hours' AND jrd.status='failed'
    ORDER BY jrd.start_time DESC LIMIT 20
  LOOP RAISE NOTICE '  job=% at=% msg=%', r.jobname, r.start_time, r.msg; END LOOP;

  -- §4 succeeded-but-idle: resolved >0/day
  RAISE NOTICE '[D-DAILY §4a] picks resolved per day (last 3 days):';
  FOR r IN
    SELECT (resolved_at AT TIME ZONE 'America/New_York')::DATE AS day_et,
           count(*) AS n_resolved
    FROM public.pick_history
    WHERE resolved_at > NOW() - INTERVAL '3 days' AND is_synthetic=false
    GROUP BY day_et ORDER BY day_et DESC
  LOOP RAISE NOTICE '  day_ET=% resolved=%', r.day_et, r.n_resolved; END LOOP;

  RAISE NOTICE '[D-DAILY §4b] props_cache writes per day (last 3 days):';
  FOR r IN
    SELECT (last_seen AT TIME ZONE 'America/New_York')::DATE AS day_et, count(*) AS n
    FROM public.props_cache
    WHERE last_seen > NOW() - INTERVAL '3 days' AND sport='mlb'
    GROUP BY day_et ORDER BY day_et DESC
  LOOP RAISE NOTICE '  day_ET=% mlb_props=%', r.day_et, r.n; END LOOP;

  RAISE NOTICE '[D-DAILY §4c] CLV stamps per day (last 3 days):';
  FOR r IN
    SELECT (closing_captured_at AT TIME ZONE 'America/New_York')::DATE AS day_et, count(*) AS n
    FROM public.pick_history
    WHERE closing_captured_at > NOW() - INTERVAL '3 days' AND sport='mlb' AND is_synthetic=false
    GROUP BY day_et ORDER BY day_et DESC
  LOOP RAISE NOTICE '  day_ET=% stamps=%', r.day_et, r.n; END LOOP;

  RAISE NOTICE '[D-DAILY §4d] mlb_scoring_progress markers per game_date (last 3 days):';
  FOR r IN
    SELECT game_date, count(*) AS markers, max(scored_at) AS last_marked
    FROM public.mlb_scoring_progress
    WHERE scored_at > NOW() - INTERVAL '3 days'
       OR game_date IN (
         to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD'),
         to_char((NOW() AT TIME ZONE 'America/New_York')::DATE - 1, 'YYYYMMDD'),
         to_char((NOW() AT TIME ZONE 'America/New_York')::DATE - 2, 'YYYYMMDD')
       )
    GROUP BY game_date ORDER BY game_date DESC
  LOOP RAISE NOTICE '  gd=% markers=% last=%', r.game_date, r.markers, r.last_marked; END LOOP;

  -- §5 freshness
  RAISE NOTICE '[D-DAILY §5a] rec_cache max created_at:';
  FOR r IN
    SELECT sport, max(created_at) AS max_created, count(*) AS n_today
    FROM public.recommendations_cache
    WHERE created_at > (NOW() AT TIME ZONE 'America/New_York')::DATE
    GROUP BY sport ORDER BY sport
  LOOP RAISE NOTICE '  sport=% max_created=% n_today=%',
    r.sport, r.max_created, r.n_today; END LOOP;

  RAISE NOTICE '[D-DAILY §5b] pick_history_real max(game_date):';
  FOR r IN
    SELECT max(game_date) AS max_gd, count(*) AS total
    FROM public.pick_history_real WHERE is_synthetic=false
  LOOP RAISE NOTICE '  max_gd=% total=%', r.max_gd, r.total; END LOOP;

  RAISE NOTICE '[D-DAILY §5c] today scored vs schedule:';
  FOR r IN
    SELECT
      to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD') AS today_gd,
      (SELECT count(*) FROM public.mlb_scoring_progress
        WHERE game_date = to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD')) AS markers_today,
      (SELECT count(DISTINCT home_team || '|' || away_team) FROM public.props_cache
        WHERE sport='mlb' AND game_date = to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD')) AS scheduled_today,
      (SELECT count(*) FROM public.pick_history
        WHERE sport='mlb' AND is_synthetic=false
          AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE) AS picks_today
  LOOP RAISE NOTICE '  today=% markers=% scheduled=% picks=%',
    r.today_gd, r.markers_today, r.scheduled_today, r.picks_today; END LOOP;

  -- §5d D-514 first morning test
  RAISE NOTICE '[D-DAILY §5d] D-514 morning test — earliest pick_history for today:';
  FOR r IN
    SELECT min(created_at) AS first_pick_created_utc,
           min(created_at) AT TIME ZONE 'America/New_York' AS first_pick_created_et,
           count(*) AS picks_today
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE
  LOOP RAISE NOTICE '  first_pick_created_UTC=% first_pick_ET=% picks_today=%',
    r.first_pick_created_utc, r.first_pick_created_et, r.picks_today; END LOOP;

  -- §5e cron freshness for jobid 21 (process-games-mlb) - did the new */5 schedule fire during morning ET hours?
  RAISE NOTICE '[D-DAILY §5e] D-514 morning test — jobid 21 fires during 05:00-16:59 UTC last 24h:';
  FOR r IN
    SELECT date_trunc('hour', jrd.start_time) AS hr_utc,
           count(*) AS fires,
           count(*) FILTER (WHERE jrd.status='succeeded') AS succ
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE j.jobname='process-games-mlb-30min'
      AND jrd.start_time > NOW() - INTERVAL '24 hours'
      AND EXTRACT(HOUR FROM jrd.start_time) BETWEEN 5 AND 16
    GROUP BY hr_utc ORDER BY hr_utc DESC
  LOOP RAISE NOTICE '  hour_UTC=% fires=% succ=%', r.hr_utc, r.fires, r.succ; END LOOP;

  -- Sanity: now ET
  RAISE NOTICE '[D-DAILY ctx] NOW UTC=% ET=% today_ET=%',
    NOW(), (NOW() AT TIME ZONE 'America/New_York'),
    (NOW() AT TIME ZONE 'America/New_York')::DATE;
END $$;
