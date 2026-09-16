-- Probe error_log schema to design structured logging helper (May 10, 2026).
DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE 'error_log columns:';
  FOR v_row IN
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'error_log'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  % %  null=% default=%',
      v_row.column_name, v_row.data_type, v_row.is_nullable,
      COALESCE(v_row.column_default, '(none)');
  END LOOP;
END $$;
