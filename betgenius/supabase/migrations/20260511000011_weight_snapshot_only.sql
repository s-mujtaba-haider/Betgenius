-- Read-only weight snapshot — recaptures the head of the
-- 20260511000010 diagnostic for reference. No state change.

DO $$
DECLARE
  cw RECORD;
BEGIN
  SELECT * INTO cw FROM algorithm_weights WHERE id = 1 LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'algorithm_weights id=1 not found';
  END IF;

  RAISE NOTICE '=== CURRENT WEIGHTS (id=1, updated_at=%) ===', cw.updated_at;
  RAISE NOTICE 'w_l5=%, w_l10=%, w_season=%, w_floor_ceiling=%, w_recent_form=%',
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_floor_ceiling, cw.w_recent_form;
  RAISE NOTICE 'w_home_away=%, w_rest=%, w_b2b=%, w_minutes_trend=%, w_pace=%',
    cw.w_home_away, cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace;
  RAISE NOTICE 'w_opp_defense=%, w_prop_type=%, w_z_score=%, w_role_change=%, w_vig_filter=%',
    cw.w_opp_defense, cw.w_prop_type, cw.w_z_score, cw.w_role_change, cw.w_vig_filter;
  RAISE NOTICE 'w_usg_rate=%, w_regression=%, w_market_conf=%, w_ha_split=%, w_minutes_floor=%',
    cw.w_usg_rate, cw.w_regression, cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor;
  RAISE NOTICE 'w_consistency=%, w_stale_data=%, w_player_injury=%',
    cw.w_consistency, cw.w_stale_data, cw.w_player_injury;

  RAISE NOTICE '=== TOTALS ===';
  RAISE NOTICE 'hot-streak (l5+l10+recent_form+floor_ceiling) = %',
    cw.w_l5 + cw.w_l10 + cw.w_recent_form + cw.w_floor_ceiling;
  RAISE NOTICE 'regression (regression+z_score+season+market_conf) = %',
    cw.w_regression + cw.w_z_score + cw.w_season + cw.w_market_conf;
  RAISE NOTICE 'ratio (reg/hot) = %',
    ROUND((cw.w_regression + cw.w_z_score + cw.w_season + cw.w_market_conf)::NUMERIC
        / NULLIF(cw.w_l5 + cw.w_l10 + cw.w_recent_form + cw.w_floor_ceiling, 0), 3);

  RAISE NOTICE '=== ZERO-WEIGHT FACTORS (unused signal) ===';
  IF cw.w_l5 = 0 THEN RAISE NOTICE '  w_l5'; END IF;
  IF cw.w_l10 = 0 THEN RAISE NOTICE '  w_l10'; END IF;
  IF cw.w_season = 0 THEN RAISE NOTICE '  w_season'; END IF;
  IF cw.w_floor_ceiling = 0 THEN RAISE NOTICE '  w_floor_ceiling'; END IF;
  IF cw.w_recent_form = 0 THEN RAISE NOTICE '  w_recent_form'; END IF;
  IF cw.w_home_away = 0 THEN RAISE NOTICE '  w_home_away'; END IF;
  IF cw.w_rest = 0 THEN RAISE NOTICE '  w_rest'; END IF;
  IF cw.w_b2b = 0 THEN RAISE NOTICE '  w_b2b'; END IF;
  IF cw.w_minutes_trend = 0 THEN RAISE NOTICE '  w_minutes_trend'; END IF;
  IF cw.w_pace = 0 THEN RAISE NOTICE '  w_pace'; END IF;
  IF cw.w_opp_defense = 0 THEN RAISE NOTICE '  w_opp_defense'; END IF;
  IF cw.w_prop_type = 0 THEN RAISE NOTICE '  w_prop_type'; END IF;
  IF cw.w_z_score = 0 THEN RAISE NOTICE '  w_z_score'; END IF;
  IF cw.w_role_change = 0 THEN RAISE NOTICE '  w_role_change'; END IF;
  IF cw.w_vig_filter = 0 THEN RAISE NOTICE '  w_vig_filter'; END IF;
  IF cw.w_usg_rate = 0 THEN RAISE NOTICE '  w_usg_rate'; END IF;
  IF cw.w_regression = 0 THEN RAISE NOTICE '  w_regression'; END IF;
  IF cw.w_market_conf = 0 THEN RAISE NOTICE '  w_market_conf'; END IF;
  IF cw.w_ha_split = 0 THEN RAISE NOTICE '  w_ha_split'; END IF;
  IF cw.w_minutes_floor = 0 THEN RAISE NOTICE '  w_minutes_floor'; END IF;
  IF cw.w_consistency = 0 THEN RAISE NOTICE '  w_consistency'; END IF;
  IF cw.w_stale_data = 0 THEN RAISE NOTICE '  w_stale_data'; END IF;
  IF cw.w_player_injury = 0 THEN RAISE NOTICE '  w_player_injury'; END IF;
END $$;
