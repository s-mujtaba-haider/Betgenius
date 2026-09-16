-- Diagnostic: find where app.backfill_auth_token is actually set so we can
-- mirror it for the Phase 6 test. No mutations.

DO $$
DECLARE
  v_role TEXT;
  v_db TEXT;
  v_db_settings TEXT[];
  v_role_settings TEXT[];
  v_guc_value TEXT;
  v_settings_record RECORD;
BEGIN
  SELECT current_user INTO v_role;
  SELECT current_database() INTO v_db;
  RAISE NOTICE '[guc inspect] current_user=% current_database=%', v_role, v_db;

  -- Try reading the GUC under different visibility paths
  v_guc_value := current_setting('app.backfill_auth_token', true);
  RAISE NOTICE '[guc inspect] current_setting app.backfill_auth_token: %',
    CASE WHEN v_guc_value IS NULL OR v_guc_value = '' THEN '(empty)' ELSE 'set, len=' || LENGTH(v_guc_value) END;

  v_guc_value := current_setting('app.settings.service_role_key', true);
  RAISE NOTICE '[guc inspect] current_setting app.settings.service_role_key: %',
    CASE WHEN v_guc_value IS NULL OR v_guc_value = '' THEN '(empty)' ELSE 'set, len=' || LENGTH(v_guc_value) END;

  -- Inspect database-level settings
  BEGIN
    SELECT setconfig INTO v_db_settings FROM pg_db_role_setting
    WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND setrole = 0;
    RAISE NOTICE '[guc inspect] database-level settings (role=0): %',
      COALESCE(array_to_string(v_db_settings, ' | '), '(none)');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[guc inspect] cannot read pg_db_role_setting (db level): %', SQLERRM;
  END;

  -- Inspect role-level settings (search for any role with app.backfill_auth_token)
  BEGIN
    FOR v_settings_record IN
      SELECT r.rolname, dbr.setconfig
      FROM pg_db_role_setting dbr
      LEFT JOIN pg_roles r ON r.oid = dbr.setrole
      WHERE EXISTS (
        SELECT 1 FROM unnest(dbr.setconfig) s
        WHERE s LIKE 'app.%'
      )
    LOOP
      RAISE NOTICE '[guc inspect] role=% setconfig=%',
        COALESCE(v_settings_record.rolname, '(db-level)'),
        array_to_string(v_settings_record.setconfig, ' | ');
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[guc inspect] pg_db_role_setting scan failed: %', SQLERRM;
  END;

  -- pg_cron user info
  BEGIN
    FOR v_settings_record IN
      SELECT jobid, username FROM cron.job WHERE jobid IN (10, 12) ORDER BY jobid
    LOOP
      RAISE NOTICE '[guc inspect] cron jobid=% runs as username=%',
        v_settings_record.jobid, v_settings_record.username;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[guc inspect] cron.job username column unavailable: %', SQLERRM;
  END;
END $$;
