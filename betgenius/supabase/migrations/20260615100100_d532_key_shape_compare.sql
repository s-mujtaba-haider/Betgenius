-- D-532 SHIP 1 — Compare the score-key shapes between synth and organic
-- so we can build a parallel MV that works for BOTH formats.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-532 §E: score-key shape compare ========';

  -- Synth pick: keys live in ai_analysis::jsonb -> 'factor_breakdown' ->> 'score_*'
  RAISE NOTICE '[D-532 §E.1] sample SYNTH ai_analysis.factor_breakdown keys:';
  FOR r IN
    SELECT
      jsonb_object_keys((ai_analysis::jsonb -> 'factor_breakdown')::jsonb) AS k
    FROM public.pick_history
    WHERE is_synthetic = true AND sport='mlb'
      AND ai_analysis IS NOT NULL
    ORDER BY random() LIMIT 30
  LOOP RAISE NOTICE '  synth_key=%', r.k; END LOOP;

  -- Organic pick: keys live in `breakdown` JSONB column directly
  RAISE NOTICE '[D-532 §E.2] sample ORGANIC breakdown keys:';
  FOR r IN
    SELECT
      jsonb_object_keys(breakdown) AS k
    FROM public.pick_history
    WHERE is_synthetic = false AND sport='mlb'
      AND breakdown IS NOT NULL
    ORDER BY random() LIMIT 30
  LOOP RAISE NOTICE '  organic_key=%', r.k; END LOOP;

  -- §E.3 — for both, count rows where the 13 d366-extracted scores are
  -- populated. The d366 MV extracts 38 score columns (s_*) and 4 fraw
  -- columns (f_*). If the organic breakdown is missing any of these,
  -- the equivalent extraction yields 0 (via COALESCE).
  RAISE NOTICE '[D-532 §E.3] key-presence in organic breakdown (post-D-379):';
  FOR r IN
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE breakdown ? 'score_batter_hit_rate') AS k_hit_rate,
      count(*) FILTER (WHERE breakdown ? 'score_pitcher_k_rate') AS k_pitcher_k,
      count(*) FILTER (WHERE breakdown ? 'score_handedness_matchup') AS k_handedness,
      count(*) FILTER (WHERE breakdown ? 'score_opposing_pitcher_quality') AS k_opp_pq,
      count(*) FILTER (WHERE breakdown ? 'score_recent_at_bats') AS k_recent_ab,
      count(*) FILTER (WHERE breakdown ? 'score_batter_form_power') AS k_form_power,
      count(*) FILTER (WHERE breakdown ? 'score_weather_temp') AS k_weather_temp,
      count(*) FILTER (WHERE breakdown ? 'score_weather_wind') AS k_weather_wind,
      count(*) FILTER (WHERE breakdown ? 'score_wind_direction_hr') AS k_wind_hr,
      count(*) FILTER (WHERE breakdown ? 'score_batter_babip') AS k_babip,
      count(*) FILTER (WHERE breakdown ? 'score_lineup_consistency') AS k_lineup_cons,
      count(*) FILTER (WHERE breakdown ? 'score_offense_differential') AS k_offense_diff,
      count(*) FILTER (WHERE breakdown ? 'score_pitching_matchup') AS k_pitching_match,
      count(*) FILTER (WHERE breakdown ? 'score_team_form') AS k_team_form,
      count(*) FILTER (WHERE breakdown ? 'score_recent_run_diff') AS k_run_diff
    FROM public.pick_history
    WHERE is_synthetic = false AND sport='mlb' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '  organic_n=% hit_rate=% pk=% hand=% opp_pq=% rec_ab=% form_pow=% w_temp=% w_wind=% wind_hr=% babip=% lineup_cons=% offense_diff=% pit_match=% team_form=% run_diff=%',
    r.n, r.k_hit_rate, r.k_pitcher_k, r.k_handedness, r.k_opp_pq, r.k_recent_ab,
    r.k_form_power, r.k_weather_temp, r.k_weather_wind, r.k_wind_hr, r.k_babip,
    r.k_lineup_cons, r.k_offense_diff, r.k_pitching_match, r.k_team_form, r.k_run_diff; END LOOP;

  -- Also count by-market on organic with breakdown — for SHIP 1.4 verdict
  RAISE NOTICE '[D-532 §E.4] organic resolved+breakdown counts by market (training-set candidates):';
  FOR r IN
    SELECT
      mlb_market_type,
      count(*) AS n,
      count(*) FILTER (WHERE confidence >= 60) AS n_60,
      count(*) FILTER (WHERE confidence >= 70) AS n_70,
      count(*) FILTER (WHERE confidence >= 80) AS n_80
    FROM public.pick_history
    WHERE is_synthetic = false AND sport='mlb' AND voided IS NOT TRUE
      AND hit IS NOT NULL AND breakdown IS NOT NULL
    GROUP BY mlb_market_type
    ORDER BY n DESC
  LOOP RAISE NOTICE '  market=% n=% n_60=% n_70=% n_80=%',
    r.mlb_market_type, r.n, r.n_60, r.n_70, r.n_80; END LOOP;
END $$;
