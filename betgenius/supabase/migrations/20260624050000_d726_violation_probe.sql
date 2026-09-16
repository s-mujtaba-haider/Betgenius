-- D-726 — Pre-flight violation probe. NO ALTER. NO writes. NOTICE only.
SET statement_timeout = '180s';
DO $$ DECLARE n int; rec record; total int;
BEGIN
  RAISE NOTICE '=== D-726 violation probe ===';

  SELECT count(*) INTO total FROM cache_mlb_boxscore_player_stats;
  RAISE NOTICE '  total rows in cache_mlb_boxscore_player_stats: %', total;

  -- I1: strikeouts ≤ batters_faced (pitcher invariant)
  SELECT count(*) INTO n FROM cache_mlb_boxscore_player_stats
    WHERE strikeouts IS NOT NULL AND batters_faced IS NOT NULL
      AND strikeouts > batters_faced;
  RAISE NOTICE '  I1 strikeouts > batters_faced: % violations', n;
  IF n > 0 THEN
    FOR rec IN
      SELECT player_id, player_name, game_pk, game_date, strikeouts, batters_faced
      FROM cache_mlb_boxscore_player_stats
      WHERE strikeouts IS NOT NULL AND batters_faced IS NOT NULL
        AND strikeouts > batters_faced
      ORDER BY game_date DESC LIMIT 5
    LOOP
      RAISE NOTICE '    pid=% name=% gpk=% date=% K=% BF=%',
        rec.player_id, rec.player_name, rec.game_pk, rec.game_date, rec.strikeouts, rec.batters_faced;
    END LOOP;
  END IF;

  -- I2: total_bases ≥ hits (batter — a hit is worth ≥1 base)
  SELECT count(*) INTO n FROM cache_mlb_boxscore_player_stats
    WHERE total_bases IS NOT NULL AND hits IS NOT NULL
      AND total_bases < hits;
  RAISE NOTICE '  I2 total_bases < hits: % violations', n;
  IF n > 0 THEN
    FOR rec IN
      SELECT player_id, player_name, game_pk, game_date, total_bases, hits
      FROM cache_mlb_boxscore_player_stats
      WHERE total_bases IS NOT NULL AND hits IS NOT NULL
        AND total_bases < hits
      ORDER BY game_date DESC LIMIT 5
    LOOP
      RAISE NOTICE '    pid=% name=% gpk=% date=% TB=% H=%',
        rec.player_id, rec.player_name, rec.game_pk, rec.game_date, rec.total_bases, rec.hits;
    END LOOP;
  END IF;

  -- I3: home_runs ≤ hits (a HR is a hit)
  SELECT count(*) INTO n FROM cache_mlb_boxscore_player_stats
    WHERE home_runs IS NOT NULL AND hits IS NOT NULL
      AND home_runs > hits;
  RAISE NOTICE '  I3 home_runs > hits: % violations', n;
  IF n > 0 THEN
    FOR rec IN
      SELECT player_id, player_name, game_pk, game_date, home_runs, hits
      FROM cache_mlb_boxscore_player_stats
      WHERE home_runs IS NOT NULL AND hits IS NOT NULL
        AND home_runs > hits
      ORDER BY game_date DESC LIMIT 5
    LOOP
      RAISE NOTICE '    pid=% name=% gpk=% date=% HR=% H=%',
        rec.player_id, rec.player_name, rec.game_pk, rec.game_date, rec.home_runs, rec.hits;
    END LOOP;
  END IF;

  -- I4: hits ≤ at_bats
  SELECT count(*) INTO n FROM cache_mlb_boxscore_player_stats
    WHERE hits IS NOT NULL AND at_bats IS NOT NULL
      AND hits > at_bats;
  RAISE NOTICE '  I4 hits > at_bats: % violations', n;
  IF n > 0 THEN
    FOR rec IN
      SELECT player_id, player_name, game_pk, game_date, hits, at_bats
      FROM cache_mlb_boxscore_player_stats
      WHERE hits IS NOT NULL AND at_bats IS NOT NULL
        AND hits > at_bats
      ORDER BY game_date DESC LIMIT 5
    LOOP
      RAISE NOTICE '    pid=% name=% gpk=% date=% H=% AB=%',
        rec.player_id, rec.player_name, rec.game_pk, rec.game_date, rec.hits, rec.at_bats;
    END LOOP;
  END IF;

  -- I5: pick_history.confidence in 0..100
  SELECT count(*) INTO total FROM pick_history;
  RAISE NOTICE '  total rows in pick_history: %', total;
  SELECT count(*) INTO n FROM pick_history
    WHERE confidence IS NOT NULL AND (confidence < 0 OR confidence > 100);
  RAISE NOTICE '  I5 confidence outside [0,100]: % violations', n;
  IF n > 0 THEN
    FOR rec IN
      SELECT id, player_name, confidence, sport, game_date
      FROM pick_history
      WHERE confidence IS NOT NULL AND (confidence < 0 OR confidence > 100)
      ORDER BY game_date DESC LIMIT 5
    LOOP
      RAISE NOTICE '    id=% name=% conf=% sport=% date=%',
        rec.id, rec.player_name, rec.confidence, rec.sport, rec.game_date;
    END LOOP;
  END IF;

  -- I6: NOT (voided=true AND resolved_at IS NULL)
  -- D-718 finding: voidPick writes voided=true + resolved_at, but historical paths may differ.
  SELECT count(*) INTO n FROM pick_history
    WHERE voided = true AND resolved_at IS NULL;
  RAISE NOTICE '  I6 voided=true AND resolved_at IS NULL: % violations', n;
  IF n > 0 THEN
    FOR rec IN
      SELECT id, player_name, sport, voided, resolved_at, game_date
      FROM pick_history
      WHERE voided = true AND resolved_at IS NULL
      ORDER BY game_date DESC LIMIT 5
    LOOP
      RAISE NOTICE '    id=% name=% sport=% voided=% resolved_at=% date=%',
        rec.id, rec.player_name, rec.sport, rec.voided, rec.resolved_at, rec.game_date;
    END LOOP;
  END IF;

  -- I7: innings_pitched sanity bound (if column exists)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='cache_mlb_boxscore_player_stats'
               AND column_name='innings_pitched') THEN
    SELECT count(*) INTO n FROM cache_mlb_boxscore_player_stats
      WHERE innings_pitched IS NOT NULL AND (innings_pitched < 0 OR innings_pitched > 30);
    RAISE NOTICE '  I7 innings_pitched outside [0,30]: % violations', n;
    IF n > 0 THEN
      FOR rec IN
        SELECT player_id, game_pk, game_date, innings_pitched
        FROM cache_mlb_boxscore_player_stats
        WHERE innings_pitched IS NOT NULL AND (innings_pitched < 0 OR innings_pitched > 30)
        ORDER BY game_date DESC LIMIT 5
      LOOP
        RAISE NOTICE '    pid=% gpk=% date=% IP=%', rec.player_id, rec.game_pk, rec.game_date, rec.innings_pitched;
      END LOOP;
    END IF;
  END IF;

  -- I8: batters_faced non-negative sanity
  SELECT count(*) INTO n FROM cache_mlb_boxscore_player_stats
    WHERE batters_faced IS NOT NULL AND batters_faced < 0;
  RAISE NOTICE '  I8 batters_faced < 0: % violations', n;

  -- I9: at_bats non-negative
  SELECT count(*) INTO n FROM cache_mlb_boxscore_player_stats
    WHERE at_bats IS NOT NULL AND at_bats < 0;
  RAISE NOTICE '  I9 at_bats < 0: % violations', n;

  RAISE NOTICE '=== End probe ===';
END $$;
