SET statement_timeout = '20s';
DO $$ DECLARE rec record; n int;
BEGIN
  RAISE NOTICE '=== unaccent extension status ===';
  SELECT count(*) INTO n FROM pg_extension WHERE extname='unaccent';
  RAISE NOTICE '  unaccent installed: %', n;

  -- The 1 colliding full_name
  RAISE NOTICE '=== full_name collisions in metadata (multiple player_ids per name) ===';
  FOR rec IN
    SELECT full_name, count(*) c, array_agg(player_id ORDER BY player_id) ids
    FROM cache_mlb_player_metadata
    WHERE full_name IS NOT NULL
    GROUP BY full_name HAVING count(*) > 1
  LOOP
    RAISE NOTICE '  collision: % → ids=%', rec.full_name, rec.ids;
  END LOOP;

  -- Check if pick_history.team field could disambiguate (does it always contain MLB team name?)
  RAISE NOTICE '=== Sample pick_history.team values ===';
  FOR rec IN
    SELECT DISTINCT team FROM pick_history WHERE sport='mlb' AND team IS NOT NULL AND team <> '' LIMIT 10
  LOOP
    RAISE NOTICE '  team: %', rec.team;
  END LOOP;
END $$;
