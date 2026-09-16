-- api_usage schema probe + BDL endpoint hits last 7 days (May 10, 2026).
-- Read-only NOTICE output.

DO $$
DECLARE
  v_row RECORD;
  v_total_bdl INTEGER;
BEGIN
  RAISE NOTICE '=== api_usage schema + BDL audit @ % ===', NOW();

  -- 1. Actual columns
  RAISE NOTICE '';
  RAISE NOTICE '--- api_usage columns ---';
  FOR v_row IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_usage'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  % %  nullable=%', v_row.column_name, v_row.data_type, v_row.is_nullable;
  END LOOP;

  -- 2. Sample row (most recent)
  RAISE NOTICE '';
  RAISE NOTICE '--- api_usage most-recent row (full) ---';
  FOR v_row IN
    SELECT *
    FROM api_usage
    ORDER BY 1 DESC NULLS LAST
    LIMIT 1
  LOOP
    RAISE NOTICE '  %', row_to_json(v_row);
  END LOOP;

  -- 3. Look for BDL-related rows (best-effort — column names unknown until probe)
  -- Try several likely column names. If none match, report "schema doesn't track BDL".
  BEGIN
    SELECT COUNT(*) INTO v_total_bdl
    FROM api_usage
    WHERE (
      (LOWER(COALESCE(api_name::TEXT, '')) LIKE '%balldontlie%' OR
       LOWER(COALESCE(api_name::TEXT, '')) LIKE '%bdl%')
    );
    RAISE NOTICE '';
    RAISE NOTICE '--- total BDL rows by api_name column: % ---', v_total_bdl;
  EXCEPTION WHEN undefined_column THEN
    RAISE NOTICE 'api_name column not present in api_usage';
  END;

  BEGIN
    SELECT COUNT(*) INTO v_total_bdl
    FROM api_usage
    WHERE LOWER(COALESCE(endpoint::TEXT, '')) LIKE '%balldontlie%';
    RAISE NOTICE '--- total BDL rows by endpoint column: % ---', v_total_bdl;
  EXCEPTION WHEN undefined_column THEN
    RAISE NOTICE 'endpoint column not present in api_usage';
  END;
END $$;
