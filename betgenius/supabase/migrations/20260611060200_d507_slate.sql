DO $$
DECLARE v_today TEXT; v_yest TEXT;
        v_scoring BIGINT; v_scoreboard BIGINT;
BEGIN
  v_today := to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYY-MM-DD');
  v_yest  := to_char((NOW() AT TIME ZONE 'America/New_York')::DATE - 1, 'YYYY-MM-DD');

  SELECT count(*) INTO v_scoring FROM public.mlb_scoring_progress
   WHERE game_date::text = v_today OR game_date::text = replace(v_today,'-','');
  SELECT count(*) INTO v_scoreboard FROM public.cache_mlb_game_scoreboard
   WHERE game_date::text = v_today OR game_date::text = replace(v_today,'-','');
  RAISE NOTICE '[D-507 slate] today_ET=% scoring_progress=% cache_scoreboard=%',
    v_today, v_scoring, v_scoreboard;

  SELECT count(*) INTO v_scoring FROM public.mlb_scoring_progress
   WHERE game_date::text = v_yest OR game_date::text = replace(v_yest,'-','');
  SELECT count(*) INTO v_scoreboard FROM public.cache_mlb_game_scoreboard
   WHERE game_date::text = v_yest OR game_date::text = replace(v_yest,'-','');
  RAISE NOTICE '[D-507 slate] yesterday=% scoring_progress=% cache_scoreboard=%',
    v_yest, v_scoring, v_scoreboard;

  -- distinct game_date values in mlb_scoring_progress so we know the format
  DECLARE r RECORD;
  BEGIN
    RAISE NOTICE '[D-507 slate] last 3 game_date values in mlb_scoring_progress:';
    FOR r IN
      SELECT DISTINCT game_date FROM public.mlb_scoring_progress
      ORDER BY game_date DESC LIMIT 3
    LOOP RAISE NOTICE '  game_date=%', r.game_date; END LOOP;
  END;
END $$;
