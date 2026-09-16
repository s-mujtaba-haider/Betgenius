-- D-499 (2026-06-09) — MLB full 54-factor optimizer DRY-RUN trigger.
-- §19.3 PROPOSAL ONLY. The optimizer defaults to apply=false (line 198 of
-- optimize-weights-mlb/index.ts) so this call returns a proposal but does
-- NOT PATCH algorithm_weights. CEO reviews proposal before any D-499-APPLY.
--
-- Sequence:
--   1. RAISE NOTICE all 54 w_mlb_* values BEFORE (proof that the BEFORE
--      snapshot is captured, mirrored later for AFTER comparison).
--   2. Trigger optimize-weights-mlb via pg_net (async; long timeout). Body
--      empty → all defaults: dry-run, min_conf=60, grid=[0..2.5 step 0.25],
--      magnitude_cap=0.5, market_regression_min_n=25, full ALL_WEIGHTS range.
--   3. NOTICE the request_id so the response fetcher migration can poll.
--
-- The optimizer's response body lands asynchronously in net._http_response;
-- a follow-up migration retrieves it.

DO $$
DECLARE
  r RECORD;
  v_request_id BIGINT;
  v_vault_len  INTEGER;
BEGIN
  -- 1. BEFORE snapshot of all 54 MLB weight columns
  RAISE NOTICE '[D-499] BEFORE snapshot — full algorithm_weights row id=1 (54 w_mlb_* cols + 30+ w_* NBA cols):';
  FOR r IN
    SELECT row_to_json(algorithm_weights) AS j FROM algorithm_weights WHERE id = 1
  LOOP
    RAISE NOTICE 'BEFORE_ROW_JSON %', r.j;
  END LOOP;

  -- 2. Verify vault auth secret
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-499] vault BACKFILL_AUTH_TOKEN missing — abort';
  END IF;
  RAISE NOTICE '[D-499] vault token present (length=%)', v_vault_len;

  -- 3. Trigger optimizer with EMPTY body = all defaults = dry-run, full range
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/optimize-weights-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 600000   -- 10 min (optimizer needs time for 54-factor grid sweep)
  ) INTO v_request_id;

  RAISE NOTICE '[D-499] optimizer triggered (dry-run, full ALL_WEIGHTS range). request_id=%', v_request_id;
  RAISE NOTICE '[D-499] response will land at net._http_response WHERE id=% — fetch via follow-up migration', v_request_id;
END $$;
