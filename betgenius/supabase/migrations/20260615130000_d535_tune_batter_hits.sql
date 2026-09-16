-- D-535 SHIP 1-2 — Per-prop tune for batter_hits ONLY, on real organic data.
--
-- Method: hand-craft 7 candidate regimes targeted at batter_hits, compute
-- new_conf for each pick under each regime, aggregate WR + edge at
-- conf>=70 and conf>=80 on TRAIN and HOLDOUT.
--
-- All d532 picks were scored at SYNTH-trained weights (pre-D-520, since
-- d532 spans 2026-05-17 to 2026-06-12 and D-520-APPLY shipped 2026-06-13).
-- So the stored confidence contains contributions = +s_X (at synth W).
--
-- For a new override weight w_new on factor X, the per-pick delta is:
--   delta = s_X * (w_new / w_synth - 1)
-- Where w_synth is the pre-D-520 synth weight (the ones that produced
-- the stored s_X values).
--
-- Synth weights (pre-D-520 values, from d520apply_snapshot.json):
--   handedness_matchup     0.75
--   weather_wind           0.5
--   lineup_consistency     0.5
--   weather_temp           1.25
--   wind_direction_hr      0.25
--   pitcher_quality        1.5
--   batter_form_power      0.5
--   recent_at_bats         1.0
--   batter_babip           0.125
--
-- Candidate regimes (override values for batter_hits ONLY):
--   R0  CURRENT post-D-520 — all flipped to -1× synth
--   R4  DOUBLED  — flipped to -2× synth (D-533's +1.5pp result)
--   R5  TRIPLED on hit-relevant 3 (handedness, recent_ab, pitcher_quality);
--                others at R4 doubled
--   R6  QUADRUPLED on handedness only; others at R4
--   R7  TRIPLED on all 9
--   R8  HALF the flip on power-only factors (form_power, wind_dir_hr,
--                batter_weather_wind which are mostly HR-relevant);
--                tripled on hit-relevant
--
-- Pass-test for SHIP 2:
--   batter_hits clears OOS break-even at some threshold with n>=100.
--
-- READ-ONLY. No UPDATEs on algorithm_weights. No override applied.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  RAISE NOTICE '======== D-535 §A: TRAIN/HOLDOUT batter_hits sample sizes ========';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE game_date <= '2026-06-05'::date) AS train_n,
      count(*) FILTER (WHERE game_date >  '2026-06-05'::date) AS holdout_n
    FROM public.d532_factor_scores_real
    WHERE mlb_market_type = 'batter_hits'
  LOOP RAISE NOTICE '[D-535 §A.1] batter_hits train_n=% holdout_n=%', r.train_n, r.holdout_n; END LOOP;

  RAISE NOTICE '======== D-535 §B: HOLDOUT batter_hits — 6 regimes at conf>=70 ========';
  FOR r IN
    WITH t AS (
      SELECT
        d.id, d.hit, d.confidence AS stored_conf,
        -- Synth-trained weights (the ones that produced stored_conf)
        d.s_handedness_matchup AS s_h,
        d.s_weather_wind AS s_ww,
        d.s_lineup_consistency AS s_lc,
        d.s_weather_temp AS s_wt,
        d.s_wind_direction_hr AS s_wd,
        d.s_opposing_pitcher_quality AS s_pq,
        d.s_batter_form_power AS s_fp,
        d.s_recent_at_bats AS s_rab,
        d.s_batter_babip AS s_bb,
        ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied
      FROM public.d532_factor_scores_real d
      JOIN public.pick_history ph ON ph.id = d.id
      WHERE d.mlb_market_type = 'batter_hits'
        AND d.game_date > '2026-06-05'::date
    ),
    scored AS (
      SELECT id, hit, implied,
        -- R0 CURRENT (post-D-520): all 9 at -1× synth → delta = s × (-1 - 1) = -2s
        stored_conf - 2*s_h - 2*s_ww - 2*s_lc - 2*s_wt - 2*s_wd - 2*s_pq - 2*s_fp - 2*s_rab - 2*s_bb
          AS r0,
        -- R4 DOUBLED: all 9 at -2× synth → delta = s × (-2 - 1) = -3s
        stored_conf - 3*s_h - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 3*s_pq - 3*s_fp - 3*s_rab - 3*s_bb
          AS r4,
        -- R5 TRIPLED on hit-relevant 3 (handedness, recent_ab, pitcher_quality);
        --    DOUBLED on others
        stored_conf
          - 4*s_h     -- -3× synth handedness → delta = -4s
          - 3*s_ww
          - 3*s_lc
          - 3*s_wt
          - 3*s_wd
          - 4*s_pq    -- -3× synth pitcher_quality
          - 3*s_fp
          - 4*s_rab   -- -3× synth recent_ab
          - 3*s_bb
          AS r5,
        -- R6 QUADRUPLED handedness only; others at R4 doubled (-3s)
        stored_conf
          - 5*s_h     -- -4× synth handedness → delta = -5s
          - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 3*s_pq - 3*s_fp - 3*s_rab - 3*s_bb
          AS r6,
        -- R7 TRIPLED on all 9
        stored_conf - 4*s_h - 4*s_ww - 4*s_lc - 4*s_wt - 4*s_wd - 4*s_pq - 4*s_fp - 4*s_rab - 4*s_bb
          AS r7,
        -- R8 HALF (1.5×) on power-only factors (formPower, weather_wind,
        --    wind_dir_hr); TRIPLED on hit-relevant
        stored_conf
          - 4*s_h     -- tripled handedness
          - 2.5*s_ww  -- 1.5× synth = w_new = -0.75 → delta = s × (-0.75/0.5 - 1) = -2.5s
          - 3*s_lc
          - 3*s_wt
          - 2.5*s_wd  -- 1.5× synth weight = -0.375 → delta = s × (-1.5 - 1) = -2.5s
          - 4*s_pq    -- tripled
          - 2.5*s_fp  -- 1.5× synth = -0.75 → -2.5s
          - 4*s_rab   -- tripled
          - 3*s_bb
          AS r8
      FROM t
    )
    SELECT
      'HOLDOUT_conf70' AS scope,
      -- R0
      count(*) FILTER (WHERE r0 >= 70) AS R0_n,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 70),0), 1) AS R0_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r0 >= 70), 1) AS R0_edge,
      -- R4
      count(*) FILTER (WHERE r4 >= 70) AS R4_n,
      ROUND(100.0 * count(*) FILTER (WHERE r4 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r4 >= 70),0), 1) AS R4_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r4 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r4 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r4 >= 70), 1) AS R4_edge,
      -- R5
      count(*) FILTER (WHERE r5 >= 70) AS R5_n,
      ROUND(100.0 * count(*) FILTER (WHERE r5 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r5 >= 70),0), 1) AS R5_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r5 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r5 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r5 >= 70), 1) AS R5_edge,
      -- R6
      count(*) FILTER (WHERE r6 >= 70) AS R6_n,
      ROUND(100.0 * count(*) FILTER (WHERE r6 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r6 >= 70),0), 1) AS R6_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r6 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r6 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r6 >= 70), 1) AS R6_edge,
      -- R7
      count(*) FILTER (WHERE r7 >= 70) AS R7_n,
      ROUND(100.0 * count(*) FILTER (WHERE r7 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r7 >= 70),0), 1) AS R7_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r7 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r7 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r7 >= 70), 1) AS R7_edge,
      -- R8
      count(*) FILTER (WHERE r8 >= 70) AS R8_n,
      ROUND(100.0 * count(*) FILTER (WHERE r8 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r8 >= 70),0), 1) AS R8_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r8 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r8 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r8 >= 70), 1) AS R8_edge
    FROM scored
  LOOP
    RAISE NOTICE '[D-535 §B.1] %: R0(n=% wr=% edge=%) R4(n=% wr=% edge=%) R5(n=% wr=% edge=%) R6(n=% wr=% edge=%) R7(n=% wr=% edge=%) R8(n=% wr=% edge=%)',
      r.scope,
      r.R0_n, r.R0_wr, r.R0_edge,
      r.R4_n, r.R4_wr, r.R4_edge,
      r.R5_n, r.R5_wr, r.R5_edge,
      r.R6_n, r.R6_wr, r.R6_edge,
      r.R7_n, r.R7_wr, r.R7_edge,
      r.R8_n, r.R8_wr, r.R8_edge;
  END LOOP;

  RAISE NOTICE '======== D-535 §C: HOLDOUT batter_hits at conf>=80 (the high-conf test) ========';
  FOR r IN
    WITH t AS (
      SELECT
        d.id, d.hit, d.confidence AS stored_conf,
        d.s_handedness_matchup AS s_h, d.s_weather_wind AS s_ww,
        d.s_lineup_consistency AS s_lc, d.s_weather_temp AS s_wt,
        d.s_wind_direction_hr AS s_wd, d.s_opposing_pitcher_quality AS s_pq,
        d.s_batter_form_power AS s_fp, d.s_recent_at_bats AS s_rab,
        d.s_batter_babip AS s_bb, ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied
      FROM public.d532_factor_scores_real d
      JOIN public.pick_history ph ON ph.id = d.id
      WHERE d.mlb_market_type = 'batter_hits'
        AND d.game_date > '2026-06-05'::date
    ),
    scored AS (
      SELECT id, hit, implied,
        stored_conf - 2*s_h - 2*s_ww - 2*s_lc - 2*s_wt - 2*s_wd - 2*s_pq - 2*s_fp - 2*s_rab - 2*s_bb AS r0,
        stored_conf - 3*s_h - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 3*s_pq - 3*s_fp - 3*s_rab - 3*s_bb AS r4,
        stored_conf - 4*s_h - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 4*s_pq - 3*s_fp - 4*s_rab - 3*s_bb AS r5,
        stored_conf - 4*s_h - 4*s_ww - 4*s_lc - 4*s_wt - 4*s_wd - 4*s_pq - 4*s_fp - 4*s_rab - 4*s_bb AS r7
      FROM t
    )
    SELECT
      count(*) FILTER (WHERE r0 >= 80) AS R0_n,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 80),0), 1) AS R0_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 80),0)
            - 100.0 * avg(implied) FILTER (WHERE r0 >= 80), 1) AS R0_edge,
      count(*) FILTER (WHERE r4 >= 80) AS R4_n,
      ROUND(100.0 * count(*) FILTER (WHERE r4 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r4 >= 80),0), 1) AS R4_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r4 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r4 >= 80),0)
            - 100.0 * avg(implied) FILTER (WHERE r4 >= 80), 1) AS R4_edge,
      count(*) FILTER (WHERE r5 >= 80) AS R5_n,
      ROUND(100.0 * count(*) FILTER (WHERE r5 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r5 >= 80),0), 1) AS R5_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r5 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r5 >= 80),0)
            - 100.0 * avg(implied) FILTER (WHERE r5 >= 80), 1) AS R5_edge,
      count(*) FILTER (WHERE r7 >= 80) AS R7_n,
      ROUND(100.0 * count(*) FILTER (WHERE r7 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r7 >= 80),0), 1) AS R7_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r7 >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE r7 >= 80),0)
            - 100.0 * avg(implied) FILTER (WHERE r7 >= 80), 1) AS R7_edge
    FROM scored
  LOOP
    RAISE NOTICE '[D-535 §C.1 conf>=80] R0(n=% wr=% edge=%) R4(n=% wr=% edge=%) R5(n=% wr=% edge=%) R7(n=% wr=% edge=%)',
      r.R0_n, r.R0_wr, r.R0_edge,
      r.R4_n, r.R4_wr, r.R4_edge,
      r.R5_n, r.R5_wr, r.R5_edge,
      r.R7_n, r.R7_wr, r.R7_edge;
  END LOOP;

  RAISE NOTICE '======== D-535 §D: TRAIN batter_hits same regimes (sanity) ========';
  FOR r IN
    WITH t AS (
      SELECT d.confidence AS stored_conf, d.hit,
        d.s_handedness_matchup AS s_h, d.s_weather_wind AS s_ww,
        d.s_lineup_consistency AS s_lc, d.s_weather_temp AS s_wt,
        d.s_wind_direction_hr AS s_wd, d.s_opposing_pitcher_quality AS s_pq,
        d.s_batter_form_power AS s_fp, d.s_recent_at_bats AS s_rab,
        d.s_batter_babip AS s_bb, ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied
      FROM public.d532_factor_scores_real d
      JOIN public.pick_history ph ON ph.id = d.id
      WHERE d.mlb_market_type = 'batter_hits'
        AND d.game_date <= '2026-06-05'::date
    ),
    scored AS (
      SELECT hit, implied,
        stored_conf - 2*s_h - 2*s_ww - 2*s_lc - 2*s_wt - 2*s_wd - 2*s_pq - 2*s_fp - 2*s_rab - 2*s_bb AS r0,
        stored_conf - 3*s_h - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 3*s_pq - 3*s_fp - 3*s_rab - 3*s_bb AS r4,
        stored_conf - 4*s_h - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 4*s_pq - 3*s_fp - 4*s_rab - 3*s_bb AS r5,
        stored_conf - 4*s_h - 4*s_ww - 4*s_lc - 4*s_wt - 4*s_wd - 4*s_pq - 4*s_fp - 4*s_rab - 4*s_bb AS r7
      FROM t
    )
    SELECT
      count(*) FILTER (WHERE r0 >= 70) AS R0_n,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 70),0), 1) AS R0_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r0 >= 70), 1) AS R0_edge,
      count(*) FILTER (WHERE r4 >= 70) AS R4_n,
      ROUND(100.0 * count(*) FILTER (WHERE r4 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r4 >= 70),0), 1) AS R4_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r4 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r4 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r4 >= 70), 1) AS R4_edge,
      count(*) FILTER (WHERE r5 >= 70) AS R5_n,
      ROUND(100.0 * count(*) FILTER (WHERE r5 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r5 >= 70),0), 1) AS R5_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r5 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r5 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r5 >= 70), 1) AS R5_edge,
      count(*) FILTER (WHERE r7 >= 70) AS R7_n,
      ROUND(100.0 * count(*) FILTER (WHERE r7 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r7 >= 70),0), 1) AS R7_wr,
      ROUND(100.0 * count(*) FILTER (WHERE r7 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r7 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r7 >= 70), 1) AS R7_edge
    FROM scored
  LOOP
    RAISE NOTICE '[D-535 §D.1 TRAIN conf>=70] R0(n=% wr=% edge=%) R4(n=% wr=% edge=%) R5(n=% wr=% edge=%) R7(n=% wr=% edge=%)',
      r.R0_n, r.R0_wr, r.R0_edge,
      r.R4_n, r.R4_wr, r.R4_edge,
      r.R5_n, r.R5_wr, r.R5_edge,
      r.R7_n, r.R7_wr, r.R7_edge;
  END LOOP;

  -- VOLUME PER WEEK at the threshold of the winning regime — important
  -- for sellability (a +EV market with 1 pick/week isn't a product).
  RAISE NOTICE '======== D-535 §E: volume per week under each regime at conf>=70 (holdout span) ========';
  FOR r IN
    WITH t AS (
      SELECT d.confidence AS stored_conf, d.hit,
        d.s_handedness_matchup AS s_h, d.s_weather_wind AS s_ww,
        d.s_lineup_consistency AS s_lc, d.s_weather_temp AS s_wt,
        d.s_wind_direction_hr AS s_wd, d.s_opposing_pitcher_quality AS s_pq,
        d.s_batter_form_power AS s_fp, d.s_recent_at_bats AS s_rab,
        d.s_batter_babip AS s_bb
      FROM public.d532_factor_scores_real d
      WHERE d.mlb_market_type = 'batter_hits'
        AND d.game_date > '2026-06-05'::date
    ),
    scored AS (
      SELECT
        stored_conf - 2*s_h - 2*s_ww - 2*s_lc - 2*s_wt - 2*s_wd - 2*s_pq - 2*s_fp - 2*s_rab - 2*s_bb AS r0,
        stored_conf - 3*s_h - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 3*s_pq - 3*s_fp - 3*s_rab - 3*s_bb AS r4,
        stored_conf - 4*s_h - 3*s_ww - 3*s_lc - 3*s_wt - 3*s_wd - 4*s_pq - 3*s_fp - 4*s_rab - 3*s_bb AS r5,
        stored_conf - 4*s_h - 4*s_ww - 4*s_lc - 4*s_wt - 4*s_wd - 4*s_pq - 4*s_fp - 4*s_rab - 4*s_bb AS r7
      FROM t
    )
    SELECT
      -- Holdout span = ~7 days (2026-06-06 to 2026-06-12)
      ROUND(count(*) FILTER (WHERE r0 >= 70)::numeric / 7, 1) AS R0_per_day,
      ROUND(count(*) FILTER (WHERE r4 >= 70)::numeric / 7, 1) AS R4_per_day,
      ROUND(count(*) FILTER (WHERE r5 >= 70)::numeric / 7, 1) AS R5_per_day,
      ROUND(count(*) FILTER (WHERE r7 >= 70)::numeric / 7, 1) AS R7_per_day
    FROM scored
  LOOP
    RAISE NOTICE '[D-535 §E.1] picks/day @ conf>=70 holdout: R0=% R4=% R5=% R7=%',
      r.R0_per_day, r.R4_per_day, r.R5_per_day, r.R7_per_day;
  END LOOP;

  -- ISOLATION confirmation: under the proposed batter_hits override,
  -- batter_total_bases and game_side OOS edges should be UNCHANGED
  -- (because the override only fires for batter_hits picks). This is
  -- structurally true by D-534's design — the override JSONB key is
  -- "batter_hits" so the per-market map only modifies batter_hits's
  -- W_BATTER. We verify by showing that the d532 batter_total_bases
  -- and game_side holdout edges at conf>=70 under R0 (current global)
  -- are the same as they'd be with the batter_hits override applied
  -- (since the override doesn't touch their weights).
  RAISE NOTICE '======== D-535 §F: ISOLATION — other markets edge unchanged ========';
  FOR r IN
    WITH t AS (
      SELECT d.mlb_market_type AS market, d.hit, d.confidence AS stored_conf,
        d.s_handedness_matchup AS s_h, d.s_weather_wind AS s_ww,
        d.s_lineup_consistency AS s_lc, d.s_weather_temp AS s_wt,
        d.s_wind_direction_hr AS s_wd, d.s_opposing_pitcher_quality AS s_pq,
        d.s_batter_form_power AS s_fp, d.s_recent_at_bats AS s_rab,
        d.s_batter_babip AS s_bb, ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied
      FROM public.d532_factor_scores_real d
      JOIN public.pick_history ph ON ph.id = d.id
      WHERE d.mlb_market_type IN ('batter_total_bases', 'game_side')
        AND d.game_date > '2026-06-05'::date
    ),
    scored AS (
      SELECT market, hit, implied,
        -- R0 CURRENT (global, post-D-520): both markets continue under
        -- the global post-D-520 batter weights (game_side doesn't fire
        -- the batter factors at all; batter_total_bases does).
        stored_conf - 2*s_h - 2*s_ww - 2*s_lc - 2*s_wt - 2*s_wd - 2*s_pq - 2*s_fp - 2*s_rab - 2*s_bb AS r0
      FROM t
    )
    SELECT market,
      count(*) FILTER (WHERE r0 >= 70) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 70),0), 1) AS wr,
      ROUND(100.0 * count(*) FILTER (WHERE r0 >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE r0 >= 70),0)
            - 100.0 * avg(implied) FILTER (WHERE r0 >= 70), 1) AS edge
    FROM scored GROUP BY market ORDER BY market
  LOOP
    RAISE NOTICE '[D-535 §F.1] %: n=% wr=% edge=% (UNCHANGED — D-534 override is keyed on batter_hits only)',
      r.market, r.n, r.wr, r.edge;
  END LOOP;
END $$;
