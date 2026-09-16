-- Read-only schema probe — cache_player_game_logs timestamp columns
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_player_game_logs'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE 'col=% type=%', RPAD(r.column_name, 20), r.data_type;
  END LOOP;
END $$;
