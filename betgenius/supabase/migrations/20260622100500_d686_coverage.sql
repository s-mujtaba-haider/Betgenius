DO $$
DECLARE r RECORD; v_n INT; v_now TIMESTAMPTZ := NOW();
  v_cutoff TIMESTAMPTZ := (NOW() AT TIME ZONE 'UTC')::date::TIMESTAMP + INTERVAL '22 hours 30 minutes';
BEGIN
  -- check rec_cache + ph game_time types
  RAISE NOTICE 'recommendations_cache.game_time type:';
  FOR r IN SELECT data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recommendations_cache' AND column_name='game_time'
  LOOP RAISE NOTICE '  type=%', r.data_type; END LOOP;
  RAISE NOTICE 'pick_history.game_time type:';
  FOR r IN SELECT data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history' AND column_name='game_time'
  LOOP RAISE NOTICE '  type=%', r.data_type; END LOOP;

  RAISE NOTICE '──── coverage with explicit text-cast on rec/ph ────';
  FOR r IN
    WITH tonight AS (
      SELECT home_team, away_team, MIN(game_time::TIMESTAMPTZ) AS gt
      FROM public.props_cache
      WHERE sport='mlb' AND game_time::TIMESTAMPTZ >= v_cutoff
                       AND game_time::TIMESTAMPTZ < v_cutoff + INTERVAL '8 hours'
      GROUP BY home_team, away_team
    )
    SELECT t.away_team||' @ '||t.home_team AS matchup, t.gt,
           (SELECT COUNT(*) FROM public.recommendations_cache rc
             WHERE rc.sport='mlb' AND rc.team IN (t.home_team, t.away_team)
               AND rc.game_time::TIMESTAMPTZ BETWEEN t.gt - INTERVAL '5 min' AND t.gt + INTERVAL '5 min') AS rec_n,
           (SELECT MAX(rc.created_at) FROM public.recommendations_cache rc
             WHERE rc.sport='mlb' AND rc.team IN (t.home_team, t.away_team)
               AND rc.game_time::TIMESTAMPTZ BETWEEN t.gt - INTERVAL '5 min' AND t.gt + INTERVAL '5 min') AS rec_last,
           (SELECT COUNT(*) FROM public.pick_history ph
             WHERE ph.sport='mlb' AND ph.is_synthetic=false AND ph.team IN (t.home_team, t.away_team)
               AND ph.game_time::TIMESTAMPTZ BETWEEN t.gt - INTERVAL '5 min' AND t.gt + INTERVAL '5 min') AS ph_n,
           (SELECT MAX(ph.created_at) FROM public.pick_history ph
             WHERE ph.sport='mlb' AND ph.is_synthetic=false AND ph.team IN (t.home_team, t.away_team)
               AND ph.game_time::TIMESTAMPTZ BETWEEN t.gt - INTERVAL '5 min' AND t.gt + INTERVAL '5 min') AS ph_last
    FROM tonight t ORDER BY t.gt
  LOOP
    RAISE NOTICE 'COV: % @ % | recs=% (last %) | picks=% (last %)',
      r.matchup, r.gt, r.rec_n, r.rec_last, r.ph_n, r.ph_last;
  END LOOP;

  RAISE NOTICE '──── error_log last 2h ────';
  FOR r IN
    SELECT created_at, function_name, error_type, LEFT(error_message, 100) AS msg
    FROM public.error_log
    WHERE created_at >= v_now - INTERVAL '2 hours'
    ORDER BY created_at DESC LIMIT 20
  LOOP RAISE NOTICE 'err: % fn=% type=% : %', r.created_at, r.function_name, r.error_type, r.msg;
  END LOOP;

  -- Also probe ALL games tonight (any time) — not just 6:30+
  RAISE NOTICE '──── ALL MLB games today (game_date=today) ────';
  FOR r IN
    SELECT DISTINCT home_team, away_team, MIN(game_time::TIMESTAMPTZ) AS gt
    FROM public.props_cache
    WHERE sport='mlb' AND game_date = (v_now AT TIME ZONE 'UTC')::date::TEXT
    GROUP BY home_team, away_team ORDER BY gt
  LOOP RAISE NOTICE 'today: % @ % start=%', r.away_team, r.home_team, r.gt;
  END LOOP;
END $$;
