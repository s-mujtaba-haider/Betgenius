-- Inspect column types to fix the d538 RPC type mismatch.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public'
      AND column_name='game_date'
      AND table_name IN ('mlb_scoring_progress','cache_mlb_game_scoreboard',
                         'recommendations_cache','pick_history')
    ORDER BY table_name
  LOOP RAISE NOTICE 'tbl=% col=% type=%', r.table_name, r.column_name, r.data_type; END LOOP;
END $$;
