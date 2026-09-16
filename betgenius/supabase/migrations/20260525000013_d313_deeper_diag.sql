-- D-313 DEEPER DIAG — auth fix didn't work. Inspect everything.
DO $$
DECLARE
  v_srk_len INTEGER;
  v_srk_head TEXT;
  v_srk_tail TEXT;
  v_cmd TEXT;
BEGIN
  -- Check app.settings.service_role_key GUC
  BEGIN
    v_srk_len := length(current_setting('app.settings.service_role_key', true));
    IF v_srk_len IS NULL OR v_srk_len = 0 THEN
      RAISE NOTICE '[D-313 deep] app.settings.service_role_key GUC: NOT SET';
    ELSE
      v_srk_head := substring(current_setting('app.settings.service_role_key', true) FROM 1 FOR 12);
      v_srk_tail := substring(current_setting('app.settings.service_role_key', true) FROM (v_srk_len - 5));
      RAISE NOTICE '[D-313 deep] app.settings.service_role_key GUC: len=% head=%... tail=...%', v_srk_len, v_srk_head, v_srk_tail;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[D-313 deep] app.settings.service_role_key: ERROR %', SQLERRM;
  END;

  -- Show actual current command (after my alter_job)
  SELECT command INTO v_cmd FROM cron.job WHERE jobname = 'orchestrator-execute';
  RAISE NOTICE '[D-313 deep] current orchestrator-execute command:';
  RAISE NOTICE '%', v_cmd;

  -- Check run details for the last 3 firings to see if pg_cron logs anything useful
  RAISE NOTICE '[D-313 deep] last 3 cron.job_run_details for orchestrator-execute:';
  FOR v_cmd IN
    SELECT start_time::TEXT || ' | ' || status::TEXT || ' | return_message=' || COALESCE(return_message, '(null)')
    FROM cron.job_run_details
    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'orchestrator-execute')
    ORDER BY start_time DESC
    LIMIT 3
  LOOP
    RAISE NOTICE '  %', v_cmd;
  END LOOP;
END $$;
