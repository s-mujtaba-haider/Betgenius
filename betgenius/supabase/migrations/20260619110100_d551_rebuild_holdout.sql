-- D-551 SHIPs 2+3 — pitcher_k rebuild candidates + holdout validation.
--
-- Read-only. The SHIP 1 diagnosis: corr(proj_edge, actual_resid)=0.042 —
-- the projection's direction signal is essentially noise relative to the
-- line. Likely market-efficiency wall (book has equivalent inputs).
-- This batch still tries rebuild variants to confirm or rule out a
-- structural fix. Each candidate is mean-centered and tested against
-- a strict hash-by-id holdout.
--
-- Candidates:
--   V0 CURRENT: breakdown.projected_k (the baseline)
--   V1 LAST5_ONLY: last5_k_avg (the §D winner — 52.87% sa_full)
--   V2 BLENDED_NO_MULT: 0.5*last5 + 0.5*season (no opp/park multipliers
--      that may dilute signal)
--   V3 STATCAST_ADD: V2 + xera-derived (statcast_xera maps inversely
--      to K; subtract scaled term)
--   V4 PITCHER_BAA_ADD: V2 + pitcher_baa-derived term
--   V5 STATCAST_COMBO: V2 + xera_term + baa_term (all signal-bearing)
--
-- For each Vn, we evaluate on TRAIN (75%) and TEST (25%) holdout splits.
-- Pick_side is RE-DERIVED from Vn for sign-accuracy purposes (this is
-- the projection rebuild test — we're testing whether Vn picks the
-- right SIDE, not whether reweighted confidence helps).

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  CREATE TEMP TABLE d551_corpus AS
  SELECT
    id,
    actual_value AS actual,
    line,
    pick_side,
    hit, odds, confidence,
    (breakdown->>'projected_k')::numeric          AS V0_curr,
    (breakdown->>'last5_k_avg')::numeric          AS last5,
    (breakdown->>'season_k_per_start')::numeric   AS season,
    -- statcast_xera (LOWER is BETTER for K): typical range 2.5-5.5.
    -- A pitcher 1 point BELOW league avg (~4.0) → expect more K.
    -- Coefficient -0.4 K per point below avg is empirical-ish.
    CASE WHEN (breakdown->>'statcast_xera') ~ '^-?[0-9.]+$'
         THEN (breakdown->>'statcast_xera')::numeric END AS xera,
    -- statcast_pitcher_baa (LOWER is BETTER for K): typical 0.22-0.30.
    -- 0.04 below avg (~0.25) → +0.5 K expected.
    CASE WHEN (breakdown->>'statcast_pitcher_baa') ~ '^-?[0-9.]+$'
         THEN (breakdown->>'statcast_pitcher_baa')::numeric END AS baa,
    (abs(hashtext(id::text)) % 4 = 0) AS is_test
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
    AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
    AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
    AND breakdown ? 'last5_k_avg' AND breakdown ? 'season_k_per_start';

  -- Compute candidate projections per row
  CREATE TEMP TABLE d551_proj AS
  SELECT *,
    last5                                                          AS V1_last5,
    0.5 * last5 + 0.5 * season                                     AS V2_blend,
    0.5 * last5 + 0.5 * season + COALESCE((4.0 - xera) * 0.5, 0)   AS V3_xera,
    0.5 * last5 + 0.5 * season + COALESCE((0.25 - baa) * 15, 0)    AS V4_baa,
    0.5 * last5 + 0.5 * season
      + COALESCE((4.0 - xera) * 0.4, 0)
      + COALESCE((0.25 - baa) * 10, 0)                             AS V5_combo
  FROM d551_corpus;

  RAISE NOTICE '======== D-551 rebuild §A: FULL corpus correlation w/ actual ========';
  FOR r IN
    SELECT
      count(*) AS n,
      ROUND(corr(V0_curr, actual)::numeric, 4) AS r0,
      ROUND(corr(V1_last5, actual)::numeric, 4) AS r1,
      ROUND(corr(V2_blend, actual)::numeric, 4) AS r2,
      ROUND(corr(V3_xera, actual)::numeric, 4) AS r3,
      ROUND(corr(V4_baa, actual)::numeric, 4) AS r4,
      ROUND(corr(V5_combo, actual)::numeric, 4) AS r5
    FROM d551_proj
  LOOP RAISE NOTICE '[D-551 rebuild §A.1] FULL n=% r_V0=% r_V1=% r_V2=% r_V3=% r_V4=% r_V5=%',
    r.n, r.r0, r.r1, r.r2, r.r3, r.r4, r.r5; END LOOP;

  RAISE NOTICE '======== D-551 rebuild §B: TRAIN sign-acc + TEST sign-acc (the OOS gate) ========';
  -- TRAIN
  FOR r IN
    SELECT 'TRAIN' AS scope, count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V0_curr > line AND actual > line) OR (V0_curr < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V0_curr <> line AND actual <> line), 0)::numeric, 2) AS sa0,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V1_last5 > line AND actual > line) OR (V1_last5 < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V1_last5 <> line AND actual <> line), 0)::numeric, 2) AS sa1,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V2_blend > line AND actual > line) OR (V2_blend < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V2_blend <> line AND actual <> line), 0)::numeric, 2) AS sa2,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V3_xera > line AND actual > line) OR (V3_xera < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V3_xera <> line AND actual <> line), 0)::numeric, 2) AS sa3,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V4_baa > line AND actual > line) OR (V4_baa < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V4_baa <> line AND actual <> line), 0)::numeric, 2) AS sa4,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V5_combo > line AND actual > line) OR (V5_combo < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V5_combo <> line AND actual <> line), 0)::numeric, 2) AS sa5
    FROM d551_proj WHERE NOT is_test
  LOOP RAISE NOTICE '[D-551 rebuild §B.1] TRAIN n=% sa_V0=% V1=% V2=% V3=% V4=% V5=%',
    r.n, r.sa0, r.sa1, r.sa2, r.sa3, r.sa4, r.sa5; END LOOP;

  -- TEST OOS
  FOR r IN
    SELECT 'TEST' AS scope, count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V0_curr > line AND actual > line) OR (V0_curr < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V0_curr <> line AND actual <> line), 0)::numeric, 2) AS sa0,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V1_last5 > line AND actual > line) OR (V1_last5 < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V1_last5 <> line AND actual <> line), 0)::numeric, 2) AS sa1,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V2_blend > line AND actual > line) OR (V2_blend < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V2_blend <> line AND actual <> line), 0)::numeric, 2) AS sa2,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V3_xera > line AND actual > line) OR (V3_xera < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V3_xera <> line AND actual <> line), 0)::numeric, 2) AS sa3,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V4_baa > line AND actual > line) OR (V4_baa < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V4_baa <> line AND actual <> line), 0)::numeric, 2) AS sa4,
      ROUND(100.0 * count(*) FILTER (WHERE
        (V5_combo > line AND actual > line) OR (V5_combo < line AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE V5_combo <> line AND actual <> line), 0)::numeric, 2) AS sa5
    FROM d551_proj WHERE is_test
  LOOP RAISE NOTICE '[D-551 rebuild §B.2] TEST  n=% sa_V0=% V1=% V2=% V3=% V4=% V5=%',
    r.n, r.sa0, r.sa1, r.sa2, r.sa3, r.sa4, r.sa5; END LOOP;

  -- =================================================================
  -- §C — OOS edge under each rebuilt projection, with REAL per-pick BE
  -- For each Vn, recompute pick_side from Vn (over if Vn>line, else under).
  -- Then WR vs real BE.
  -- =================================================================
  RAISE NOTICE '======== D-551 rebuild §C: TEST (OOS) edge under each candidate proj ========';
  FOR r IN
    WITH e AS (
      SELECT *,
        CASE WHEN V0_curr > line THEN 'over' ELSE 'under' END AS new_side0,
        CASE WHEN V1_last5 > line THEN 'over' ELSE 'under' END AS new_side1,
        CASE WHEN V2_blend > line THEN 'over' ELSE 'under' END AS new_side2,
        CASE WHEN V3_xera > line THEN 'over' ELSE 'under' END AS new_side3,
        CASE WHEN V5_combo > line THEN 'over' ELSE 'under' END AS new_side5
      FROM d551_proj WHERE is_test
    ),
    -- A "rebuilt-pick" hits iff new_side matches the actual outcome direction
    h AS (
      SELECT *,
        (new_side0 = 'over' AND actual > line) OR (new_side0 = 'under' AND actual < line) AS hit_V0,
        (new_side1 = 'over' AND actual > line) OR (new_side1 = 'under' AND actual < line) AS hit_V1,
        (new_side2 = 'over' AND actual > line) OR (new_side2 = 'under' AND actual < line) AS hit_V2,
        (new_side3 = 'over' AND actual > line) OR (new_side3 = 'under' AND actual < line) AS hit_V3,
        (new_side5 = 'over' AND actual > line) OR (new_side5 = 'under' AND actual < line) AS hit_V5
      FROM e
    )
    SELECT
      count(*) AS n,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit_V0) / NULLIF(count(*), 0)::numeric, 2) AS wr_V0,
      ROUND(100.0 * count(*) FILTER (WHERE hit_V1) / NULLIF(count(*), 0)::numeric, 2) AS wr_V1,
      ROUND(100.0 * count(*) FILTER (WHERE hit_V2) / NULLIF(count(*), 0)::numeric, 2) AS wr_V2,
      ROUND(100.0 * count(*) FILTER (WHERE hit_V3) / NULLIF(count(*), 0)::numeric, 2) AS wr_V3,
      ROUND(100.0 * count(*) FILTER (WHERE hit_V5) / NULLIF(count(*), 0)::numeric, 2) AS wr_V5
    FROM h
  LOOP RAISE NOTICE '[D-551 rebuild §C.1] TEST n=% avg_BE=% wr_V0=% V1=% V2=% V3=% V5=%',
    r.n, r.avg_BE, r.wr_V0, r.wr_V1, r.wr_V2, r.wr_V3, r.wr_V5; END LOOP;

  -- =================================================================
  -- §D — diagnostic: actual variance vs projection variance per candidate
  -- =================================================================
  RAISE NOTICE '======== D-551 rebuild §D: variance vs line per candidate (full corpus) ========';
  FOR r IN
    SELECT
      ROUND(stddev(V0_curr - line)::numeric, 3) AS sd0,
      ROUND(stddev(V1_last5 - line)::numeric, 3) AS sd1,
      ROUND(stddev(V2_blend - line)::numeric, 3) AS sd2,
      ROUND(stddev(V3_xera - line)::numeric, 3) AS sd3,
      ROUND(stddev(V5_combo - line)::numeric, 3) AS sd5,
      ROUND(stddev(actual - line)::numeric, 3) AS sd_actual
    FROM d551_proj
  LOOP RAISE NOTICE '[D-551 rebuild §D.1] sd_proj_edge V0=% V1=% V2=% V3=% V5=% | sd_actual_resid=%',
    r.sd0, r.sd1, r.sd2, r.sd3, r.sd5, r.sd_actual; END LOOP;

  -- =================================================================
  -- §E — corr(Vn_edge, actual_residual) — the smoking gun reprise
  -- =================================================================
  RAISE NOTICE '======== D-551 rebuild §E: corr(Vn_edge, actual-line) (full corpus) ========';
  FOR r IN
    SELECT
      ROUND(corr(V0_curr - line, actual - line)::numeric, 4) AS c0,
      ROUND(corr(V1_last5 - line, actual - line)::numeric, 4) AS c1,
      ROUND(corr(V2_blend - line, actual - line)::numeric, 4) AS c2,
      ROUND(corr(V3_xera - line, actual - line)::numeric, 4) AS c3,
      ROUND(corr(V5_combo - line, actual - line)::numeric, 4) AS c5
    FROM d551_proj
  LOOP RAISE NOTICE '[D-551 rebuild §E.1] corr_edge_vs_actresid V0=% V1=% V2=% V3=% V5=%',
    r.c0, r.c1, r.c2, r.c3, r.c5; END LOOP;

  DROP TABLE d551_proj;
  DROP TABLE d551_corpus;
END $$;
