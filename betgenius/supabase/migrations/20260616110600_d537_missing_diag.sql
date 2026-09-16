-- D-537 — diagnose why gamePk=823046 (STL @ SD) has 0 rec_cache picks.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §K — error_log for that game / period
  RAISE NOTICE '======== D-537 §K: error_log near scoring time 04:06 UTC ========';
  FOR r IN
    SELECT created_at, function_name, error_type, LEFT(error_message,150) AS msg
    FROM public.error_log
    WHERE created_at BETWEEN '2026-06-15 03:00:00+00' AND '2026-06-15 05:30:00+00'
      AND (function_name ILIKE '%process-games%' OR error_message ILIKE '%823046%'
           OR context::text ILIKE '%823046%' OR error_message ILIKE '%cardinals%'
           OR error_message ILIKE '%padres%')
    ORDER BY created_at DESC LIMIT 20
  LOOP RAISE NOTICE '[D-537 §K.1] %  fn=% type=% msg=%',
    r.created_at, r.function_name, r.error_type, r.msg; END LOOP;

  -- §L — props_cache for STL @ SD (search by team names)
  RAISE NOTICE '======== D-537 §L: props_cache rows for the missing game ========';
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='props_cache'
      AND (column_name IN ('player_name','prop_type','line','odds','pick_side','home_team','away_team'))
    ORDER BY column_name
  LOOP RAISE NOTICE '[D-537 §L.0] col: %', r.column_name; END LOOP;

  -- Look for any STL or SD team-related props on 2026-06-15
  FOR r IN
    SELECT home_team, away_team, count(*) AS n,
      count(DISTINCT player_name) AS distinct_players,
      count(DISTINCT prop_type) AS distinct_prop_types
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260615'
      AND (home_team ILIKE '%cardinals%' OR home_team ILIKE '%padres%'
           OR away_team ILIKE '%cardinals%' OR away_team ILIKE '%padres%')
    GROUP BY home_team, away_team
  LOOP RAISE NOTICE '[D-537 §L.1] home=% away=% n_props=% players=% prop_types=%',
    r.home_team, r.away_team, r.n, r.distinct_players, r.distinct_prop_types; END LOOP;

  -- Was there any pick attempted for this game in pick_history?
  RAISE NOTICE '======== D-537 §M: pick_history attempt for the missing game ========';
  FOR r IN
    SELECT team, opponent, count(*) AS n_picks, count(*) FILTER (WHERE voided) AS voided_count
    FROM public.pick_history
    WHERE sport='mlb' AND game_date IN ('20260615','2026-06-15')
      AND is_synthetic=false
      AND ((team ILIKE '%cardinals%' OR team ILIKE '%padres%')
        OR (opponent ILIKE '%cardinals%' OR opponent ILIKE '%padres%'))
    GROUP BY team, opponent ORDER BY team
  LOOP RAISE NOTICE '[D-537 §M.1] team=% opp=% n=% voided=%',
    r.team, r.opponent, r.n_picks, r.voided_count; END LOOP;

  -- All games' props_cache counts to see if STL@SD is a no-props situation
  RAISE NOTICE '======== D-537 §N: all 18 teams props_cache counts (compare to find STL/SD) ========';
  FOR r IN
    SELECT home_team, count(*) AS props
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260615'
    GROUP BY home_team ORDER BY home_team
  LOOP RAISE NOTICE '[D-537 §N.1] home_team=% props=%', r.home_team, r.props; END LOOP;
END $$;
