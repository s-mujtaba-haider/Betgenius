DO $$
DECLARE r RECORD;
BEGIN
  -- a. The 4 NULL-type error_log rows
  RAISE NOTICE '[D-507 dig a] NULL-type error_log last 24h:';
  FOR r IN
    SELECT created_at, function_name, left(COALESCE(error_message,'<null>'), 250) AS msg
    FROM public.error_log
    WHERE error_type IS NULL AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% fn=% msg=%', r.created_at, r.function_name, r.msg; END LOOP;

  -- b. post_failed + ai_verdict_mismatch detail
  RAISE NOTICE '[D-507 dig b] post_failed + ai_verdict_mismatch last 24h:';
  FOR r IN
    SELECT created_at, error_type, function_name, left(COALESCE(error_message,'<null>'), 250) AS msg
    FROM public.error_log
    WHERE error_type IN ('post_failed','ai_verdict_mismatch') AND created_at > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% type=% fn=% msg=%', r.created_at, r.error_type, r.function_name, r.msg; END LOOP;

  -- c. All process-games-related crons + their schedules
  RAISE NOTICE '[D-507 dig c] all process-games-related crons (and schedule):';
  FOR r IN
    SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname ILIKE '%process%' OR jobname ILIKE '%mlb%' OR jobname ILIKE '%games%'
    ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%', r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- d. find the slate / schedule table
  RAISE NOTICE '[D-507 dig d] candidate slate tables in public:';
  FOR r IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (table_name ILIKE '%schedule%' OR table_name ILIKE '%slate%'
           OR table_name ILIKE '%scoring_progress%' OR table_name ILIKE '%mlb_game%')
    ORDER BY table_name
  LOOP RAISE NOTICE '  %', r.table_name; END LOOP;

  -- e. Max function runtime in last 24h via net._http_response timing
  -- (created column = response time; we need start time too).
  -- Approximation: look at duration_ms in JSON bodies where present
  RAISE NOTICE '[D-507 dig e] resolve-picks responses with elapsed > 100s last 24h:';
  FOR r IN
    SELECT id, status_code, created,
           (regexp_match(content::text, '"elapsedSeconds"\s*:\s*([0-9.]+)'))[1] AS elapsed_s
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '24 hours'
      AND content::text LIKE '%elapsedSeconds%'
    ORDER BY (regexp_match(content::text, '"elapsedSeconds"\s*:\s*([0-9.]+)'))[1]::NUMERIC DESC NULLS LAST
    LIMIT 5
  LOOP RAISE NOTICE '  rid=% status=% at=% elapsed_s=%', r.id, r.status_code, r.created, r.elapsed_s; END LOOP;

  -- f. Any errors / heartbeats showing function runtimes > 130s after 00:32 UTC today?
  RAISE NOTICE '[D-507 dig f] runtime warnings after 2026-06-11 00:32 UTC:';
  FOR r IN
    SELECT created_at, error_type, function_name, left(COALESCE(error_message,'<null>'), 200) AS msg
    FROM public.error_log
    WHERE created_at > '2026-06-11 00:32:24+00'
      AND (error_type ILIKE '%runtime%' OR error_type ILIKE '%timeout%'
           OR error_message ILIKE '%timeout%' OR error_message ILIKE '%exceeds%')
    ORDER BY created_at DESC LIMIT 10
  LOOP RAISE NOTICE '  at=% type=% fn=% msg=%', r.created_at, r.error_type, r.function_name, r.msg; END LOOP;
END $$;
