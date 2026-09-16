DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-514 §a] jobid 21 (process-games-mlb) + 46 (capture-closing-odds) overnight runs (last 18h):';
  FOR r IN
    SELECT j.jobname, count(*) AS n_runs,
           min(jrd.start_time) AS first_run,
           max(jrd.start_time) AS last_run,
           count(*) FILTER (WHERE jrd.status='succeeded') AS succeeded,
           count(*) FILTER (WHERE jrd.status='failed') AS failed
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE j.jobname IN ('process-games-mlb-30min','capture-closing-odds-mlb-5min')
      AND jrd.start_time > NOW() - INTERVAL '18 hours'
    GROUP BY j.jobname
  LOOP RAISE NOTICE '  job=% n=% first=% last=% succ=% failed=%',
    r.jobname, r.n_runs, r.first_run, r.last_run, r.succeeded, r.failed; END LOOP;

  RAISE NOTICE '[D-514 §b] last jobid 21 fire vs now:';
  FOR r IN
    SELECT max(jrd.start_time) AS last_fire,
           NOW() - max(jrd.start_time) AS gap
    FROM cron.job j JOIN cron.job_run_details jrd ON j.jobid=jrd.jobid
    WHERE j.jobname='process-games-mlb-30min'
  LOOP RAISE NOTICE '  last_fire=% gap=%', r.last_fire, r.gap; END LOOP;

  -- D-508 stress test: yesterday's full slate max tick runtime + slate clear time
  RAISE NOTICE '[D-514 §c] D-508 yesterday full-slate stress — max tick runtime (via duration_ms parse):';
  FOR r IN
    SELECT
      max((regexp_match(content::text, '"duration_ms"\s*:\s*([0-9]+)'))[1]::int) AS max_ms,
      min((regexp_match(content::text, '"duration_ms"\s*:\s*([0-9]+)'))[1]::int) AS min_ms,
      avg((regexp_match(content::text, '"duration_ms"\s*:\s*([0-9]+)'))[1]::int) AS avg_ms,
      count(*) AS n
    FROM net._http_response
    WHERE created BETWEEN '2026-06-10 17:00:00+00' AND '2026-06-11 05:00:00+00'
      AND content::text LIKE '%picks_scored%'
  LOOP RAISE NOTICE '  max_ms=% min_ms=% avg_ms=% ticks=%',
    r.max_ms, r.min_ms, ROUND(r.avg_ms), r.n; END LOOP;

  -- Slate clear: time from first marker to last marker for yesterday
  RAISE NOTICE '[D-514 §d] yesterday slate clear via mlb_scoring_progress markers:';
  FOR r IN
    SELECT min(scored_at) AS first_mark, max(scored_at) AS last_mark,
           max(scored_at) - min(scored_at) AS clear_time,
           count(*) AS games_marked
    FROM public.mlb_scoring_progress
    WHERE game_date='20260610'
  LOOP RAISE NOTICE '  first=% last=% clear_time=% games=%',
    r.first_mark, r.last_mark, r.clear_time, r.games_marked; END LOOP;

  -- props_cache: when does today's slate first appear?
  RAISE NOTICE '[D-514 §e] today (20260611) props_cache first_seen distribution:';
  FOR r IN
    SELECT min(first_seen) AS earliest, max(first_seen) AS latest, count(*) AS n
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260611'
  LOOP RAISE NOTICE '  earliest=% latest=% rows=%', r.earliest, r.latest, r.n; END LOOP;

  -- For the last 7 days: when do today's-slate props FIRST appear (game_date matched to date)
  RAISE NOTICE '[D-514 §f] per-day "first prop for that game_date" timestamp (last 7 days):';
  FOR r IN
    SELECT game_date, min(first_seen) AS first_prop, count(*) AS rows_total
    FROM public.props_cache
    WHERE sport='mlb' AND game_date >= '20260605'
    GROUP BY game_date ORDER BY game_date
  LOOP RAISE NOTICE '  gd=% first_prop=% rows=%',
    r.game_date, r.first_prop, r.rows_total; END LOOP;

  -- fetch-odds-mlb cron schedule (we need to confirm it covers the proposed scoring window)
  RAISE NOTICE '[D-514 §g] fetch-odds-mlb cron schedules:';
  FOR r IN
    SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname IN ('fetch-odds-mlb-30min','fetch-odds-mlb-morning','fetch-odds-tomorrow')
    ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%',
    r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- Today's pick_history age — is dashboard actually showing yesterday's?
  RAISE NOTICE '[D-514 §h] today vs yesterday pick_history counts and timestamps:';
  FOR r IN
    SELECT game_date,
           count(*) AS n,
           min(created_at) AS earliest, max(created_at) AS latest
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date IN (
        (NOW() AT TIME ZONE 'America/New_York')::DATE,
        (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      )
    GROUP BY game_date ORDER BY game_date DESC
  LOOP RAISE NOTICE '  gd=% n=% earliest=% latest=%',
    r.game_date, r.n, r.earliest, r.latest; END LOOP;

  -- And NOW so we can compare
  RAISE NOTICE '[D-514 §i] context: NOW=% ET=%',
    NOW(), (NOW() AT TIME ZONE 'America/New_York')::TIME;
END $$;
