SET statement_timeout = '60s';
DO $$ DECLARE rec record;
BEGIN
  RAISE NOTICE '=== Tables with player_name OR player_id columns ===';
  FOR rec IN
    SELECT c.table_name,
           bool_or(c.column_name='player_id') AS has_player_id,
           bool_or(c.column_name='player_name') AS has_player_name,
           string_agg(c.column_name, ',' ORDER BY c.column_name) FILTER (WHERE c.column_name IN ('player_id','player_name','team_id','team','game_pk','event_id','game_date')) AS id_cols
    FROM information_schema.columns c
    WHERE c.table_schema='public'
      AND (c.column_name LIKE '%player_%' OR c.column_name IN ('team_id','team','game_pk','event_id'))
    GROUP BY c.table_name
    ORDER BY c.table_name
  LOOP
    RAISE NOTICE '  % has_pid=% has_pname=% cols=%', rec.table_name, rec.has_player_id, rec.has_player_name, rec.id_cols;
  END LOOP;

  RAISE NOTICE '=== Schema sample: cache_mlb_boxscore_player_stats columns ===';
  FOR rec IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns WHERE table_schema='public' AND table_name='cache_mlb_boxscore_player_stats'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  %  %  null=%', rec.column_name, rec.data_type, rec.is_nullable;
  END LOOP;

  RAISE NOTICE '=== pick_history columns relevant to grading ===';
  FOR rec IN
    SELECT column_name, data_type
    FROM information_schema.columns WHERE table_schema='public' AND table_name='pick_history'
      AND column_name IN ('player_name','player_id','mlb_player_id','team','team_id','opponent','game_date','game_time','game_pk','event_id','mlb_market_type','prop_type','line','pick_side','actual_value','hit','resolved_at','voided')
    ORDER BY column_name
  LOOP
    RAISE NOTICE '  %  %', rec.column_name, rec.data_type;
  END LOOP;

  RAISE NOTICE '=== Constraints on pick_history (CHECK only) ===';
  FOR rec IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.pick_history'::regclass AND contype='c'
  LOOP
    RAISE NOTICE '  % | %', rec.conname, rec.definition;
  END LOOP;

  RAISE NOTICE '=== Constraints on cache_mlb_boxscore_player_stats (CHECK only) ===';
  FOR rec IN
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.cache_mlb_boxscore_player_stats'::regclass AND contype='c'
  LOOP
    RAISE NOTICE '  % | %', rec.conname, rec.definition;
  END LOOP;

  RAISE NOTICE '=== Indexes on pick_history (key resolution paths) ===';
  FOR rec IN
    SELECT indexname, indexdef
    FROM pg_indexes WHERE schemaname='public' AND tablename='pick_history'
  LOOP
    RAISE NOTICE '  %', rec.indexname;
    RAISE NOTICE '    %', rec.indexdef;
  END LOOP;
END $$;
