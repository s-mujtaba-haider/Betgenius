-- Tier 0 #12 Phase 2 verification — trigger backfill-historical for one
-- date in the matched-pair window so we can compare drift before/after
-- the 3 fixes. Uses net.http_post + vault.decrypted_secrets like jobid 13
-- (D-108 calibration pattern).
--
-- Chose 2026-04-25 because:
--   - 276 organic + 276 synthetic pairs in Phase 1 matched-pair set
--   - Has real organic odds in pick_history (per migration 20260511000019:
--     94% of process-games rows have non-(-110) odds)
--   - Predates cache_opponent_defensive_stats BDL aggregate coverage so
--     Fix #2's effect will be muted (acknowledged); Fix #1 (stale_data)
--     and Fix #3 (odds) effects are date-agnostic and should show fully.
--
-- The new synthetic rows will write with a fresh backfill_run_id. Existing
-- rows for the same date stay (different run_id) so we can compare deltas.

DO $$
DECLARE
  v_request_id BIGINT;
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;

  IF v_token IS NULL THEN
    RAISE EXCEPTION 'BACKFILL_AUTH_TOKEN missing from vault — cannot invoke';
  END IF;

  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/backfill-historical',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'startDate', '2026-04-25',
      'endDate',   '2026-04-25',
      'sport', 'nba',
      'dryRun', false,
      'requireServiceRoleKey', true,
      'algorithmVersion', '2026-05-11-phase2-verify'
    ),
    timeout_milliseconds := 120000
  ) INTO v_request_id;

  RAISE NOTICE 'backfill-historical invoked: request_id=%', v_request_id;
  RAISE NOTICE 'Check completion via: SELECT * FROM net._http_response WHERE id=% LIMIT 1;', v_request_id;
END $$;
