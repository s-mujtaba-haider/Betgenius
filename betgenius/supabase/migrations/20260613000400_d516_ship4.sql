DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- §4a — eligibility: are there picks for game_dates that have NO props_cache?
  RAISE NOTICE '[D-516 §4a] eligibility: picks for game_dates with empty props_cache (last 3 days):';
  FOR r IN
    WITH gd AS (
      SELECT DISTINCT to_char(game_date, 'YYYYMMDD') AS gd
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 3
    )
    SELECT gd.gd,
           (SELECT count(*) FROM public.props_cache pc
             WHERE pc.sport='mlb' AND pc.game_date = gd.gd) AS props_n,
           (SELECT count(*) FROM public.pick_history ph
             WHERE ph.sport='mlb' AND ph.is_synthetic=false
               AND to_char(ph.game_date, 'YYYYMMDD') = gd.gd) AS picks_n
    FROM gd ORDER BY gd.gd DESC
  LOOP RAISE NOTICE '  gd=% props_count=% picks_count=%', r.gd, r.props_n, r.picks_n; END LOOP;

  -- §4b — dup check: same (player, market, line, side, game_date) appearing multiple times?
  RAISE NOTICE '[D-516 §4b] dup check — multiple pick_history rows for same (player+market+line+side+game_date):';
  FOR r IN
    SELECT player_name, mlb_market_type, line, pick_side, game_date,
           count(*) AS dup_n,
           array_agg(DISTINCT confidence ORDER BY confidence DESC) AS confs
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 2
    GROUP BY player_name, mlb_market_type, line, pick_side, game_date
    HAVING count(*) > 1
    ORDER BY dup_n DESC LIMIT 10
  LOOP RAISE NOTICE '  player=% market=% line=% side=% gd=% dup_n=% confs=%',
    r.player_name, r.mlb_market_type, r.line, r.pick_side, r.game_date, r.dup_n, r.confs; END LOOP;

  RAISE NOTICE '[D-516 §4b2] total dup-key violations last 2 days:';
  FOR r IN
    SELECT count(*) AS n FROM (
      SELECT 1 FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 2
      GROUP BY player_name, mlb_market_type, line, pick_side, game_date
      HAVING count(*) > 1
    ) x
  LOOP RAISE NOTICE '  dup_key_violation_count=%', r.n; END LOOP;

  -- §4c — early-scoring junk: any picks created BEFORE props_cache had the game's row?
  RAISE NOTICE '[D-516 §4c] early-scoring check: today picks created_at vs first props_cache row:';
  FOR r IN
    SELECT 'first_pick' AS kind, min(created_at) AS at FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE
    UNION ALL
    SELECT 'first_prop', min(first_seen) FROM public.props_cache
    WHERE sport='mlb' AND game_date = to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD')
  LOOP RAISE NOTICE '  %=%', r.kind, r.at; END LOOP;

  -- §4d — same-game distinct game_pks marked vs in props (consistency)
  RAISE NOTICE '[D-516 §4d] today scored count: markers=% scheduled=% picks_distinct_matchups=%',
    (SELECT count(*) FROM public.mlb_scoring_progress
      WHERE game_date = to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD')),
    (SELECT count(DISTINCT home_team || '|' || away_team) FROM public.props_cache
      WHERE sport='mlb' AND game_date = to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD')),
    (SELECT count(DISTINCT LEAST(team, opponent) || '|' || GREATEST(team, opponent))
       FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE);
END $$;
