-- D-530 SHIP 1 — breakdown JSONB key coverage rates.
-- D-516 reported last10_hit_rate_pct at 47% coverage. What else is sparse?
DO $$
DECLARE r RECORD; v_total int;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  -- Use post-D-379 picks (breakdown column populated from D-379 SHIP 2,
  -- ~2026-06-01 onward) so we measure actively-written coverage, not the
  -- legacy NULL-breakdown synthetic period.
  SELECT count(*) INTO v_total
  FROM public.pick_history_real
  WHERE sport='mlb'
    AND mlb_market_type LIKE 'batter_%'
    AND breakdown IS NOT NULL;
  RAISE NOTICE '======== D-530 §G: batter breakdown JSONB key coverage (n=%) ========', v_total;

  -- The keys the scorer claims to populate per scoring_mlb_v2.ts breakdown
  -- assignment (~lines 2640-2710). We sample the most consequential ones.
  FOR r IN
    SELECT
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'last10_hit_rate_pct') / NULLIF(v_total,0), 1) AS k_l10_pct,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'last5_hit_rate_pct') / NULLIF(v_total,0), 1) AS k_l5_pct,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'season_hit_rate_pct') / NULLIF(v_total,0), 1) AS k_season_pct,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'pitcher_era') / NULLIF(v_total,0), 1) AS k_era,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'pitcher_whip') / NULLIF(v_total,0), 1) AS k_whip,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'pitcher_hr9') / NULLIF(v_total,0), 1) AS k_pitcher_hr9,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'park_hits_factor') / NULLIF(v_total,0), 1) AS k_park_hits,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'park_hr_factor') / NULLIF(v_total,0), 1) AS k_park_hr,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'weather_temp_f') / NULLIF(v_total,0), 1) AS k_weather_temp,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'weather_wind_mph') / NULLIF(v_total,0), 1) AS k_weather_wind,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'wind_dir_deg') / NULLIF(v_total,0), 1) AS k_wind_dir,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'park_cf_compass_deg') / NULLIF(v_total,0), 1) AS k_park_cf,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'park_is_dome') / NULLIF(v_total,0), 1) AS k_park_dome
    FROM public.pick_history_real
    WHERE sport='mlb' AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '[D-530 §G.1] coverage %% of n=%: l10=% l5=% season=% era=% whip=% pitcher_hr9=% park_hits=% park_hr=% w_temp=% w_wind=% wind_dir=% park_cf=% park_dome=%',
    v_total, r.k_l10_pct, r.k_l5_pct, r.k_season_pct, r.k_era, r.k_whip, r.k_pitcher_hr9,
    r.k_park_hits, r.k_park_hr, r.k_weather_temp, r.k_weather_wind,
    r.k_wind_dir, r.k_park_cf, r.k_park_dome; END LOOP;

  -- Score fields (the actual factor contributions)
  FOR r IN
    SELECT
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_batter_hit_rate') / NULLIF(v_total,0), 1) AS k_hit_rate,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_handedness_matchup') / NULLIF(v_total,0), 1) AS k_handed,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_weather_wind') / NULLIF(v_total,0), 1) AS k_w_wind,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_lineup_consistency') / NULLIF(v_total,0), 1) AS k_lineup_cons,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_weather_temp') / NULLIF(v_total,0), 1) AS k_w_temp,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_wind_direction_hr') / NULLIF(v_total,0), 1) AS k_wind_hr,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_opposing_pitcher_quality') / NULLIF(v_total,0), 1) AS k_pq,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_batter_form_power') / NULLIF(v_total,0), 1) AS k_form_pow,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_recent_at_bats') / NULLIF(v_total,0), 1) AS k_recent_ab,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_batter_babip') / NULLIF(v_total,0), 1) AS k_babip,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'score_batter_line_hit_rate') / NULLIF(v_total,0), 1) AS k_lhr,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'projected_stat') / NULLIF(v_total,0), 1) AS k_proj,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'raw_edge') / NULLIF(v_total,0), 1) AS k_edge
    FROM public.pick_history_real
    WHERE sport='mlb' AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '[D-530 §G.2] score-key coverage %%: hit_rate=% handed=% w_wind=% lineup_cons=% w_temp=% wind_hr=% pq=% form_pow=% recent_ab=% babip=% lhr=% proj=% edge=%',
    r.k_hit_rate, r.k_handed, r.k_w_wind, r.k_lineup_cons, r.k_w_temp,
    r.k_wind_hr, r.k_pq, r.k_form_pow, r.k_recent_ab, r.k_babip, r.k_lhr,
    r.k_proj, r.k_edge; END LOOP;

  -- Where the firing rates are LOW for keys the scorer claims to populate,
  -- the value is OFTEN null/0 (factor didn't fire for that pick). That's
  -- different from "key missing entirely" which suggests bug. Distinguish:
  FOR r IN
    SELECT
      'score_handedness_matchup' AS k,
      count(*) FILTER (WHERE breakdown ? 'score_handedness_matchup' AND (breakdown->>'score_handedness_matchup') = '0') AS zero_value,
      count(*) FILTER (WHERE breakdown ? 'score_handedness_matchup' AND (breakdown->>'score_handedness_matchup') <> '0') AS nonzero_value,
      count(*) FILTER (WHERE NOT (breakdown ? 'score_handedness_matchup')) AS key_missing
    FROM public.pick_history_real
    WHERE sport='mlb' AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '[D-530 §G.3] handedness_matchup: zero=% nonzero=% key_missing=%',
    r.zero_value, r.nonzero_value, r.key_missing; END LOOP;

  FOR r IN
    SELECT
      'score_wind_direction_hr' AS k,
      count(*) FILTER (WHERE breakdown ? 'score_wind_direction_hr' AND (breakdown->>'score_wind_direction_hr') = '0') AS zero_value,
      count(*) FILTER (WHERE breakdown ? 'score_wind_direction_hr' AND (breakdown->>'score_wind_direction_hr') <> '0') AS nonzero_value
    FROM public.pick_history_real
    WHERE sport='mlb' AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '[D-530 §G.4] wind_direction_hr: zero=% nonzero=%', r.zero_value, r.nonzero_value; END LOOP;

  FOR r IN
    SELECT
      'score_weather_temp' AS k,
      count(*) FILTER (WHERE breakdown ? 'score_weather_temp' AND (breakdown->>'score_weather_temp') = '0') AS zero_value,
      count(*) FILTER (WHERE breakdown ? 'score_weather_temp' AND (breakdown->>'score_weather_temp') <> '0') AS nonzero_value
    FROM public.pick_history_real
    WHERE sport='mlb' AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '[D-530 §G.5] weather_temp: zero=% nonzero=%', r.zero_value, r.nonzero_value; END LOOP;

  -- Sample one real pick's full breakdown for SHIP 2 hand-verification.
  FOR r IN
    SELECT id, player_name, prop_type, line, pick_side, odds, confidence, mlb_market_type,
           jsonb_pretty(breakdown) AS bk
    FROM public.pick_history_real
    WHERE sport='mlb'
      AND mlb_market_type = 'batter_hits'
      AND breakdown IS NOT NULL
      AND confidence >= 80
      AND breakdown ? 'last10_hit_rate_pct'
      AND breakdown ? 'score_batter_line_hit_rate'
    ORDER BY created_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '[D-530 §G.6] sample pick id=% player=% prop=% line=% side=% odds=% conf=% market=%',
      r.id, r.player_name, r.prop_type, r.line, r.pick_side, r.odds, r.confidence, r.mlb_market_type;
    RAISE NOTICE '  breakdown JSON:%', E'\n' || r.bk;
  END LOOP;

END $$;
