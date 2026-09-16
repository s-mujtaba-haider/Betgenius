-- D-719b pre-flight (read-only): unaccent feasibility + collision risk
SET statement_timeout = '120s';
DO $$ DECLARE rec record; n int;
BEGIN
  RAISE NOTICE '=== unaccent availability ===';
  SELECT count(*) INTO n FROM pg_available_extensions WHERE name='unaccent';
  RAISE NOTICE '  unaccent in pg_available_extensions: %', n;
  SELECT count(*) INTO n FROM pg_extension WHERE extname='unaccent';
  RAISE NOTICE '  unaccent currently installed: %', n;

  -- Need to install to run predictions. Install it inside a SAVEPOINT for preview.
  -- Actually simpler: install now and re-use in SHIP 2.
  IF n = 0 THEN
    CREATE EXTENSION IF NOT EXISTS unaccent;
    SELECT count(*) INTO n FROM pg_extension WHERE extname='unaccent';
    RAISE NOTICE '  unaccent installed in this txn: %', n;
  END IF;

  -- Smoke test the function
  RAISE NOTICE '  unaccent(''Andrés Chaparro'') = %', unaccent('Andrés Chaparro');
  RAISE NOTICE '  unaccent(''Adolís García'') = %', unaccent('Adolís García');

  -- Total state from D-719
  SELECT count(*) INTO n FROM pick_history WHERE sport='mlb' AND player_id IS NULL AND player_name IS NOT NULL;
  RAISE NOTICE '  pick_history null+real-or-team rows: %', n;

  -- Of NULL real-player-name rows (not team-strings), predict matches via unaccent
  RAISE NOTICE '=== Coverage prediction ===';

  -- Pool of accent-null distinct names (exclude team strings)
  SELECT count(DISTINCT player_name) INTO n FROM pick_history ph
    WHERE ph.sport='mlb' AND ph.player_id IS NULL
      AND ph.player_name IS NOT NULL
      AND ph.player_name NOT LIKE '% vs %';
  RAISE NOTICE '  distinct accent-null real names: %', n;

  -- Predicted recoverable via accent-insensitive UNIQUE match
  -- Uses HAVING COUNT(DISTINCT player_id)=1 so accent-collision (two different players whose
  -- names differ only by accent) stay NULL.
  SELECT count(DISTINCT ph.player_name) INTO n
  FROM pick_history ph
  WHERE ph.sport='mlb' AND ph.player_id IS NULL
    AND ph.player_name IS NOT NULL
    AND ph.player_name NOT LIKE '% vs %'
    AND EXISTS (
      SELECT 1 FROM (
        SELECT unaccent(lower(full_name)) AS k, COUNT(DISTINCT player_id) c
        FROM cache_mlb_player_metadata WHERE full_name IS NOT NULL
        GROUP BY unaccent(lower(full_name)) HAVING COUNT(DISTINCT player_id)=1
      ) m WHERE m.k = unaccent(lower(ph.player_name))
    );
  RAISE NOTICE '  distinct names recoverable via unique unaccent match: %', n;

  -- Predicted rows recoverable
  SELECT count(*) INTO n
  FROM pick_history ph
  WHERE ph.sport='mlb' AND ph.player_id IS NULL
    AND ph.player_name IS NOT NULL
    AND ph.player_name NOT LIKE '% vs %'
    AND EXISTS (
      SELECT 1 FROM (
        SELECT unaccent(lower(full_name)) AS k, COUNT(DISTINCT player_id) c
        FROM cache_mlb_player_metadata WHERE full_name IS NOT NULL
        GROUP BY unaccent(lower(full_name)) HAVING COUNT(DISTINCT player_id)=1
      ) m WHERE m.k = unaccent(lower(ph.player_name))
    );
  RAISE NOTICE '  ROWS predicted recoverable: %', n;

  -- Accent-collision audit: metadata entries where unaccent collapses 2+ distinct player_ids
  RAISE NOTICE '=== Accent collisions in metadata (different players, same unaccented name) ===';
  FOR rec IN
    SELECT unaccent(lower(full_name)) AS unaccented_key,
           array_agg(DISTINCT player_id ORDER BY player_id) AS ids,
           array_agg(DISTINCT full_name) AS names
    FROM cache_mlb_player_metadata WHERE full_name IS NOT NULL
    GROUP BY unaccent(lower(full_name))
    HAVING COUNT(DISTINCT player_id) > 1
  LOOP
    RAISE NOTICE '  collision unacc=% names=% ids=%', rec.unaccented_key, rec.names, rec.ids;
  END LOOP;

  -- Sample 10 names that WILL recover (sanity check)
  RAISE NOTICE '=== 10 sample names that will be recovered ===';
  FOR rec IN
    SELECT DISTINCT ph.player_name,
           (SELECT m.full_name FROM cache_mlb_player_metadata m
            WHERE unaccent(lower(m.full_name)) = unaccent(lower(ph.player_name)) LIMIT 1) AS metadata_name,
           (SELECT m.player_id FROM cache_mlb_player_metadata m
            WHERE unaccent(lower(m.full_name)) = unaccent(lower(ph.player_name)) LIMIT 1) AS would_assign_pid
    FROM pick_history ph
    WHERE ph.sport='mlb' AND ph.player_id IS NULL
      AND ph.player_name IS NOT NULL
      AND ph.player_name NOT LIKE '% vs %'
    LIMIT 10
  LOOP
    RAISE NOTICE '  ph=% → meta=% pid=%', rec.player_name, rec.metadata_name, rec.would_assign_pid;
  END LOOP;

  -- Sample 10 names that STILL won't match (residual)
  RAISE NOTICE '=== 10 sample residual unmatched (no metadata even with unaccent) ===';
  FOR rec IN
    SELECT DISTINCT ph.player_name FROM pick_history ph
    WHERE ph.sport='mlb' AND ph.player_id IS NULL
      AND ph.player_name IS NOT NULL
      AND ph.player_name NOT LIKE '% vs %'
      AND NOT EXISTS (
        SELECT 1 FROM cache_mlb_player_metadata m
        WHERE unaccent(lower(m.full_name)) = unaccent(lower(ph.player_name))
      )
    LIMIT 10
  LOOP
    RAISE NOTICE '  residual: %', rec.player_name;
  END LOOP;

  -- Confirm team-string + Max Muncy untouched intent
  SELECT count(*) INTO n FROM pick_history
    WHERE sport='mlb' AND player_id IS NULL AND player_name LIKE '% vs %';
  RAISE NOTICE '  team-string rows (intent: untouched): %', n;
  SELECT count(*) INTO n FROM pick_history WHERE sport='mlb' AND player_name='Max Muncy';
  RAISE NOTICE '  Max Muncy rows (intent: untouched): %', n;
END $$;

-- Rollback unaccent install so SHIP 2 owns the decision
-- (extension drop is unsafe if anyone uses it concurrently — leave installed if needed)
