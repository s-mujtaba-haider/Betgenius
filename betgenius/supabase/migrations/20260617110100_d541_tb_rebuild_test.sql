-- D-541 SHIP 2+3 — batter_total_bases rebuild candidates + OOS validation.
--
-- Read-only. Pure SELECTs + RAISE NOTICE. No INSERT/UPDATE/ALTER.
--
-- SHIP 1 verdict was GRAY ZONE — no single input crosses r=0.20 but 4
-- inputs > |r|=0.10 and the current projection (r=0.098) is WORSE than
-- raw season_avg (r=0.121). The multiplicative pitcherAdj/parkAdj are
-- diluting signal. Test rebuild candidates to see if a linear combo
-- can cross r=0.20 OOS — and crucially measure sign-accuracy to avoid
-- the D-539 V4/V6 trap (high r but below-chance direction).
--
-- OOS split: abs(hashtext(id::text)) % 4 = 0 → TEST (~25%).
--            else → TRAIN (~75%).
-- Hash-by-UUID; avoids time-drift confounds. Same fixed partition
-- across all candidates so results are comparable.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  RAISE NOTICE '======== D-541 SHIP 2: rebuild candidates — definitions ========';
  RAISE NOTICE 'V0 CURRENT         = breakdown.projected_stat (as-is)';
  RAISE NOTICE 'V1 SEASON_ONLY     = season_avg_per_game raw (no adj)';
  RAISE NOTICE 'V2 BLEND_NO_MULT   = 0.55*last10_avg + 0.45*season_avg (no pitcherAdj/parkAdj)';
  RAISE NOTICE 'V3 EV_BOOST        = V2 + clamp((avg_hit_speed - 89.0) * 0.05, -0.30, 0.30)';
  RAISE NOTICE 'V4 SLOT_AWARE      = V3 + (5 - lineup_spot) * 0.08    [higher slot = lower expected TB]';
  RAISE NOTICE 'V5 BARREL_ADD      = V4 + clamp((brl_pa - 6.0) * 0.04, -0.30, 0.30)';
  RAISE NOTICE 'V6 STATCAST_HEAVY  = 0.40*season_avg + 0.35*EV_norm + 0.25*BRL_norm';
  RAISE NOTICE '                     where EV_norm = (hit_speed - 89) * 0.10 + season_avg';
  RAISE NOTICE '                     where BRL_norm = (brl_pa - 6) * 0.08 + season_avg';
  RAISE NOTICE 'V7 SLOT_BASELINE   = league-typical TB/game by slot only (slot mean)';

  -- ===================================================================
  -- §A — FULL CORPUS r for each candidate (n=2625)
  -- ===================================================================
  RAISE NOTICE '======== D-541 §A: FULL CORPUS r per candidate ========';

  CREATE TEMP TABLE d541_corpus AS
  SELECT
    id,
    actual_value AS actual,
    line,
    pick_side,
    (breakdown->>'projected_stat')::numeric AS proj_current,
    (breakdown->>'season_avg_per_game')::numeric AS season_avg,
    (breakdown->>'last10_avg')::numeric AS l10_avg,
    NULLIF(breakdown->>'lineup_spot', '')::numeric AS slot,
    CASE WHEN (breakdown->>'statcast_avg_hit_speed') ~ '^-?[0-9.]+$'
         THEN (breakdown->>'statcast_avg_hit_speed')::numeric END AS ev,
    CASE WHEN (breakdown->>'statcast_brl_pa') ~ '^-?[0-9.]+$'
         THEN (breakdown->>'statcast_brl_pa')::numeric END AS brl,
    -- OOS split: hash by UUID. Fixed partition (~25% TEST).
    (abs(hashtext(id::text)) % 4 = 0) AS is_test
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
    AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
    AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
    AND breakdown ? 'season_avg_per_game'
    AND breakdown ? 'last10_avg';

  -- Compute candidate projections per row
  CREATE TEMP TABLE d541_proj AS
  SELECT
    id, actual, line, pick_side, is_test, slot,
    proj_current AS V0,
    season_avg AS V1,
    (0.55*l10_avg + 0.45*season_avg) AS V2,
    (0.55*l10_avg + 0.45*season_avg
       + COALESCE(GREATEST(LEAST((ev - 89.0) * 0.05, 0.30), -0.30), 0)) AS V3,
    (0.55*l10_avg + 0.45*season_avg
       + COALESCE(GREATEST(LEAST((ev - 89.0) * 0.05, 0.30), -0.30), 0)
       + COALESCE(CASE WHEN slot BETWEEN 1 AND 9 THEN (5 - slot) * 0.08 END, 0)) AS V4,
    (0.55*l10_avg + 0.45*season_avg
       + COALESCE(GREATEST(LEAST((ev - 89.0) * 0.05, 0.30), -0.30), 0)
       + COALESCE(CASE WHEN slot BETWEEN 1 AND 9 THEN (5 - slot) * 0.08 END, 0)
       + COALESCE(GREATEST(LEAST((brl - 6.0) * 0.04, 0.30), -0.30), 0)) AS V5,
    (0.40 * season_avg
       + 0.35 * (COALESCE((ev - 89.0) * 0.10, 0) + season_avg)
       + 0.25 * (COALESCE((brl - 6.0) * 0.08, 0) + season_avg)) AS V6,
    -- V7 slot baseline derived from §C empirical means.
    -- Use overall mean (1.49) when slot is missing.
    CASE
      WHEN slot = 1 THEN 1.821
      WHEN slot = 2 THEN 1.960
      WHEN slot = 3 THEN 1.803
      WHEN slot = 4 THEN 1.696
      WHEN slot = 5 THEN 1.455
      WHEN slot = 6 THEN 1.604
      WHEN slot = 7 THEN 1.344
      WHEN slot = 8 THEN 1.260
      WHEN slot = 9 THEN 1.150
      ELSE 1.490
    END AS V7
  FROM d541_corpus;

  FOR r IN
    SELECT
      'FULL' AS scope,
      count(*) AS n,
      ROUND(corr(V0::numeric, actual)::numeric, 4) AS r_V0,
      ROUND(corr(V1::numeric, actual)::numeric, 4) AS r_V1,
      ROUND(corr(V2::numeric, actual)::numeric, 4) AS r_V2,
      ROUND(corr(V3::numeric, actual)::numeric, 4) AS r_V3,
      ROUND(corr(V4::numeric, actual)::numeric, 4) AS r_V4,
      ROUND(corr(V5::numeric, actual)::numeric, 4) AS r_V5,
      ROUND(corr(V6::numeric, actual)::numeric, 4) AS r_V6,
      ROUND(corr(V7::numeric, actual)::numeric, 4) AS r_V7
    FROM d541_proj
  LOOP RAISE NOTICE '[D-541 §A.1] FULL n=% V0=% V1=% V2=% V3=% V4=% V5=% V6=% V7=%',
    r.n, r.r_V0, r.r_V1, r.r_V2, r.r_V3, r.r_V4, r.r_V5, r.r_V6, r.r_V7; END LOOP;

  -- ===================================================================
  -- §B — TRAIN vs TEST split (OOS validation)
  -- ===================================================================
  RAISE NOTICE '======== D-541 §B: TRAIN/TEST split r per candidate ========';

  FOR r IN
    SELECT
      'TRAIN' AS scope,
      count(*) AS n,
      ROUND(corr(V0::numeric, actual)::numeric, 4) AS r_V0,
      ROUND(corr(V1::numeric, actual)::numeric, 4) AS r_V1,
      ROUND(corr(V2::numeric, actual)::numeric, 4) AS r_V2,
      ROUND(corr(V3::numeric, actual)::numeric, 4) AS r_V3,
      ROUND(corr(V4::numeric, actual)::numeric, 4) AS r_V4,
      ROUND(corr(V5::numeric, actual)::numeric, 4) AS r_V5,
      ROUND(corr(V6::numeric, actual)::numeric, 4) AS r_V6,
      ROUND(corr(V7::numeric, actual)::numeric, 4) AS r_V7
    FROM d541_proj WHERE NOT is_test
  LOOP RAISE NOTICE '[D-541 §B.1] TRAIN n=% V0=% V1=% V2=% V3=% V4=% V5=% V6=% V7=%',
    r.n, r.r_V0, r.r_V1, r.r_V2, r.r_V3, r.r_V4, r.r_V5, r.r_V6, r.r_V7; END LOOP;

  FOR r IN
    SELECT
      'TEST (OOS)' AS scope,
      count(*) AS n,
      ROUND(corr(V0::numeric, actual)::numeric, 4) AS r_V0,
      ROUND(corr(V1::numeric, actual)::numeric, 4) AS r_V1,
      ROUND(corr(V2::numeric, actual)::numeric, 4) AS r_V2,
      ROUND(corr(V3::numeric, actual)::numeric, 4) AS r_V3,
      ROUND(corr(V4::numeric, actual)::numeric, 4) AS r_V4,
      ROUND(corr(V5::numeric, actual)::numeric, 4) AS r_V5,
      ROUND(corr(V6::numeric, actual)::numeric, 4) AS r_V6,
      ROUND(corr(V7::numeric, actual)::numeric, 4) AS r_V7
    FROM d541_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §B.2] TEST  n=% V0=% V1=% V2=% V3=% V4=% V5=% V6=% V7=%',
    r.n, r.r_V0, r.r_V1, r.r_V2, r.r_V3, r.r_V4, r.r_V5, r.r_V6, r.r_V7; END LOOP;

  -- ===================================================================
  -- §C — SIGN-ACCURACY OOS per candidate (the D-539 V4/V6 trap check)
  --
  -- For each pick: does (projected > line) match (actual > line)?
  -- Reported on TEST split only. Coin flip = 50%. Current proj on FULL
  -- corpus was 57.12% per the SHIP 1 §D notice.
  -- ===================================================================
  RAISE NOTICE '======== D-541 §C: TEST (OOS) sign-accuracy per candidate ========';

  FOR r IN
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE actual <> line) AS n_dir,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V0 > line AND actual > line) OR (V0 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V0_pct,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V1 > line AND actual > line) OR (V1 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V1_pct,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V2 > line AND actual > line) OR (V2 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V2_pct,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V3 > line AND actual > line) OR (V3 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V3_pct,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V4 > line AND actual > line) OR (V4 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V4_pct,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V5 > line AND actual > line) OR (V5 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V5_pct,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V6 > line AND actual > line) OR (V6 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V6_pct,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V7 > line AND actual > line) OR (V7 < line AND actual < line))
        AND actual <> line
      ) / NULLIF(count(*) FILTER (WHERE actual <> line), 0)::numeric, 2) AS V7_pct
    FROM d541_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §C.1] TEST sign-acc (pct): V0=% V1=% V2=% V3=% V4=% V5=% V6=% V7=% n_dir=%',
    r.V0_pct, r.V1_pct, r.V2_pct, r.V3_pct, r.V4_pct, r.V5_pct, r.V6_pct, r.V7_pct, r.n_dir; END LOOP;

  -- ===================================================================
  -- §D — OOS BETTING EDGE under D-538 hard-gate.
  --
  -- The D-538 hard-gate refuses picks where projection direction <>
  -- pick_side direction (i.e., projection says UNDER but pick_side OVER).
  -- For each candidate, compute: of picks where projection agrees with
  -- the pick_side recorded in pick_history, what fraction win (hit=true)?
  --
  -- This is the bottom-line: would TB picks made by THIS candidate
  -- projection have been +EV in the OOS split?
  -- ===================================================================
  RAISE NOTICE '======== D-541 §D: TEST (OOS) edge under D-538 gate ========';
  RAISE NOTICE 'For each candidate Vn, gated_picks = picks where Vn>line matches pick_side=over OR Vn<line matches pick_side=under.';
  RAISE NOTICE 'win_pct = fraction where hit=true on gated picks. > 52.4 = +EV at -110 vig.';

  -- Need to know hit per pick — join back
  CREATE TEMP TABLE d541_proj_with_hit AS
  SELECT p.*, ph.hit
  FROM d541_proj p
  JOIN public.pick_history ph ON ph.id = p.id;

  -- For each candidate, count gated picks + their hit rate.
  -- (Could parameterize but simpler to enumerate.)
  FOR r IN
    SELECT 'V0' AS v,
      count(*) FILTER (WHERE
        (V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.1] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V1' AS v,
      count(*) FILTER (WHERE
        (V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.2] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V2' AS v,
      count(*) FILTER (WHERE
        (V2 > line AND pick_side='over') OR (V2 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V2 > line AND pick_side='over') OR (V2 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V2 > line AND pick_side='over') OR (V2 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.3] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V3' AS v,
      count(*) FILTER (WHERE
        (V3 > line AND pick_side='over') OR (V3 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V3 > line AND pick_side='over') OR (V3 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V3 > line AND pick_side='over') OR (V3 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.4] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V4' AS v,
      count(*) FILTER (WHERE
        (V4 > line AND pick_side='over') OR (V4 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V4 > line AND pick_side='over') OR (V4 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V4 > line AND pick_side='over') OR (V4 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.5] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V5' AS v,
      count(*) FILTER (WHERE
        (V5 > line AND pick_side='over') OR (V5 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V5 > line AND pick_side='over') OR (V5 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V5 > line AND pick_side='over') OR (V5 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.6] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V6' AS v,
      count(*) FILTER (WHERE
        (V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.7] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V7' AS v,
      count(*) FILTER (WHERE
        (V7 > line AND pick_side='over') OR (V7 < line AND pick_side='under')
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((V7 > line AND pick_side='over') OR (V7 < line AND pick_side='under')) AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (V7 > line AND pick_side='over') OR (V7 < line AND pick_side='under')
      ), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.8] %: gated_picks=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  -- Baseline: ungated win rate on TEST (organic, no gate)
  FOR r IN
    SELECT count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct
    FROM d541_proj_with_hit WHERE is_test
  LOOP RAISE NOTICE '[D-541 §D.9] BASELINE (no gate) TEST: n=% win_pct=%',
    r.n, r.win_pct; END LOOP;

  DROP TABLE d541_proj_with_hit;
  DROP TABLE d541_proj;
  DROP TABLE d541_corpus;
END $$;
