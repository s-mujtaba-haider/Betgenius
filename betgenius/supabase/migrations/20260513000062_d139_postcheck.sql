DO $$
DECLARE c INT; w NUMERIC; r RECORD;
BEGIN
  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_game_lines' AND column_name='spread_line_t0';
  RAISE NOTICE 'cache_game_lines.spread_line_t0 exists: %', c;

  SELECT COUNT(*) INTO c FROM information_schema.triggers
    WHERE event_object_table='cache_game_lines';
  RAISE NOTICE 'cache_game_lines triggers count: %', c;
  FOR r IN SELECT trigger_name FROM information_schema.triggers WHERE event_object_table='cache_game_lines' LOOP
    RAISE NOTICE '  trigger=%', r.trigger_name;
  END LOOP;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name='score_line_movement';
  RAISE NOTICE 'pick_history.score_line_movement exists: %', c;

  SELECT w_line_movement INTO w FROM algorithm_weights WHERE id=1;
  RAISE NOTICE 'algorithm_weights.w_line_movement @ id=1: %', w;

  RAISE NOTICE '=== sample cache_game_lines rows ===';
  FOR r IN
    SELECT event_id, spread_line, spread_line_t0, fetched_at
    FROM cache_game_lines ORDER BY fetched_at DESC LIMIT 5
  LOOP
    RAISE NOTICE 'event=% spread=% t0=% fetched=%',
      LEFT(r.event_id, 20), r.spread_line, r.spread_line_t0, r.fetched_at;
  END LOOP;
END $$;
