-- D-530 SHIP 2 — Pull one real batter pick with a populated breakdown so
-- we can hand-verify 5 factor computations against the stored values.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '30s';

  -- Find a high-confidence batter_hits pick where the handedness factor
  -- actually FIRED (non-zero) so we have something interesting to verify.
  RAISE NOTICE '[D-530 §G.6] sample pick (handedness != 0 so we can verify):';
  FOR r IN
    SELECT id, player_name, prop_type, line, pick_side, odds, confidence, mlb_market_type,
           jsonb_pretty(breakdown) AS bk
    FROM public.pick_history_real
    WHERE sport='mlb'
      AND mlb_market_type LIKE 'batter_%'
      AND breakdown IS NOT NULL
      AND confidence >= 80
      AND (breakdown->>'score_handedness_matchup')::numeric <> 0
      AND (breakdown->>'score_weather_temp')::numeric <> 0
    ORDER BY created_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '  id=%', r.id;
    RAISE NOTICE '  player=% prop=% line=% side=% odds=% conf=% market=%',
      r.player_name, r.prop_type, r.line, r.pick_side, r.odds, r.confidence, r.mlb_market_type;
    RAISE NOTICE '%', E'\n' || r.bk;
  END LOOP;

  -- Also: a pick where wind_direction_hr fired (the rarest of the 9)
  RAISE NOTICE '[D-530 §G.7] sample HR pick where wind_direction_hr != 0:';
  FOR r IN
    SELECT id, player_name, prop_type, line, pick_side, confidence,
           breakdown->>'score_wind_direction_hr' AS s_wind_dir,
           breakdown->>'wind_dir_deg' AS wind_dir_deg,
           breakdown->>'wind_speed_mph' AS wind_speed,
           breakdown->>'park_cf_compass_deg' AS park_cf,
           breakdown->>'park_is_dome' AS park_is_dome
    FROM public.pick_history_real
    WHERE sport='mlb'
      AND mlb_market_type IN ('batter_hr', 'batter_total_bases')
      AND breakdown IS NOT NULL
      AND (breakdown->>'score_wind_direction_hr')::numeric <> 0
    ORDER BY created_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '  id=% player=% prop=% conf=%', r.id, r.player_name, r.prop_type, r.confidence;
    RAISE NOTICE '  score_wind_direction_hr=%, wind_dir_deg=%, wind_speed=%, park_cf=%, park_is_dome=%',
      r.s_wind_dir, r.wind_dir_deg, r.wind_speed, r.park_cf, r.park_is_dome;
  END LOOP;
END $$;
