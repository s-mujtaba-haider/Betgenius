-- D-523 SHIP 3 — DEFINITIVE final 57014-class sweep app-wide.
-- EXPLAIN ANALYZE every remaining medium-shape REST read across src/
-- to give a yes/no answer on whether the 57014 class is fully closed.
--
-- 31 total REST reads counted in src/. Already verified clean / fixed:
--   pick_history (10):   Admin.tsx:340 (D-521), :1965 (D-523), :1936 HEAD,
--                        Performance.tsx:433/452/1250/406,
--                        Games.tsx:313 (D-523), CalibrationSection:122,
--                        SelectionBiasSection:101
--   recommendations_cache (2): Games.tsx:275, Evaluator.tsx:439 (single-day)
--   real_money_bets (1): Performance.tsx:406 (per-user RLS)
--   props_cache (1):     Evaluator.tsx:266 (limit=50, narrow filter)
--   per-user/per-row trivial (10): user_preferences (3), signup_attribution,
--                        subscriptions, PickCard write, ErrorBoundary write,
--                        Landing waitlist POST, Admin allowed_emails POST/DELETE
--
-- Remaining medium-shape reads — EXPLAIN below to close the gap:
--   Admin.tsx:1963 — api_usage order by called_at desc limit 1
--   Admin.tsx:1964 — cron_progress single-day order by completed_at limit 1
--   Admin.tsx:1966 — algorithm_weights order by updated_at limit 1
--   Admin.tsx:2004 — error_log last 7d order by created_at desc limit 500
--   Admin.tsx:2318 — allowed_emails order by added_at desc (no limit)
--   CalibrationSection.tsx:89 — calibration_snapshots since cutoff
--   Landing.tsx:52 — calibration_snapshots latest rolling_30d
--   SelectionBiasSection.tsx:116 — bets capped 5000
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §E.1 Admin.tsx:1963 — most-recent fetch-odds api_usage call
  RAISE NOTICE '[D-523 §E.1] api_usage fetch-odds latest:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT called_at FROM public.api_usage
    WHERE function_name='fetch-odds'
    ORDER BY called_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.2 Admin.tsx:1964 — cron_progress today
  RAISE NOTICE '[D-523 §E.2] cron_progress today:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT completed_at FROM public.cron_progress
    WHERE game_date = '20260614'
    ORDER BY completed_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.3 Admin.tsx:1966 — algorithm_weights latest
  RAISE NOTICE '[D-523 §E.3] algorithm_weights latest:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.algorithm_weights
    ORDER BY updated_at DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.4 Admin.tsx:2004 — error_log last 7d (limit 500)
  RAISE NOTICE '[D-523 §E.4] error_log 7d top 500:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT function_name, error_type, error_message, created_at
    FROM public.error_log
    WHERE created_at >= (now() - interval '7 days')
    ORDER BY created_at DESC LIMIT 500
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.5 Admin.tsx:2318 — allowed_emails order by added_at
  RAISE NOTICE '[D-523 §E.5] allowed_emails ordered:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT email, added_by, added_at, notes FROM public.allowed_emails
    ORDER BY added_at DESC
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.6 CalibrationSection.tsx:89 — calibration_snapshots since cutoff
  RAISE NOTICE '[D-523 §E.6] calibration_snapshots since cutoff:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT * FROM public.calibration_snapshots
    WHERE snapshot_date >= '2026-05-15'::date
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.7 Landing.tsx:52 — latest rolling_30d snapshot
  RAISE NOTICE '[D-523 §E.7] Landing rolling_30d latest:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT snapshot_date, hit_rate, bets_resolved FROM public.calibration_snapshots
    WHERE metric_type='overall' AND window_type='rolling_30d'
    ORDER BY snapshot_date DESC LIMIT 1
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.8 SelectionBiasSection.tsx:116 — bets capped 5000
  RAISE NOTICE '[D-523 §E.8] bets since 2026-05-07 capped 5000:';
  FOR r IN EXECUTE $q$
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT pick_id FROM public.bets
    WHERE placed_at >= '2026-05-07'::timestamptz
      AND status IN ('won','lost')
      AND pick_id IS NOT NULL
    ORDER BY placed_at DESC LIMIT 5000
  $q$ LOOP RAISE NOTICE '  %', r."QUERY PLAN"; END LOOP;

  -- §E.9 Table row counts (size context for the verdict)
  RAISE NOTICE '[D-523 §E.9] table row counts (context):';
  FOR r IN
    SELECT
      (SELECT count(*) FROM public.api_usage)              AS api_usage,
      (SELECT count(*) FROM public.cron_progress)          AS cron_progress,
      (SELECT count(*) FROM public.algorithm_weights)      AS algorithm_weights,
      (SELECT count(*) FROM public.error_log)              AS error_log,
      (SELECT count(*) FROM public.allowed_emails)         AS allowed_emails,
      (SELECT count(*) FROM public.calibration_snapshots)  AS calibration_snapshots,
      (SELECT count(*) FROM public.bets)                   AS bets
  LOOP RAISE NOTICE '  api_usage=% cron_progress=% algorithm_weights=% error_log=% allowed_emails=% calibration_snapshots=% bets=%',
    r.api_usage, r.cron_progress, r.algorithm_weights, r.error_log,
    r.allowed_emails, r.calibration_snapshots, r.bets;
  END LOOP;
END $$;
