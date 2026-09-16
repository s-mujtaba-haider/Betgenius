-- Read-only D-139 pre-audit. KEPT on disk after read to avoid the
-- migration-tracker drift the D-138 delete-after-read pattern caused.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name LIKE '%line_movement%';
  RAISE NOTICE 'pick_history line_movement cols: %', n;

  SELECT COUNT(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_game_lines' AND column_name='spread_line_t0';
  RAISE NOTICE 'cache_game_lines.spread_line_t0 exists: %', n;

  SELECT COUNT(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='algorithm_weights' AND column_name='w_line_movement';
  RAISE NOTICE 'algorithm_weights.w_line_movement exists: %', n;

  SELECT COUNT(*) INTO n FROM information_schema.triggers
    WHERE event_object_table='cache_game_lines';
  RAISE NOTICE 'cache_game_lines triggers count: %', n;
END $$;
