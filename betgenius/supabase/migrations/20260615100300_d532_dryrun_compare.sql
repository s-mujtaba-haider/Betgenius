-- D-532 SHIP 2.3 + SHIP 3 — Dry-run weight comparison on the REAL corpus
-- with OOS holdout.
--
-- Compares 4 weight regimes on the organic corpus:
--   A. CURRENT_BASELINE — stored confidence (PRE-D-520 weights were used
--      when these picks were scored 2026-05-17 to 2026-06-12).
--   B. POST_D520 — re-score by SUBTRACTING 2× the contribution of each of
--      the 9 D-520-flipped factor scores from confidence (since
--      post-flip, weight is negated → contribution flips sign).
--   C. ZERO_FLIPPED — re-score by SUBTRACTING the contribution of all 9
--      flipped factors entirely (treat them as zero).
--   D. ZERO_ALL_NON_FROZEN — re-score by subtracting ALL non-frozen
--      factor contributions; the picks reduce to baseline-confidence
--      from price+season alone. Sanity check: what's the algorithm
--      worth?
--
-- OOS split:
--   Train half: game_date <= '2026-06-05'  (first 70%)
--   Holdout:    game_date >  '2026-06-05'  (last week)
--
-- READ-ONLY. No weight changes applied.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  RAISE NOTICE '======== D-532 §G: OOS split sizes ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) FILTER (WHERE game_date <= '2026-06-05'::date) AS train_n,
      count(*) FILTER (WHERE game_date >  '2026-06-05'::date) AS holdout_n,
      count(*) FILTER (WHERE game_date <= '2026-06-05'::date AND confidence >= 70) AS train_n_70,
      count(*) FILTER (WHERE game_date >  '2026-06-05'::date AND confidence >= 70) AS holdout_n_70
    FROM public.d532_factor_scores_real
    GROUP BY mlb_market_type ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-532 §G.1] market=% train_n=% holdout_n=% train_n_70=% holdout_n_70=%',
    r.market, r.train_n, r.holdout_n, r.train_n_70, r.holdout_n_70; END LOOP;

  RAISE NOTICE '======== D-532 §H: WR-by-tier under 4 weight regimes (TRAIN HALF) ========';
  FOR r IN
    WITH t AS (
      SELECT
        mlb_market_type AS market,
        hit,
        confidence AS conf_current,
        -- POST_D520: subtract 2× each flipped factor (since weight goes
        -- from +W to -W, contribution flips sign; delta = -2 × stored).
        confidence
          - 2 * s_handedness_matchup
          - 2 * s_weather_wind
          - 2 * s_lineup_consistency
          - 2 * s_weather_temp
          - 2 * s_wind_direction_hr
          - 2 * s_opposing_pitcher_quality
          - 2 * s_batter_form_power
          - 2 * s_recent_at_bats
          - 2 * s_batter_babip
          AS conf_post_d520,
        -- ZERO_FLIPPED: remove each flipped factor entirely.
        confidence
          - s_handedness_matchup
          - s_weather_wind
          - s_lineup_consistency
          - s_weather_temp
          - s_wind_direction_hr
          - s_opposing_pitcher_quality
          - s_batter_form_power
          - s_recent_at_bats
          - s_batter_babip
          AS conf_zero_flipped,
        -- ZERO_ALL_NON_FROZEN: subtract all factor contributions.
        confidence
          - s_handedness_matchup - s_weather_wind - s_lineup_consistency
          - s_weather_temp - s_wind_direction_hr - s_opposing_pitcher_quality
          - s_batter_form_power - s_recent_at_bats - s_batter_babip
          - s_pitcher_xera_edge - s_pitcher_baa - s_catcher_framing
          - s_pitcher_pitch_mix_k - s_batter_xba - s_batter_exit_velo_trend
          - s_batter_barrel_rate - s_batter_xslg_regression
          - s_batter_vs_pitcher_hand_split - s_bullpen_quality
          - s_pitcher_k_rate - s_pitcher_form - s_opposing_lineup_k
          - s_pitch_count_trend - s_rest_pitcher - s_ballpark_factor
          - s_umpire_k_zone - s_batter_hit_rate - s_batter_form
          - s_batter_power_rate - s_pitcher_hr_rate - s_offense_differential
          - s_pitching_matchup - s_bullpen_strength - s_recent_run_diff
          - s_h2h_recent - s_team_form - s_lineup_vs_hand_split
          AS conf_zero_all
      FROM public.d532_factor_scores_real
      WHERE game_date <= '2026-06-05'::date
    )
    SELECT
      market,
      count(*) AS n,
      -- WR @ conf>=70 under each regime
      ROUND(100.0 * count(*) FILTER (WHERE conf_current >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_current >= 70),0), 1) AS A_wr70,
      count(*) FILTER (WHERE conf_current >= 70) AS A_n70,
      ROUND(100.0 * count(*) FILTER (WHERE conf_post_d520 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_post_d520 >= 70),0), 1) AS B_wr70,
      count(*) FILTER (WHERE conf_post_d520 >= 70) AS B_n70,
      ROUND(100.0 * count(*) FILTER (WHERE conf_zero_flipped >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_zero_flipped >= 70),0), 1) AS C_wr70,
      count(*) FILTER (WHERE conf_zero_flipped >= 70) AS C_n70,
      ROUND(100.0 * count(*) FILTER (WHERE conf_zero_all >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_zero_all >= 70),0), 1) AS D_wr70,
      count(*) FILTER (WHERE conf_zero_all >= 70) AS D_n70
    FROM t GROUP BY market ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-532 §H.1 TRAIN] mkt=% n=% A(curr_n70=% wr=%) B(postD520_n70=% wr=%) C(zero_flipped_n70=% wr=%) D(zero_all_n70=% wr=%)',
    r.market, r.n, r.A_n70, r.A_wr70, r.B_n70, r.B_wr70, r.C_n70, r.C_wr70, r.D_n70, r.D_wr70; END LOOP;

  RAISE NOTICE '======== D-532 §I: WR-by-tier under 4 weight regimes (HOLDOUT — OOS) ========';
  FOR r IN
    WITH t AS (
      SELECT
        mlb_market_type AS market,
        hit,
        confidence AS conf_current,
        confidence
          - 2 * s_handedness_matchup - 2 * s_weather_wind - 2 * s_lineup_consistency
          - 2 * s_weather_temp - 2 * s_wind_direction_hr - 2 * s_opposing_pitcher_quality
          - 2 * s_batter_form_power - 2 * s_recent_at_bats - 2 * s_batter_babip
          AS conf_post_d520,
        confidence
          - s_handedness_matchup - s_weather_wind - s_lineup_consistency
          - s_weather_temp - s_wind_direction_hr - s_opposing_pitcher_quality
          - s_batter_form_power - s_recent_at_bats - s_batter_babip
          AS conf_zero_flipped,
        confidence
          - s_handedness_matchup - s_weather_wind - s_lineup_consistency
          - s_weather_temp - s_wind_direction_hr - s_opposing_pitcher_quality
          - s_batter_form_power - s_recent_at_bats - s_batter_babip
          - s_pitcher_xera_edge - s_pitcher_baa - s_catcher_framing
          - s_pitcher_pitch_mix_k - s_batter_xba - s_batter_exit_velo_trend
          - s_batter_barrel_rate - s_batter_xslg_regression
          - s_batter_vs_pitcher_hand_split - s_bullpen_quality
          - s_pitcher_k_rate - s_pitcher_form - s_opposing_lineup_k
          - s_pitch_count_trend - s_rest_pitcher - s_ballpark_factor
          - s_umpire_k_zone - s_batter_hit_rate - s_batter_form
          - s_batter_power_rate - s_pitcher_hr_rate - s_offense_differential
          - s_pitching_matchup - s_bullpen_strength - s_recent_run_diff
          - s_h2h_recent - s_team_form - s_lineup_vs_hand_split
          AS conf_zero_all
      FROM public.d532_factor_scores_real
      WHERE game_date > '2026-06-05'::date
    )
    SELECT
      market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE conf_current >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_current >= 70),0), 1) AS A_wr70,
      count(*) FILTER (WHERE conf_current >= 70) AS A_n70,
      ROUND(100.0 * count(*) FILTER (WHERE conf_post_d520 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_post_d520 >= 70),0), 1) AS B_wr70,
      count(*) FILTER (WHERE conf_post_d520 >= 70) AS B_n70,
      ROUND(100.0 * count(*) FILTER (WHERE conf_zero_flipped >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_zero_flipped >= 70),0), 1) AS C_wr70,
      count(*) FILTER (WHERE conf_zero_flipped >= 70) AS C_n70,
      ROUND(100.0 * count(*) FILTER (WHERE conf_zero_all >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_zero_all >= 70),0), 1) AS D_wr70,
      count(*) FILTER (WHERE conf_zero_all >= 70) AS D_n70
    FROM t GROUP BY market ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-532 §I.1 HOLDOUT] mkt=% n=% A(curr_n70=% wr=%) B(postD520_n70=% wr=%) C(zero_flipped_n70=% wr=%) D(zero_all_n70=% wr=%)',
    r.market, r.n, r.A_n70, r.A_wr70, r.B_n70, r.B_wr70, r.C_n70, r.C_wr70, r.D_n70, r.D_wr70; END LOOP;

  -- Edge check using break-even from odds. For the holdout, compute
  -- edge = WR − BE for each regime to see if there's real +EV.
  RAISE NOTICE '======== D-532 §J: HOLDOUT edge vs break-even (the true sellable test) ========';
  FOR r IN
    WITH t AS (
      SELECT
        ph.mlb_market_type AS market,
        ph.hit, ph.odds,
        ph.confidence AS conf_current,
        ph.confidence
          - 2 * (ph.breakdown->>'score_handedness_matchup')::numeric
          - 2 * (ph.breakdown->>'score_weather_wind')::numeric
          - 2 * (ph.breakdown->>'score_lineup_consistency')::numeric
          - 2 * (ph.breakdown->>'score_weather_temp')::numeric
          - 2 * (ph.breakdown->>'score_wind_direction_hr')::numeric
          - 2 * (ph.breakdown->>'score_opposing_pitcher_quality')::numeric
          - 2 * (ph.breakdown->>'score_batter_form_power')::numeric
          - 2 * (ph.breakdown->>'score_recent_at_bats')::numeric
          - 2 * (ph.breakdown->>'score_batter_babip')::numeric
          AS conf_post_d520,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied
      FROM public.pick_history ph
      WHERE ph.sport='mlb' AND ph.is_synthetic=false AND ph.voided IS NOT TRUE
        AND ph.hit IS NOT NULL AND ph.breakdown IS NOT NULL
        AND ph.game_date > '2026-06-05'::date
    )
    SELECT
      market,
      count(*) FILTER (WHERE conf_current >= 70) AS A_n,
      ROUND(100.0 * count(*) FILTER (WHERE conf_current >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_current >= 70),0), 1) AS A_wr,
      ROUND(100.0 * avg(implied) FILTER (WHERE conf_current >= 70), 1) AS A_be,
      ROUND(
        100.0 * count(*) FILTER (WHERE conf_current >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_current >= 70),0)
        - 100.0 * avg(implied) FILTER (WHERE conf_current >= 70)
      , 1) AS A_edge,
      count(*) FILTER (WHERE conf_post_d520 >= 70) AS B_n,
      ROUND(100.0 * count(*) FILTER (WHERE conf_post_d520 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_post_d520 >= 70),0), 1) AS B_wr,
      ROUND(100.0 * avg(implied) FILTER (WHERE conf_post_d520 >= 70), 1) AS B_be,
      ROUND(
        100.0 * count(*) FILTER (WHERE conf_post_d520 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE conf_post_d520 >= 70),0)
        - 100.0 * avg(implied) FILTER (WHERE conf_post_d520 >= 70)
      , 1) AS B_edge
    FROM t GROUP BY market ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-532 §J.1 HOLDOUT edge] mkt=% A(n=% wr=% be=% edge=%pp) B(n=% wr=% be=% edge=%pp)',
    r.market, r.A_n, r.A_wr, r.A_be, r.A_edge, r.B_n, r.B_wr, r.B_be, r.B_edge; END LOOP;
END $$;
