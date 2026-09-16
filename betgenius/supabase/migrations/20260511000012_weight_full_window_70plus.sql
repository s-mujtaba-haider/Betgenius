-- Read-only diagnostic — fills the gap left by 20260511000010's
-- truncated tail. Captures threshold-70 stats for the FULL window
-- across all 4 configs so /tmp/weight_rebalance_proposals_may11.md
-- has 70+ ROI% per config to report.

DO $$
DECLARE
  cw RECORD;
  r RECORD;
BEGIN
  SELECT * INTO cw FROM algorithm_weights WHERE id = 1 LIMIT 1;

  -- CURRENT, FULL, thresh=70
  RAISE NOTICE 'CURRENT FULL @ thresh 70:';
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_floor_ceiling, cw.w_recent_form, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    cw.w_z_score, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, cw.w_regression,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  picks=% hits=% wr=% roi=%', r.picks, r.hits, r.win_pct, r.roi_pct; END LOOP;

  -- CONFIG_A
  RAISE NOTICE 'CONFIG_A FULL @ thresh 70:';
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    0.5,  cw.w_l10, 2.0,  cw.w_floor_ceiling, 1.0,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.5,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 1.5,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  picks=% hits=% wr=% roi=%', r.picks, r.hits, r.win_pct, r.roi_pct; END LOOP;

  -- CONFIG_B
  RAISE NOTICE 'CONFIG_B FULL @ thresh 70:';
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    0.25, cw.w_l10, 2.5,  cw.w_floor_ceiling, 0.75, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.75, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.0,
    2.25, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  picks=% hits=% wr=% roi=%', r.picks, r.hits, r.win_pct, r.roi_pct; END LOOP;

  -- CONFIG_C
  RAISE NOTICE 'CONFIG_C FULL @ thresh 70:';
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-05-11'::DATE,
    0.0,  cw.w_l10, 3.0,  1.0,                0.5,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    1.0,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.5,
    3.0,  cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  picks=% hits=% wr=% roi=%', r.picks, r.hits, r.win_pct, r.roi_pct; END LOOP;

  -- Same 4 at TRAIN @ thresh=70 (full row, not just diff via per-tier subtract)
  RAISE NOTICE '---';
  RAISE NOTICE 'TRAIN window @ thresh 70:';
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_floor_ceiling, cw.w_recent_form, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    cw.w_z_score, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, cw.w_regression,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CURRENT  picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    0.5,  cw.w_l10, 2.0,  cw.w_floor_ceiling, 1.0,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.5,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 1.5,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CONFIG_A picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    0.25, cw.w_l10, 2.5,  cw.w_floor_ceiling, 0.75, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.75, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.0,
    2.25, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CONFIG_B picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-02-01'::DATE, '2026-03-31'::DATE,
    0.0,  cw.w_l10, 3.0,  1.0,                0.5,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    1.0,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.5,
    3.0,  cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CONFIG_C picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;

  -- VALIDATE @ thresh=70
  RAISE NOTICE '---';
  RAISE NOTICE 'VALIDATE window @ thresh 70:';
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_floor_ceiling, cw.w_recent_form, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    cw.w_z_score, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, cw.w_regression,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CURRENT  picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    0.5,  cw.w_l10, 2.0,  cw.w_floor_ceiling, 1.0,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.5,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 1.5,
    cw.w_market_conf, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CONFIG_A picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    0.25, cw.w_l10, 2.5,  cw.w_floor_ceiling, 0.75, cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    0.75, cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.0,
    2.25, cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CONFIG_B picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;
  FOR r IN SELECT * FROM backtest_weights_v3_synthetic_windowed(
    '2026-04-01'::DATE, '2026-05-03'::DATE,
    0.0,  cw.w_l10, 3.0,  1.0,                0.5,  cw.w_home_away,
    cw.w_rest, cw.w_b2b, cw.w_minutes_trend, cw.w_pace, cw.w_opp_defense, cw.w_prop_type,
    1.0,  cw.w_role_change, cw.w_vig_filter, cw.w_usg_rate, 2.5,
    3.0,  cw.w_ha_split, cw.w_minutes_floor, cw.w_consistency,
    cw.w_stale_data, cw.w_player_injury, true
  ) WHERE threshold = 70
  LOOP RAISE NOTICE '  CONFIG_C picks=% wr=% roi=%', r.picks, r.win_pct, r.roi_pct; END LOOP;
END $$;
