SET statement_timeout = '180s';
DO $$ DECLARE rec record; n int;
BEGIN
  -- 1. cache_mlb_player_metadata schema
  RAISE NOTICE '=== cache_mlb_player_metadata schema ===';
  FOR rec IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_mlb_player_metadata'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  %  %  null=%', rec.column_name, rec.data_type, rec.is_nullable;
  END LOOP;

  -- 2. Total rows + name format sample
  SELECT count(*) INTO n FROM cache_mlb_player_metadata;
  RAISE NOTICE '  total metadata rows: %', n;

  RAISE NOTICE '=== Sample name formats in cache_mlb_player_metadata (5) ===';
  FOR rec IN
    SELECT player_id, full_name FROM cache_mlb_player_metadata
    WHERE full_name IS NOT NULL ORDER BY player_id LIMIT 5
  LOOP
    RAISE NOTICE '  pid=% full_name=%', rec.player_id, rec.full_name;
  END LOOP;

  -- 3. Total distinct pick_history.player_name values
  SELECT count(DISTINCT player_name) INTO n FROM pick_history WHERE sport='mlb' AND player_name IS NOT NULL;
  RAISE NOTICE '  distinct MLB player_names in pick_history: %', n;

  -- 4. Exact-match coverage
  SELECT count(DISTINCT ph.player_name)
    INTO n
    FROM pick_history ph
    JOIN cache_mlb_player_metadata m ON m.full_name = ph.player_name
    WHERE ph.sport='mlb' AND ph.player_name IS NOT NULL;
  RAISE NOTICE '  EXACT-match distinct names: %', n;

  -- 5. Row-level exact match
  SELECT count(*) INTO n FROM pick_history ph
    JOIN cache_mlb_player_metadata m ON m.full_name = ph.player_name
    WHERE ph.sport='mlb' AND ph.player_name IS NOT NULL;
  RAISE NOTICE '  EXACT-match pick_history rows: %', n;

  -- Total MLB picks for ratio
  SELECT count(*) INTO n FROM pick_history WHERE sport='mlb' AND player_name IS NOT NULL;
  RAISE NOTICE '  total MLB pick rows with player_name: %', n;

  -- 6. Sample of unmatched names (10) — these are candidates for normalizer bridging
  RAISE NOTICE '=== 10 distinct unmatched names (likely accent/format issues) ===';
  FOR rec IN
    SELECT DISTINCT ph.player_name
    FROM pick_history ph
    LEFT JOIN cache_mlb_player_metadata m ON m.full_name = ph.player_name
    WHERE ph.sport='mlb' AND ph.player_name IS NOT NULL AND m.player_id IS NULL
    ORDER BY ph.player_name
    LIMIT 10
  LOOP
    RAISE NOTICE '  unmatched: %', rec.player_name;
  END LOOP;

  -- 7. Does cache_mlb_player_metadata have unique player_id?
  RAISE NOTICE '=== player_id uniqueness in metadata ===';
  SELECT count(*) INTO n FROM (
    SELECT player_id, count(*) c FROM cache_mlb_player_metadata GROUP BY player_id HAVING count(*) > 1
  ) s;
  RAISE NOTICE '  player_ids with multiple rows: %', n;

  -- 8. Does cache_mlb_player_metadata have unique full_name? (for clean joining)
  SELECT count(*) INTO n FROM (
    SELECT full_name, count(*) c FROM cache_mlb_player_metadata
    WHERE full_name IS NOT NULL GROUP BY full_name HAVING count(*) > 1
  ) s;
  RAISE NOTICE '  full_names with multiple player_ids (collisions): %', n;

  -- 9. confirm pick_history has no player_id column yet
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name='player_id';
  RAISE NOTICE '  pick_history.player_id column exists: %', n;
END $$;
