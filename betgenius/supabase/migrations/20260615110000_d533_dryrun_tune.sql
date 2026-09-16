-- D-533 SHIP 2-3 — Dry-run weight comparison on the REAL organic
-- corpus, per market, with OOS holdout.
--
-- For each of 5 candidate weight regimes, compute confidence
-- adjustments to the stored confidence on a per-pick basis, then
-- aggregate per-market WR + break-even + edge at conf >= 70 on the
-- HOLDOUT half (game_date > 2026-06-05). The TRAIN half is also
-- reported for sanity.
--
-- The 5 candidate regimes (built around the 9 D-520 sign-flipped
-- factors + the new line_hit_rate factor):
--   R0  CURRENT     — post-D-520 weights (the live state at write time)
--   R1  ZEROED      — all 9 D-520 flipped factors set to 0 (remove signal)
--   R2  SYNTH_PRE   — revert to PRE-D-520 weights (re-flip back to synth-trained)
--   R3  HALF_FLIP   — half the post-D-520 magnitude (gentler in same direction)
--   R4  DOUBLED     — 2x the post-D-520 magnitude (more aggressive)
--
-- Confidence delta math:
--   The stored confidence already includes contribution = score_X (a value).
--   POST-D-520 is the BASELINE for these picks (they were scored at write
--   time with post-D-520 weights — except picks before 2026-06-13 used the
--   pre-D-520 weights; the d532 MV is 2026-05-17 → 2026-06-12, so ALL of
--   these picks were scored PRE-D-520).
--   So the "current" baseline IS the pre-D-520 stored confidence.
--   Adjustment from current (pre-D-520) to other regimes:
--     R1 (ZEROED):   new_conf = stored − sum(s_X)
--     R2 (SYNTH_PRE) = stored (no change; this IS what produced the stored conf)
--     The post-D-520 regimes (R0 baseline, R3 half, R4 doubled) require
--     re-applying the flips:
--       R0 (now CURRENT post-D-520): subtract 2× s_X (flip direction)
--       R3 (HALF):                   subtract 1.5× s_X (half magnitude flipped)
--       R4 (DOUBLED):                subtract 3× s_X (double the flip)
--
-- NOTE on labeling: R2 SYNTH_PRE is what the stored conf actually was at
-- write time (since these picks were written pre-D-520). It's listed as
-- the original baseline. R0 represents the now-live state.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  RAISE NOTICE '======== D-533 §A: per-market sample sizes (TRAIN + HOLDOUT) ========';
  FOR r IN
    SELECT mlb_market_type AS market,
      count(*) FILTER (WHERE game_date <= '2026-06-05'::date) AS train_n,
      count(*) FILTER (WHERE game_date <= '2026-06-05'::date AND confidence >= 70) AS train_n70,
      count(*) FILTER (WHERE game_date >  '2026-06-05'::date) AS holdout_n,
      count(*) FILTER (WHERE game_date >  '2026-06-05'::date AND confidence >= 70) AS holdout_n70
    FROM public.d532_factor_scores_real
    GROUP BY mlb_market_type ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-533 §A.1] market=% train_n=% train_n70=% holdout_n=% holdout_n70=%',
    r.market, r.train_n, r.train_n70, r.holdout_n, r.holdout_n70; END LOOP;

  RAISE NOTICE '======== D-533 §B: HOLDOUT WR by market under 5 regimes (conf>=70) ========';
  FOR r IN
    WITH t AS (
      SELECT
        d.mlb_market_type AS market,
        d.hit,
        d.confidence AS r2_synth_pre,
        d.confidence
          - 2 * d.s_handedness_matchup - 2 * d.s_weather_wind - 2 * d.s_lineup_consistency
          - 2 * d.s_weather_temp - 2 * d.s_wind_direction_hr - 2 * d.s_opposing_pitcher_quality
          - 2 * d.s_batter_form_power - 2 * d.s_recent_at_bats - 2 * d.s_batter_babip
          AS r0_current_post_d520,
        d.confidence
          - 1 * d.s_handedness_matchup - 1 * d.s_weather_wind - 1 * d.s_lineup_consistency
          - 1 * d.s_weather_temp - 1 * d.s_wind_direction_hr - 1 * d.s_opposing_pitcher_quality
          - 1 * d.s_batter_form_power - 1 * d.s_recent_at_bats - 1 * d.s_batter_babip
          AS r1_zeroed,
        d.confidence
          - 1.5 * d.s_handedness_matchup - 1.5 * d.s_weather_wind - 1.5 * d.s_lineup_consistency
          - 1.5 * d.s_weather_temp - 1.5 * d.s_wind_direction_hr - 1.5 * d.s_opposing_pitcher_quality
          - 1.5 * d.s_batter_form_power - 1.5 * d.s_recent_at_bats - 1.5 * d.s_batter_babip
          AS r3_half_flip,
        d.confidence
          - 3 * d.s_handedness_matchup - 3 * d.s_weather_wind - 3 * d.s_lineup_consistency
          - 3 * d.s_weather_temp - 3 * d.s_wind_direction_hr - 3 * d.s_opposing_pitcher_quality
          - 3 * d.s_batter_form_power - 3 * d.s_recent_at_bats - 3 * d.s_batter_babip
          AS r4_doubled,
        ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied
      FROM public.d532_factor_scores_real d
      JOIN public.pick_history ph ON ph.id = d.id
      WHERE d.game_date > '2026-06-05'::date
    )
    SELECT market,
      count(*) AS n,
      -- R0 CURRENT (post-D520)
      count(*) FILTER (WHERE r0_current_post_d520 >= 70) AS R0_n,
      ROUND(100.0 * count(*) FILTER (WHERE r0_current_post_d520 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0_current_post_d520 >= 70),0), 1) AS R0_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r0_current_post_d520 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0_current_post_d520 >= 70),0)
        - 100.0 * avg(implied) FILTER (WHERE r0_current_post_d520 >= 70)
      , 1) AS R0_edge,
      -- R1 ZEROED
      count(*) FILTER (WHERE r1_zeroed >= 70) AS R1_n,
      ROUND(100.0 * count(*) FILTER (WHERE r1_zeroed >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r1_zeroed >= 70),0), 1) AS R1_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r1_zeroed >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r1_zeroed >= 70),0)
        - 100.0 * avg(implied) FILTER (WHERE r1_zeroed >= 70)
      , 1) AS R1_edge,
      -- R2 SYNTH_PRE
      count(*) FILTER (WHERE r2_synth_pre >= 70) AS R2_n,
      ROUND(100.0 * count(*) FILTER (WHERE r2_synth_pre >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r2_synth_pre >= 70),0), 1) AS R2_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r2_synth_pre >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r2_synth_pre >= 70),0)
        - 100.0 * avg(implied) FILTER (WHERE r2_synth_pre >= 70)
      , 1) AS R2_edge,
      -- R3 HALF_FLIP
      count(*) FILTER (WHERE r3_half_flip >= 70) AS R3_n,
      ROUND(100.0 * count(*) FILTER (WHERE r3_half_flip >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r3_half_flip >= 70),0), 1) AS R3_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r3_half_flip >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r3_half_flip >= 70),0)
        - 100.0 * avg(implied) FILTER (WHERE r3_half_flip >= 70)
      , 1) AS R3_edge,
      -- R4 DOUBLED
      count(*) FILTER (WHERE r4_doubled >= 70) AS R4_n,
      ROUND(100.0 * count(*) FILTER (WHERE r4_doubled >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r4_doubled >= 70),0), 1) AS R4_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r4_doubled >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r4_doubled >= 70),0)
        - 100.0 * avg(implied) FILTER (WHERE r4_doubled >= 70)
      , 1) AS R4_edge
    FROM t GROUP BY market ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '[D-533 §B.1] HOLDOUT mkt=% n=% R0(n=% wr=% edge=%) R1(n=% wr=% edge=%) R2(n=% wr=% edge=%) R3(n=% wr=% edge=%) R4(n=% wr=% edge=%)',
      r.market, r.n,
      r.R0_n, r.R0_wr, r.R0_edge,
      r.R1_n, r.R1_wr, r.R1_edge,
      r.R2_n, r.R2_wr, r.R2_edge,
      r.R3_n, r.R3_wr, r.R3_edge,
      r.R4_n, r.R4_wr, r.R4_edge;
  END LOOP;

  RAISE NOTICE '======== D-533 §C: HOLDOUT WR by market under 5 regimes (conf>=80) ========';
  FOR r IN
    WITH t AS (
      SELECT
        d.mlb_market_type AS market,
        d.hit,
        d.confidence AS r2_synth_pre,
        d.confidence
          - 2 * d.s_handedness_matchup - 2 * d.s_weather_wind - 2 * d.s_lineup_consistency
          - 2 * d.s_weather_temp - 2 * d.s_wind_direction_hr - 2 * d.s_opposing_pitcher_quality
          - 2 * d.s_batter_form_power - 2 * d.s_recent_at_bats - 2 * d.s_batter_babip
          AS r0_current_post_d520,
        d.confidence
          - 1 * d.s_handedness_matchup - 1 * d.s_weather_wind - 1 * d.s_lineup_consistency
          - 1 * d.s_weather_temp - 1 * d.s_wind_direction_hr - 1 * d.s_opposing_pitcher_quality
          - 1 * d.s_batter_form_power - 1 * d.s_recent_at_bats - 1 * d.s_batter_babip
          AS r1_zeroed,
        d.confidence
          - 1.5 * d.s_handedness_matchup - 1.5 * d.s_weather_wind - 1.5 * d.s_lineup_consistency
          - 1.5 * d.s_weather_temp - 1.5 * d.s_wind_direction_hr - 1.5 * d.s_opposing_pitcher_quality
          - 1.5 * d.s_batter_form_power - 1.5 * d.s_recent_at_bats - 1.5 * d.s_batter_babip
          AS r3_half_flip,
        d.confidence
          - 3 * d.s_handedness_matchup - 3 * d.s_weather_wind - 3 * d.s_lineup_consistency
          - 3 * d.s_weather_temp - 3 * d.s_wind_direction_hr - 3 * d.s_opposing_pitcher_quality
          - 3 * d.s_batter_form_power - 3 * d.s_recent_at_bats - 3 * d.s_batter_babip
          AS r4_doubled,
        ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied
      FROM public.d532_factor_scores_real d
      JOIN public.pick_history ph ON ph.id = d.id
      WHERE d.game_date > '2026-06-05'::date
    )
    SELECT market,
      count(*) FILTER (WHERE r0_current_post_d520 >= 80) AS R0_n,
      ROUND(100.0 * count(*) FILTER (WHERE r0_current_post_d520 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r0_current_post_d520 >= 80),0), 1) AS R0_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r0_current_post_d520 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r0_current_post_d520 >= 80),0)
        - 100.0 * avg(implied) FILTER (WHERE r0_current_post_d520 >= 80)
      , 1) AS R0_edge,
      count(*) FILTER (WHERE r2_synth_pre >= 80) AS R2_n,
      ROUND(100.0 * count(*) FILTER (WHERE r2_synth_pre >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r2_synth_pre >= 80),0), 1) AS R2_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r2_synth_pre >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r2_synth_pre >= 80),0)
        - 100.0 * avg(implied) FILTER (WHERE r2_synth_pre >= 80)
      , 1) AS R2_edge,
      count(*) FILTER (WHERE r3_half_flip >= 80) AS R3_n,
      ROUND(100.0 * count(*) FILTER (WHERE r3_half_flip >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r3_half_flip >= 80),0), 1) AS R3_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE r3_half_flip >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r3_half_flip >= 80),0)
        - 100.0 * avg(implied) FILTER (WHERE r3_half_flip >= 80)
      , 1) AS R3_edge
    FROM t GROUP BY market ORDER BY market
  LOOP
    RAISE NOTICE '[D-533 §C.1 conf>=80] mkt=% R0(n=% wr=% edge=%) R2(n=% wr=% edge=%) R3(n=% wr=% edge=%)',
      r.market,
      r.R0_n, r.R0_wr, r.R0_edge,
      r.R2_n, r.R2_wr, r.R2_edge,
      r.R3_n, r.R3_wr, r.R3_edge;
  END LOOP;
END $$;
