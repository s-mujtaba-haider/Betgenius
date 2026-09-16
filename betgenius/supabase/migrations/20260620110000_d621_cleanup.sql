-- D-621 — Safe log-table cleanup. §2 CEO-APPROVED after diagnosis.
--
-- WHAT THIS DOES:
--   1. PROVES counts BEFORE delete (cardinal rule on prod deletes).
--   2. DELETEs only from LOG tables (error_log, cron.job_run_details, run_log).
--   3. Never touches pick_history / recommendations_cache / props_cache / cache_*.
--   4. VACUUM happens in a SEPARATE migration after this commits.
--
-- WHAT THIS DOES NOT DO:
--   - VACUUM (must run outside a transaction; separate migration).
--   - Touch cache_mlb_historical_odds (the 9.3 GB monster — different batch).
--   - Touch pick_history (core data — VACUUM-only in next migration).
--   - Prune props_cache (game-date semantics; needs game-cron coordination).
--
-- ROLLBACK: This is a destructive prune of old log rows (>30d). There is
-- no rollback — the rows are gone. The pruned data:
--   - error_log checkpoint rows older than 30d (short-term diagnostic tail)
--   - error_log resolved-error types older than 30d (rpc_failed, post_failed,
--     cache_write_failed, circuit_breaker — issues already closed)
--   - cron.job_run_details older than 30d (pg_cron's own per-run log)
--   - run_log older than 30d (orchestrator audit table)
-- None of these are read by the app/harness; only by probes/diagnostics
-- which operate on RECENT data (last 60 min to 7 days).

DO $$ DECLARE
  v_checkpoint_old bigint;
  v_resolved_old bigint;
  v_cron_old bigint;
  v_runlog_old bigint;
BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-621 cleanup — BEFORE counts (at % UTC)', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- BEFORE counts
  SELECT count(*) INTO v_checkpoint_old
    FROM public.error_log
   WHERE error_type = 'checkpoint' AND created_at < now() - interval '30 days';

  SELECT count(*) INTO v_resolved_old
    FROM public.error_log
   WHERE error_type IN ('rpc_failed', 'circuit_breaker', 'post_failed', 'cache_write_failed', 'sonnet_http_error')
     AND created_at < now() - interval '30 days';

  SELECT count(*) INTO v_cron_old
    FROM cron.job_run_details
   WHERE start_time < now() - interval '30 days';

  SELECT count(*) INTO v_runlog_old
    FROM public.run_log
   WHERE created_at < now() - interval '30 days';

  RAISE NOTICE '  error_log checkpoint > 30d:          % rows TO DELETE', v_checkpoint_old;
  RAISE NOTICE '  error_log resolved-types > 30d:     % rows TO DELETE', v_resolved_old;
  RAISE NOTICE '  cron.job_run_details > 30d:         % rows TO DELETE', v_cron_old;
  RAISE NOTICE '  run_log > 30d:                       % rows TO DELETE', v_runlog_old;
  RAISE NOTICE '  ────────────────────────────────────────';
  RAISE NOTICE '  TOTAL:                               % rows', v_checkpoint_old + v_resolved_old + v_cron_old + v_runlog_old;
END $$;

-- ====================================================================
-- DELETES
-- ====================================================================

DELETE FROM public.error_log
 WHERE error_type = 'checkpoint'
   AND created_at < now() - interval '30 days';

DELETE FROM public.error_log
 WHERE error_type IN ('rpc_failed', 'circuit_breaker', 'post_failed', 'cache_write_failed', 'sonnet_http_error')
   AND created_at < now() - interval '30 days';

DELETE FROM cron.job_run_details
 WHERE start_time < now() - interval '30 days';

DELETE FROM public.run_log
 WHERE created_at < now() - interval '30 days';

-- ====================================================================
-- AFTER counts
-- ====================================================================
DO $$ DECLARE
  v_el_total bigint;
  v_cron_total bigint;
  v_runlog_total bigint;
BEGIN
  SELECT count(*) INTO v_el_total FROM public.error_log;
  SELECT count(*) INTO v_cron_total FROM cron.job_run_details;
  SELECT count(*) INTO v_runlog_total FROM public.run_log;

  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-621 cleanup — AFTER counts';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE '  error_log total:                     % rows remaining', v_el_total;
  RAISE NOTICE '  cron.job_run_details total:          % rows remaining', v_cron_total;
  RAISE NOTICE '  run_log total:                       % rows remaining', v_runlog_total;
  RAISE NOTICE '';
  RAISE NOTICE 'pick_history UNTOUCHED (core data). Run VACUUM in next migration.';
END $$;
