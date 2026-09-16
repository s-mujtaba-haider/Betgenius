-- Read-only confirmation probe for D-133 Fix A audit.
-- Validate the dedup hypothesis: props_cache holds TWO rows per (player,
-- prop_type) — one per side — and the under-side row's odds is positive
-- with magnitude < 200 (the dog price for a favored-over trivial).
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== TASK 2 schema probe (find timestamp + odds columns) ===';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='props_cache'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE 'col=% type=%', RPAD(r.column_name, 22), r.data_type;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== props_cache rows for Evan Mobley steals (most recent game) ===';
  FOR r IN
    SELECT player_name, prop_type, pick_side, line, odds, bookmaker, game_date
    FROM props_cache
    WHERE player_name ILIKE 'Evan Mobley'
      AND prop_type ILIKE '%steals%'
    ORDER BY game_date DESC, bookmaker, pick_side
    LIMIT 30
  LOOP
    RAISE NOTICE 'gd=% bookmaker=% prop=% side=% line=% odds=%',
      r.game_date, RPAD(COALESCE(r.bookmaker, 'NULL'), 14),
      RPAD(r.prop_type, 14), RPAD(r.pick_side, 6), r.line, r.odds;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Other 3 failing picks (over-side trivials) ===';
  FOR r IN
    SELECT player_name, prop_type, pick_side, line, odds, bookmaker, game_date
    FROM props_cache
    WHERE (player_name ILIKE 'Duncan Robinson' AND prop_type ILIKE '%steals%')
       OR (player_name ILIKE 'Jarrett Allen' AND prop_type ILIKE '%steals%')
       OR (player_name ILIKE 'Ausar Thompson' AND prop_type ILIKE '%blocks%')
    ORDER BY player_name, game_date DESC, bookmaker, pick_side
    LIMIT 60
  LOOP
    RAISE NOTICE 'player=% gd=% book=% side=% line=% odds=%',
      RPAD(r.player_name, 18), r.game_date,
      RPAD(COALESCE(r.bookmaker, 'NULL'), 14),
      RPAD(r.pick_side, 6), r.line, r.odds;
  END LOOP;
END $$;
