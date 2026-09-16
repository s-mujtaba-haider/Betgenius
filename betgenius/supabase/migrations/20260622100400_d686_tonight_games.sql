DO $$
DECLARE r RECORD; v_n INT; v_now TIMESTAMPTZ := NOW();
  v_cutoff TIMESTAMPTZ := (NOW() AT TIME ZONE 'UTC')::date::TIMESTAMP + INTERVAL '22 hours 30 minutes';
BEGIN
  RAISE NOTICE 'NOW=%, cutoff=%', v_now, v_cutoff;

  -- Tonight's 6:30pm+ ET MLB games
  RAISE NOTICE '──── games 6:30pm+ ET (game_time >= % UTC) ────', v_cutoff;
  FOR r IN
    SELECT DISTINCT home_team, away_team, MIN(game_time::TIMESTAMPTZ) AS gt
    FROM public.props_cache
    WHERE sport='mlb' AND game_time::TIMESTAMPTZ >= v_cutoff
                     AND game_time::TIMESTAMPTZ < v_cutoff + INTERVAL '8 hours'
    GROUP BY home_team, away_team
    ORDER BY MIN(game_time::TIMESTAMPTZ)
  LOOP RAISE NOTICE 'GAME: % @ % start=%', r.away_team, r.home_team, r.gt; END LOOP;

  RAISE NOTICE '──── coverage join via game_time ────';
  FOR r IN
    WITH tonight AS (
      SELECT home_team, away_team, MIN(game_time::TIMESTAMPTZ) AS gt
      FROM public.props_cache
      WHERE sport='mlb' AND game_time::TIMESTAMPTZ >= v_cutoff
                       AND game_time::TIMESTAMPTZ < v_cutoff + INTERVAL '8 hours'
      GROUP BY home_team, away_team
    ),
    rec AS (
      SELECT team, opponent, game_time, COUNT(*) AS n, MAX(created_at) AS last_at
      FROM public.recommendations_cache
      WHERE sport='mlb' AND game_time::TIMESTAMPTZ >= v_cutoff
                       AND game_time::TIMESTAMPTZ < v_cutoff + INTERVAL '8 hours'
      GROUP BY team, opponent, game_time
    ),
    ph AS (
      SELECT team, opponent, game_time, COUNT(*) AS n, MAX(created_at) AS last_at
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_time::TIMESTAMPTZ >= v_cutoff
        AND game_time::TIMESTAMPTZ < v_cutoff + INTERVAL '8 hours'
      GROUP BY team, opponent, game_time
    )
    SELECT t.away_team||' @ '||t.home_team AS matchup, t.gt,
           COALESCE(SUM(rec.n), 0) AS rec_n, MAX(rec.last_at) AS rec_last,
           COALESCE(SUM(ph.n), 0) AS ph_n, MAX(ph.last_at) AS ph_last
    FROM tonight t
    LEFT JOIN rec ON rec.team IN (t.home_team, t.away_team) AND rec.game_time = t.gt
    LEFT JOIN ph ON ph.team IN (t.home_team, t.away_team) AND ph.game_time = t.gt
    GROUP BY t.away_team, t.home_team, t.gt
    ORDER BY t.gt
  LOOP
    RAISE NOTICE 'COV: % @ % | recs=% (last %) | picks=% (last %)',
      r.matchup, r.gt, r.rec_n, r.rec_last, r.ph_n, r.ph_last;
  END LOOP;

  -- error_log last 2h
  RAISE NOTICE '──── error_log last 2h ────';
  FOR r IN
    SELECT created_at, function_name, error_type, LEFT(error_message, 100) AS msg
    FROM public.error_log
    WHERE created_at >= v_now - INTERVAL '2 hours'
    ORDER BY created_at DESC LIMIT 20
  LOOP RAISE NOTICE 'err: % fn=% type=% : %', r.created_at, r.function_name, r.error_type, r.msg;
  END LOOP;

  SELECT COUNT(*) INTO v_n FROM public.recommendations_cache WHERE created_at >= v_now - INTERVAL '30 minutes';
  RAISE NOTICE 'rec_cache last 30min=%', v_n;
  SELECT COUNT(*) INTO v_n FROM public.pick_history WHERE created_at >= v_now - INTERVAL '30 minutes' AND is_synthetic=false;
  RAISE NOTICE 'pick_history last 30min (non-synthetic)=%', v_n;
END $$;
