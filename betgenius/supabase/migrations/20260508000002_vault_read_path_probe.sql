-- Probe whether the postgres role (cron's runner) can read decrypted_secrets
-- at fire time. If yes → vault path is fully viable. If no → we need a
-- security-definer wrapper or fall back to literal-embed in cron command.

DO $$
DECLARE
  v_count INTEGER;
  v_view_count INTEGER;
  v_role TEXT;
  v_secret_test TEXT;
  v_func_signature TEXT;
BEGIN
  v_role := current_user;
  RAISE NOTICE '[probe] current_user=% (this is what cron runs as)', v_role;

  -- 1. Can we SELECT from vault.decrypted_secrets?
  BEGIN
    SELECT COUNT(*) INTO v_count FROM vault.decrypted_secrets;
    RAISE NOTICE '[probe.1] vault.decrypted_secrets SELECT: WORKS (current count=%)', v_count;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[probe.1] vault.decrypted_secrets SELECT: FAILS — % / SQLSTATE=%', SQLERRM, SQLSTATE;
  END;

  -- 2. Try the EXACT pattern jobid 12 will use after migration
  --    (round-trip a probe secret via create_secret + decrypted_secrets read)
  BEGIN
    PERFORM vault.create_secret('roundtrip_probe_value_xyz', 'DIAG_ROUNDTRIP_DELETE_ME');
    SELECT decrypted_secret INTO v_secret_test
    FROM vault.decrypted_secrets
    WHERE name = 'DIAG_ROUNDTRIP_DELETE_ME'
    LIMIT 1;
    RAISE NOTICE '[probe.2] round-trip vault.create_secret → decrypted_secrets: % (expected roundtrip_probe_value_xyz)',
      COALESCE(v_secret_test, '(null)');
    -- Cleanup
    BEGIN
      DELETE FROM vault.secrets WHERE name = 'DIAG_ROUNDTRIP_DELETE_ME';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[probe.2] cleanup DELETE failed: % — manual delete needed', SQLERRM;
    END;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[probe.2] round-trip FAILED: % / SQLSTATE=%', SQLERRM, SQLSTATE;
  END;

  -- 3. Re-probe vault.create_secret signature (confirm 2-arg works without description)
  FOR v_func_signature IN
    SELECT n.nspname || '.' || p.proname || '(' ||
           pg_catalog.pg_get_function_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'create_secret' AND n.nspname = 'vault'
  LOOP
    RAISE NOTICE '[probe.3] full signature with defaults: %', v_func_signature;
  END LOOP;

  -- 4. Confirm cron.job UPDATE-via-alter_job permission for jobid 10 (we know 12 works)
  BEGIN
    PERFORM 1 FROM cron.job WHERE jobid = 10;
    IF FOUND THEN
      RAISE NOTICE '[probe.4] jobid 10 exists and is readable';
    ELSE
      RAISE NOTICE '[probe.4] jobid 10 NOT FOUND in cron.job';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[probe.4] cron.job jobid 10 read failed: %', SQLERRM;
  END;
END $$;
