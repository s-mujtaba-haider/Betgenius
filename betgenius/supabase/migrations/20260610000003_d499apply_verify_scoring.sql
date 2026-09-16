-- D-499-APPLY SHIP 2 step E — Trigger process-games-mlb ad-hoc to prove
-- scoring reflects the new weights. The fn calls loadMlbWeightsFromDB()
-- at line 2587 BEFORE scoring fires; that reads from algorithm_weights
-- (now with 7 patched values). Run_log + recommendations_cache write
-- afterward will reflect the new weights in effect.
--
-- Captures: most recent process-games-mlb run_log entry as baseline,
-- then submits net.http_post trigger. Follow-up query of run_log
-- shows a NEW entry post-PATCH.
DO $$
DECLARE
  v_baseline_id BIGINT;
  v_baseline_ts TIMESTAMPTZ;
  v_request_id  BIGINT;
  v_vault_len   INTEGER;
BEGIN
  -- 1. Capture baseline: most recent process-games-mlb run_log entry
  SELECT id, created_at INTO v_baseline_id, v_baseline_ts
  FROM public.run_log
  WHERE function_name = 'process-games-mlb'
  ORDER BY created_at DESC LIMIT 1;
  RAISE NOTICE '[D-499-APPLY SCORING] baseline run_log entry: id=% created_at=%',
    v_baseline_id, v_baseline_ts;

  -- 2. Verify vault auth
  SELECT length(decrypted_secret) INTO v_vault_len
    FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-499-APPLY] vault BACKFILL_AUTH_TOKEN missing';
  END IF;

  -- 3. Trigger process-games-mlb ad-hoc (it will call loadMlbWeightsFromDB()
  --    at line 2587 reading our newly-patched values, then score whatever
  --    is in slate). dry_run guard inside the fn determines whether picks
  --    persist — we trigger with empty body which uses the fn's defaults.
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 600000   -- 10 min (process-games-mlb may run up to D-472 ceiling)
  ) INTO v_request_id;
  RAISE NOTICE '[D-499-APPLY SCORING] ad-hoc process-games-mlb triggered; request_id=%', v_request_id;
  RAISE NOTICE '[D-499-APPLY SCORING] expected: new run_log entry created_at > % (baseline)', v_baseline_ts;
END $$;
