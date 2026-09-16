-- D-313 SHIP 1 diagnostic — read cron command + GUC state for orchestrator-execute.
DO $$
DECLARE
  v_cmd TEXT;
  v_guc_present BOOLEAN;
  v_guc_len INTEGER;
  v_guc_head TEXT;
  v_guc_tail TEXT;
BEGIN
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'orchestrator-execute';
  RAISE NOTICE '[D-313] cron.job orchestrator-execute command:';
  RAISE NOTICE '%', v_cmd;

  -- Read app.backfill_auth_token GUC (missing_ok=true)
  BEGIN
    v_guc_len := length(current_setting('app.backfill_auth_token', true));
    IF v_guc_len IS NULL OR v_guc_len = 0 THEN
      RAISE NOTICE '[D-313] app.backfill_auth_token GUC: NOT SET (empty/null)';
      v_guc_present := false;
    ELSE
      v_guc_head := substring(current_setting('app.backfill_auth_token', true) FROM 1 FOR 8);
      v_guc_tail := substring(current_setting('app.backfill_auth_token', true) FROM (v_guc_len - 3));
      RAISE NOTICE '[D-313] app.backfill_auth_token GUC: SET (len=%, head=%..., tail=...%)', v_guc_len, v_guc_head, v_guc_tail;
      v_guc_present := true;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[D-313] app.backfill_auth_token GUC: ERROR reading (%)', SQLERRM;
  END;

  -- Also check what other working crons use for comparison
  RAISE NOTICE '[D-313] sample working cron commands (fetch-odds-every-15min, run-optimizer-v2):';
  FOR v_cmd IN (
    SELECT substring(command FROM 1 FOR 400) FROM cron.job WHERE jobname IN ('fetch-odds-every-15min', 'orchestrator-daily-report') ORDER BY jobname
  ) LOOP
    RAISE NOTICE '%', v_cmd;
  END LOOP;
END $$;
