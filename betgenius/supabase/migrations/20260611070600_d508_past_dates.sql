DO $$
DECLARE r RECORD;
BEGIN
  -- mlb_scoring_progress per game_date last 5 days
  RAISE NOTICE '[D-508] mlb_scoring_progress per game_date:';
  FOR r IN
    SELECT game_date, count(*) AS n_marked, max(scored_at) AS last_marked
    FROM public.mlb_scoring_progress
    WHERE game_date >= '20260606'
    GROUP BY game_date ORDER BY game_date DESC
  LOOP RAISE NOTICE '  game_date=% n_marked=% last_marked=%', r.game_date, r.n_marked, r.last_marked; END LOOP;
END $$;
