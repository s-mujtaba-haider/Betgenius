-- D-606 PART A deep-trace — pull breakdown JSON of recent SUCCESSFUL
-- batter_hr / batter_hits / batter_total_bases picks vs the FAILED
-- player names from error_log, to spot which factor diverges.

DO $$
DECLARE
  r RECORD;
  v_failing_players text[];
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-606 PART A — NaN trace via breakdown JSON inspection';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Pull a recent SUCCESSFUL batter_hr pick's full breakdown
  RAISE NOTICE '';
  RAISE NOTICE '[A.4] Most recent successful batter_hr pick breakdown:';
  FOR r IN
    SELECT player_name, confidence, projected_stat,
           breakdown
      FROM public.pick_history
     WHERE mlb_market_type = 'batter_hr' AND sport = 'mlb'
       AND is_synthetic = false
     ORDER BY created_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '  player=% conf=% proj=%', r.player_name, r.confidence, r.projected_stat;
    RAISE NOTICE '  breakdown JSON keys+values (selected):';
    RAISE NOTICE '    season_games=% season_ba=% season_hr_per_pa=% season_iso=%',
      r.breakdown->>'season_games', r.breakdown->>'season_ba',
      r.breakdown->>'season_hr_per_pa', r.breakdown->>'season_iso';
    RAISE NOTICE '    park_hr_factor=% park_hits_factor=%',
      r.breakdown->>'park_hr_factor', r.breakdown->>'park_hits_factor';
    RAISE NOTICE '    weather_temp=% weather_wind=%',
      r.breakdown->>'weather_temp_f', r.breakdown->>'weather_wind_mph';
    RAISE NOTICE '    statcast_brl_pa=% statcast_xslg_diff=%',
      r.breakdown->>'statcast_brl_pa', r.breakdown->>'statcast_xslg_diff';
    RAISE NOTICE '    statcast_xba=% statcast_avg_hit_speed=%',
      r.breakdown->>'statcast_xba', r.breakdown->>'statcast_avg_hit_speed';
    RAISE NOTICE '    season_babip=% pitcher_era=% pitcher_whip=% pitcher_hr9=%',
      r.breakdown->>'season_babip', r.breakdown->>'pitcher_era',
      r.breakdown->>'pitcher_whip', r.breakdown->>'pitcher_hr9';
    RAISE NOTICE '    pitcher_hand_for_split=% opposing_bullpen_era=%',
      r.breakdown->>'pitcher_hand_for_split', r.breakdown->>'opposing_bullpen_era';
    RAISE NOTICE '    opposing_pitcher_ip=% opp_pitcher_id=% opp_pitcher_expected_put_away=%',
      r.breakdown->>'opposing_pitcher_ip', r.breakdown->>'opp_pitcher_id',
      r.breakdown->>'opp_pitcher_expected_put_away';
    RAISE NOTICE '    score_opp_pitcher_pitchtype_quality=% wind_dir_deg=%',
      r.breakdown->>'score_opp_pitcher_pitchtype_quality', r.breakdown->>'wind_dir_deg';
    RAISE NOTICE '    raw_edge=% lineup_spot=%',
      r.breakdown->>'raw_edge', r.breakdown->>'lineup_spot';
  END LOOP;

  -- pick_history rows where confidence is NULL vs not, by market in last 24h
  RAISE NOTICE '';
  RAISE NOTICE '[A.5] Pick volumes by market last 24h (rec_cache_sellable confidence):';
  FOR r IN
    SELECT mlb_market_type,
           count(*) AS n_picks_written,
           count(*) FILTER (WHERE confidence IS NULL) AS n_null_conf,
           min(confidence) AS min_conf,
           max(confidence) AS max_conf,
           round(avg(confidence)::numeric, 1) AS avg_conf
      FROM public.pick_history
     WHERE created_at >= (now() - interval '24 hours')
       AND sport = 'mlb' AND is_synthetic = false
     GROUP BY mlb_market_type
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  market=% n=% null_conf=% min=% max=% avg=%',
      r.mlb_market_type, r.n_picks_written, r.n_null_conf,
      r.min_conf, r.max_conf, r.avg_conf;
  END LOOP;

  -- Inspect the WIND-direction breakdown values for HR market — D-287 SHIP 1
  -- gives wind_dir_deg from cache_mlb_game_scoreboard.weather_wind_dir_deg.
  -- If that's NULL but ballparkOrientation is present, the wind_dir factor
  -- formula may produce NaN at line 2653.
  RAISE NOTICE '';
  RAISE NOTICE '[A.6] HR picks: wind_dir + park_cf_compass distribution last 24h:';
  FOR r IN
    SELECT
      (breakdown->>'wind_dir_deg' IS NOT NULL) AS has_wind_dir,
      (breakdown->>'park_cf_compass_deg' IS NOT NULL) AS has_park_cf,
      count(*) AS n
      FROM public.pick_history
     WHERE created_at >= (now() - interval '24 hours')
       AND mlb_market_type = 'batter_hr' AND is_synthetic = false
     GROUP BY (breakdown->>'wind_dir_deg' IS NOT NULL),
              (breakdown->>'park_cf_compass_deg' IS NOT NULL)
  LOOP
    RAISE NOTICE '  has_wind_dir=% has_park_cf=% n=%', r.has_wind_dir, r.has_park_cf, r.n;
  END LOOP;

  -- Survey: which breakdown fields are NaN-printed-as-strings?
  RAISE NOTICE '';
  RAISE NOTICE '[A.7] Searching breakdown for any NaN-string in last 24h batter picks:';
  FOR r IN
    SELECT mlb_market_type, key, count(*) AS n_nan
      FROM public.pick_history,
           LATERAL jsonb_each_text(breakdown) AS x(key, val)
     WHERE created_at >= (now() - interval '24 hours')
       AND sport = 'mlb' AND is_synthetic = false
       AND val ILIKE '%nan%'
     GROUP BY mlb_market_type, key
     ORDER BY count(*) DESC LIMIT 30
  LOOP RAISE NOTICE '  market=% key=% n_nan=%', r.mlb_market_type, r.key, r.n_nan; END LOOP;
END $$;
