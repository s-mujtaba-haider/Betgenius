DO $$
DECLARE r RECORD;
BEGIN
  -- Tomorrow's props_cache and scoring_progress
  RAISE NOTICE '[D-508] props_cache count for tomorrow (20260612):';
  FOR r IN
    SELECT count(*) AS n_props,
           count(DISTINCT (home_team || '|' || away_team)) AS n_matchups
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260612'
  LOOP RAISE NOTICE '  props=% matchups=%', r.n_props, r.n_matchups; END LOOP;

  RAISE NOTICE '[D-508] mlb_scoring_progress for tomorrow:';
  FOR r IN
    SELECT count(*) AS n FROM public.mlb_scoring_progress
    WHERE game_date='20260612'
  LOOP RAISE NOTICE '  rows=%', r.n; END LOOP;

  -- Today's mlb_scoring_progress detail
  RAISE NOTICE '[D-508] today (20260611) mlb_scoring_progress detail:';
  FOR r IN
    SELECT game_pk, tick_label, scored_at FROM public.mlb_scoring_progress
    WHERE game_date='20260611' ORDER BY scored_at LIMIT 10
  LOOP RAISE NOTICE '  game_pk=% tick=% scored_at=%', r.game_pk, r.tick_label, r.scored_at; END LOOP;

  -- Per-matchup props_cache for today (so we know what volume capping would have looked like)
  RAISE NOTICE '[D-508] today (20260611) per-matchup props count:';
  FOR r IN
    SELECT home_team, away_team, count(*) AS n_props
    FROM public.props_cache
    WHERE sport='mlb' AND game_date='20260611'
    GROUP BY home_team, away_team ORDER BY n_props DESC LIMIT 20
  LOOP RAISE NOTICE '  %|% props=% projected_picks=%',
    r.home_team, r.away_team, r.n_props, CEIL(r.n_props * 0.065); END LOOP;
END $$;
