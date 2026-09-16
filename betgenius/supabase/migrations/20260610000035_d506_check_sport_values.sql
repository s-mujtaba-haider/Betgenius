DO $$
DECLARE r RECORD;
BEGIN
  -- Distinct sport values + counts on stalled picks
  RAISE NOTICE '[D-506] distinct sport on stalled picks since 2026-05-30:';
  FOR r IN
    SELECT COALESCE(sport, '<null>') AS s, count(*) AS n
    FROM public.pick_history
    WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
      AND is_synthetic = false AND game_date >= DATE '2026-05-30'
    GROUP BY sport ORDER BY n DESC
  LOOP
    RAISE NOTICE '  sport=% n=%', r.s, r.n;
  END LOOP;

  -- Simulate resolve-picks query (default body: limit=200, since_days=14)
  -- Cutoff today = 2026-06-10; since_days=14 → cutoff date = 2026-05-27
  RAISE NOTICE '[D-506] simulating resolve-picks default query (oldest 200, cutoff 2026-05-27):';
  FOR r IN
    SELECT COALESCE(sport, '<null>') AS s, count(*) AS n
    FROM (
      SELECT sport
      FROM public.pick_history
      WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
        AND game_date >= DATE '2026-05-27'
      ORDER BY created_at ASC LIMIT 200
    ) sub
    GROUP BY sport ORDER BY n DESC
  LOOP
    RAISE NOTICE '  oldest_200 sport=% n=%', r.s, r.n;
  END LOOP;

  -- What's the date span of those oldest 200?
  RAISE NOTICE '[D-506] oldest 200 (cutoff 2026-05-27) date span:';
  FOR r IN
    SELECT min(created_at) AS earliest_created, max(created_at) AS latest_created,
           min(game_date) AS earliest_game, max(game_date) AS latest_game
    FROM (
      SELECT created_at, game_date
      FROM public.pick_history
      WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
        AND game_date >= DATE '2026-05-27'
      ORDER BY created_at ASC LIMIT 200
    ) sub
  LOOP
    RAISE NOTICE '  created: % → %  | game_date: % → %',
      r.earliest_created, r.latest_created, r.earliest_game, r.latest_game;
  END LOOP;

  -- What about a sport sample row to see all the fields
  RAISE NOTICE '[D-506] oldest 3 candidate rows (all fields used by resolve-picks):';
  FOR r IN
    SELECT id, player_name, prop_type, line, pick_side, game_time, created_at,
           sport, opponent, mlb_market_type, game_date, is_home, team
    FROM public.pick_history
    WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
      AND game_date >= DATE '2026-05-27' AND is_synthetic = false
    ORDER BY created_at ASC LIMIT 3
  LOOP
    RAISE NOTICE '  id=% player=% prop=% sport=% market=% team=% opp=% gd=% gt=%',
      r.id, r.player_name, r.prop_type, COALESCE(r.sport, '<null>'),
      COALESCE(r.mlb_market_type, '<null>'), COALESCE(r.team, '<null>'),
      COALESCE(r.opponent, '<null>'), r.game_date, r.game_time;
  END LOOP;
END $$;
