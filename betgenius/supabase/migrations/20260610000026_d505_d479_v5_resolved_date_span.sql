DO $$
DECLARE r RECORD;
BEGIN
  -- All resolved picks date span
  RAISE NOTICE '[D-505] pick_history_real date span overall (any pick):';
  FOR r IN
    SELECT min(game_date) AS first_d, max(game_date) AS last_d,
           count(*) AS total_resolved
    FROM public.pick_history_real WHERE is_synthetic = false
  LOOP
    RAISE NOTICE '  first=% last=% total=%', r.first_d, r.last_d, r.total_resolved;
  END LOOP;

  -- All-OVER (any conf) at +100, by month
  RAISE NOTICE '[D-505] longshot-OVER (any conf) by month (sport=mlb only):';
  FOR r IN
    SELECT date_trunc('month', game_date)::date AS month, count(*) AS n
    FROM public.pick_history_real
    WHERE pick_side='over' AND odds >= 100
      AND is_synthetic = false AND sport='mlb'
    GROUP BY month ORDER BY month
  LOOP
    RAISE NOTICE '  mlb month=% n=%', r.month, r.n;
  END LOOP;

  -- And NBA
  RAISE NOTICE '[D-505] longshot-OVER (any conf) by month (sport=nba only):';
  FOR r IN
    SELECT date_trunc('month', game_date)::date AS month, count(*) AS n
    FROM public.pick_history_real
    WHERE pick_side='over' AND odds >= 100
      AND is_synthetic = false AND sport='nba'
    GROUP BY month ORDER BY month
  LOOP
    RAISE NOTICE '  nba month=% n=%', r.month, r.n;
  END LOOP;

  -- Date span of post-D-479 GOOD-tier OVER (no odds filter to confirm)
  RAISE NOTICE '[D-505] post-2026-06-08 GOOD-tier OVER (NO odds filter) date span:';
  FOR r IN
    SELECT count(*) AS n, min(game_date) AS first_d, max(game_date) AS last_d,
           min(odds) AS min_odds, max(odds) AS max_odds
    FROM public.pick_history_real
    WHERE confidence BETWEEN 65 AND 79
      AND pick_side='over' AND is_synthetic = false
      AND game_date >= DATE '2026-06-08'
  LOOP
    RAISE NOTICE '  n=% first=% last=% min_odds=% max_odds=%', r.n, r.first_d, r.last_d, r.min_odds, r.max_odds;
  END LOOP;

  -- Same but for GOOD-tier UNDER (D-479 cap is OVER-only)
  RAISE NOTICE '[D-505] post-2026-06-08 GOOD-tier UNDER at +100 (sanity, not capped):';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins
    FROM public.pick_history_real
    WHERE confidence BETWEEN 65 AND 79
      AND pick_side='under' AND odds >= 100
      AND is_synthetic = false
      AND game_date >= DATE '2026-06-08'
  LOOP
    RAISE NOTICE '  n=% wins=%', r.n, r.wins;
  END LOOP;
END $$;
