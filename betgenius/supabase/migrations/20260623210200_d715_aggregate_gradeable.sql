SET statement_timeout = '180s';
DO $$ DECLARE rec record; total int; with_box int; without_box int;
BEGIN
  -- MLB total non-synth ancient
  SELECT count(*) INTO total FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport = 'mlb';
  RAISE NOTICE 'Non-synth MLB 14+d unresolved total: %', total;

  -- How many have a box score match by player_name + game_date?
  SELECT count(*) INTO with_box FROM pick_history p
    WHERE p.hit IS NULL AND p.created_at <= NOW() - INTERVAL '14 days'
      AND p.is_synthetic = false AND p.sport = 'mlb'
      AND EXISTS (
        SELECT 1 FROM cache_mlb_boxscore_player_stats b
        WHERE b.player_name = p.player_name AND b.game_date = p.game_date
      );
  RAISE NOTICE 'Non-synth MLB 14+d WITH box score (name+date match): % of %', with_box, total;
  RAISE NOTICE '  → potentially gradeable if resolver runs: %', with_box;
  RAISE NOTICE '  → truly missing data: %', total - with_box;

  -- For ones WITHOUT exact match, try checking if there's a player with similar name on that date
  -- (name format issues like "Pomeranz, Drew" vs "Drew Pomeranz")
  -- Count picks whose player_name's last-token matches a boxscore player on that date
  RAISE NOTICE '=== Name format check: do any "no match" picks have name reversal issues? ===';
  -- Sample picks where exact match failed
  FOR rec IN
    SELECT p.id, p.player_name, p.game_date, p.mlb_market_type
    FROM pick_history p
    WHERE p.hit IS NULL AND p.created_at <= NOW() - INTERVAL '14 days'
      AND p.is_synthetic = false AND p.sport = 'mlb'
      AND NOT EXISTS (
        SELECT 1 FROM cache_mlb_boxscore_player_stats b
        WHERE b.player_name = p.player_name AND b.game_date = p.game_date
      )
    LIMIT 10
  LOOP
    RAISE NOTICE '  no-match pick: id=% name=% date=% market=%',
      substring(rec.id::text,1,8), rec.player_name, rec.game_date, rec.mlb_market_type;
  END LOOP;

  -- NBA market distribution
  RAISE NOTICE '=== NBA non-synth ancient by market ===';
  FOR rec IN
    SELECT prop_type, count(*) AS n
    FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport = 'nba'
    GROUP BY prop_type ORDER BY n DESC
  LOOP
    RAISE NOTICE '  %  n=%', rec.prop_type, rec.n;
  END LOOP;

  -- For NBA, what sources are these from?
  RAISE NOTICE '=== NBA non-synth ancient by source ===';
  FOR rec IN
    SELECT source, count(*) AS n
    FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport = 'nba'
    GROUP BY source ORDER BY n DESC
  LOOP
    RAISE NOTICE '  source=% n=%', rec.source, rec.n;
  END LOOP;

  -- For non-MLB-resolver markets ('threes' isn't standard NBA prop_type — check schema)
  -- Look at NBA resolution_note text patterns
  RAISE NOTICE '=== NBA non-synth ancient with non-null resolution_note ===';
  FOR rec IN
    SELECT resolution_note, count(*) AS n
    FROM pick_history
    WHERE hit IS NULL AND created_at <= NOW() - INTERVAL '14 days'
      AND is_synthetic = false AND sport = 'nba'
      AND resolution_note IS NOT NULL
    GROUP BY resolution_note ORDER BY n DESC LIMIT 10
  LOOP
    RAISE NOTICE '  note=% n=%', rec.resolution_note, rec.n;
  END LOOP;
END $$;
