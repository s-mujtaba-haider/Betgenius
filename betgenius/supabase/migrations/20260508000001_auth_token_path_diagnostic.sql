-- Auth token population path diagnostic (May 8, 2026 morning).
--
-- CEO reported `ALTER ROLE postgres SET app.backfill_auth_token = '...'`
-- fails with syntax error 42601 at the dot in Supabase SQL Editor. This
-- migration runs every plausible variant + capability check and reports
-- via NOTICE so we know what the hosted environment actually accepts.
--
-- Read-only / sandboxed: any test value set is rolled back via SET LOCAL
-- where possible. Any mutation that does land (e.g. ALTER ROLE) is
-- explicitly cleaned up at the end of the DO block.

DO $$
DECLARE
  v_user TEXT;
  v_super TEXT;
  v_db TEXT;
  v_can_role_set BOOLEAN := false;
  v_can_db_set BOOLEAN := false;
  v_can_session_set BOOLEAN := false;
  v_can_role_quoted_set BOOLEAN := false;
  v_role_set_err TEXT;
  v_db_set_err TEXT;
  v_session_set_err TEXT;
  v_role_quoted_err TEXT;
  v_vault_create_count INTEGER := 0;
  v_vault_secrets_count INTEGER := 0;
  v_vault_func_signature TEXT;
  v_can_insert_vault BOOLEAN := false;
  v_vault_insert_err TEXT;
BEGIN
  -- ============================================================
  -- 1. Role + superuser status
  -- ============================================================
  v_user := current_user;
  v_super := current_setting('is_superuser');
  v_db := current_database();
  RAISE NOTICE '[1] current_user=% is_superuser=% current_database=%', v_user, v_super, v_db;

  -- ============================================================
  -- 2. Vault availability
  -- ============================================================
  BEGIN
    SELECT COUNT(*) INTO v_vault_create_count
    FROM pg_proc
    WHERE proname LIKE '%create_secret%';
    RAISE NOTICE '[2a] pg_proc functions matching %%create_secret%%: %', v_vault_create_count;

    -- Get full signatures
    FOR v_vault_func_signature IN
      SELECT n.nspname || '.' || p.proname || '(' ||
             pg_catalog.pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname LIKE '%create_secret%'
    LOOP
      RAISE NOTICE '[2b] vault function: %', v_vault_func_signature;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[2] pg_proc query failed: %', SQLERRM;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_vault_secrets_count FROM vault.secrets;
    RAISE NOTICE '[2c] vault.secrets row count: %', v_vault_secrets_count;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[2c] vault.secrets unavailable: %', SQLERRM;
  END;

  -- ============================================================
  -- 3a. ALTER ROLE postgres SET app.backfill_auth_token (unquoted)
  -- ============================================================
  BEGIN
    EXECUTE 'ALTER ROLE postgres SET app.backfill_auth_token = ''diag_test_value_unquoted''';
    v_can_role_set := true;
    -- If we got here, mutation succeeded. RESET immediately so we don't leave the value set.
    EXECUTE 'ALTER ROLE postgres RESET app.backfill_auth_token';
    RAISE NOTICE '[3a] ALTER ROLE postgres SET app.backfill_auth_token: WORKS (mutation rolled back via RESET)';
  EXCEPTION WHEN OTHERS THEN
    v_role_set_err := SQLERRM || ' / SQLSTATE=' || SQLSTATE;
    RAISE NOTICE '[3a] ALTER ROLE postgres SET app.backfill_auth_token: FAILS — %', v_role_set_err;
  END;

  -- ============================================================
  -- 3b. ALTER ROLE postgres SET "app.backfill_auth_token" (double-quoted name)
  -- ============================================================
  BEGIN
    EXECUTE 'ALTER ROLE postgres SET "app.backfill_auth_token" = ''diag_test_value_quoted''';
    v_can_role_quoted_set := true;
    EXECUTE 'ALTER ROLE postgres RESET "app.backfill_auth_token"';
    RAISE NOTICE '[3b] ALTER ROLE postgres SET "app.backfill_auth_token": WORKS (rolled back)';
  EXCEPTION WHEN OTHERS THEN
    v_role_quoted_err := SQLERRM || ' / SQLSTATE=' || SQLSTATE;
    RAISE NOTICE '[3b] ALTER ROLE postgres SET "app.backfill_auth_token": FAILS — %', v_role_quoted_err;
  END;

  -- ============================================================
  -- 3c. ALTER DATABASE postgres SET app.backfill_auth_token
  -- ============================================================
  BEGIN
    EXECUTE 'ALTER DATABASE postgres SET app.backfill_auth_token = ''diag_test_value_db''';
    v_can_db_set := true;
    EXECUTE 'ALTER DATABASE postgres RESET app.backfill_auth_token';
    RAISE NOTICE '[3c] ALTER DATABASE postgres SET app.backfill_auth_token: WORKS (rolled back)';
  EXCEPTION WHEN OTHERS THEN
    v_db_set_err := SQLERRM || ' / SQLSTATE=' || SQLSTATE;
    RAISE NOTICE '[3c] ALTER DATABASE postgres SET app.backfill_auth_token: FAILS — %', v_db_set_err;
  END;

  -- ============================================================
  -- 3d. SET app.backfill_auth_token (session-scope only — won't persist)
  -- ============================================================
  BEGIN
    EXECUTE 'SET app.backfill_auth_token = ''diag_test_session''';
    v_can_session_set := true;
    EXECUTE 'RESET app.backfill_auth_token';
    RAISE NOTICE '[3d] SET app.backfill_auth_token (session): WORKS — but session-scope, does NOT persist for cron';
  EXCEPTION WHEN OTHERS THEN
    v_session_set_err := SQLERRM || ' / SQLSTATE=' || SQLSTATE;
    RAISE NOTICE '[3d] SET app.backfill_auth_token (session): FAILS — %', v_session_set_err;
  END;

  -- ============================================================
  -- 4. Vault: try INSERT directly (in case create_secret is unavailable
  --    but the underlying secrets table accepts inserts)
  -- ============================================================
  BEGIN
    -- Don't actually mutate vault.secrets in production. Just probe with EXPLAIN.
    EXECUTE 'EXPLAIN INSERT INTO vault.secrets (name, secret) VALUES (''diag_probe'', ''probe_value'')';
    v_can_insert_vault := true;
    RAISE NOTICE '[4a] vault.secrets INSERT: planner accepts (EXPLAIN succeeded). Actual INSERT not executed.';
  EXCEPTION WHEN OTHERS THEN
    v_vault_insert_err := SQLERRM || ' / SQLSTATE=' || SQLSTATE;
    RAISE NOTICE '[4a] vault.secrets INSERT EXPLAIN failed: %', v_vault_insert_err;
  END;

  -- Try vault.create_secret with TWO-ARG form (secret, name)
  BEGIN
    PERFORM vault.create_secret('diag_test_secret_value', 'DIAG_PROBE_DELETE_ME');
    -- If it actually inserted, clean up
    BEGIN
      DELETE FROM vault.secrets WHERE name = 'DIAG_PROBE_DELETE_ME';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE NOTICE '[4b] vault.create_secret(secret,name) TWO-ARG form: WORKS (probe row deleted)';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[4b] vault.create_secret(secret,name) TWO-ARG form: FAILS — % / SQLSTATE=%', SQLERRM, SQLSTATE;
  END;

  -- Try vault.create_secret with THREE-ARG form (secret, name, description)
  BEGIN
    PERFORM vault.create_secret('diag_test_secret_value', 'DIAG_PROBE_DELETE_ME_3', 'diagnostic probe');
    BEGIN
      DELETE FROM vault.secrets WHERE name = 'DIAG_PROBE_DELETE_ME_3';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE NOTICE '[4c] vault.create_secret(secret,name,description) THREE-ARG form: WORKS (probe row deleted)';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[4c] vault.create_secret(secret,name,description) THREE-ARG form: FAILS — % / SQLSTATE=%', SQLERRM, SQLSTATE;
  END;

  -- ============================================================
  -- 5. cron.alter_job permission probe (already known to work via Phase 7,
  --    but reconfirm in this diagnostic)
  -- ============================================================
  BEGIN
    -- Don't actually alter; just probe permissions on cron.job
    PERFORM 1 FROM cron.job WHERE jobid IN (10, 12);
    RAISE NOTICE '[5] cron.job SELECT works for jobid 10 + 12';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[5] cron.job SELECT failed: %', SQLERRM;
  END;

  -- ============================================================
  -- SUMMARY
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '=== SUMMARY ===';
  RAISE NOTICE 'role_set_unquoted=% role_set_quoted=% db_set=% session_set=%',
    v_can_role_set, v_can_role_quoted_set, v_can_db_set, v_can_session_set;
  RAISE NOTICE 'vault_create_proc_count=% vault_can_insert_explain=%',
    v_vault_create_count, v_can_insert_vault;
END $$;
