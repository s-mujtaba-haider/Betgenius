-- D-313 GUC scan — find which GUCs ARE set with auth-token-like content.
DO $$
DECLARE
  v_name TEXT;
  v_val TEXT;
  v_len INTEGER;
  v_head TEXT;
BEGIN
  RAISE NOTICE '[D-313 GUC] enumerating GUCs starting with app.*';
  FOR v_name IN
    SELECT name FROM pg_settings WHERE name LIKE 'app.%' OR name LIKE 'supabase.%' OR name LIKE 'pgrst.%' ORDER BY name
  LOOP
    BEGIN
      v_val := current_setting(v_name, true);
      v_len := length(v_val);
      IF v_len IS NULL OR v_len = 0 THEN
        RAISE NOTICE '  % = (empty/null)', v_name;
      ELSE
        v_head := substring(v_val FROM 1 FOR 16);
        RAISE NOTICE '  % = len=% head=%...', v_name, v_len, v_head;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '  % = ERROR %', v_name, SQLERRM;
    END;
  END LOOP;

  -- Also check whether fetch-odds-every-15min is actually populating run_log recently
  RAISE NOTICE '[D-313 GUC] fetch-odds run_log activity last 2h:';
  FOR v_val IN
    SELECT created_at::TEXT || ' | function=' || function_name || ' | duration_ms=' || COALESCE(duration_ms::TEXT, '?')
    FROM run_log
    WHERE function_name LIKE 'fetch-odds%'
      AND created_at > NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  %', v_val;
  END LOOP;
END $$;
