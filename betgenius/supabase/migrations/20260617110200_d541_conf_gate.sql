-- D-541 SHIP 3b — TB OOS edge under D-538 gate at conf>=70 / >=80
-- (the volume + confidence thresholds the spec asks for).
--
-- Read-only. Rebuilds the TEMP table from the SHIP 2/3 migration and
-- adds confidence filter. Verifies whether ANY candidate gives volume
-- + edge that would clear the §B threshold criteria for sellable
-- promotion at the user-tier confidence levels.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  CREATE TEMP TABLE d541b_proj AS
  WITH base AS (
    SELECT
      id, actual_value AS actual, line, pick_side, hit, confidence,
      (breakdown->>'projected_stat')::numeric AS proj_current,
      (breakdown->>'season_avg_per_game')::numeric AS season_avg,
      (breakdown->>'last10_avg')::numeric AS l10_avg,
      NULLIF(breakdown->>'lineup_spot', '')::numeric AS slot,
      CASE WHEN (breakdown->>'statcast_avg_hit_speed') ~ '^-?[0-9.]+$'
           THEN (breakdown->>'statcast_avg_hit_speed')::numeric END AS ev,
      CASE WHEN (breakdown->>'statcast_brl_pa') ~ '^-?[0-9.]+$'
           THEN (breakdown->>'statcast_brl_pa')::numeric END AS brl,
      (abs(hashtext(id::text)) % 4 = 0) AS is_test
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
      AND breakdown ? 'season_avg_per_game'
      AND breakdown ? 'last10_avg'
  )
  SELECT *,
    proj_current AS V0,
    season_avg AS V1,
    (0.55*l10_avg + 0.45*season_avg
       + COALESCE(GREATEST(LEAST((ev - 89.0) * 0.05, 0.30), -0.30), 0)) AS V3,
    (0.40 * season_avg
       + 0.35 * (COALESCE((ev - 89.0) * 0.10, 0) + season_avg)
       + 0.25 * (COALESCE((brl - 6.0) * 0.08, 0) + season_avg)) AS V6
  FROM base;

  -- conf>=70 ON CURRENT GATE
  RAISE NOTICE '======== D-541 §A: TB OOS at conf>=70, gated by each candidate ========';
  FOR r IN
    SELECT 'V0' AS v,
      count(*) FILTER (WHERE confidence >= 70 AND
        ((V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under'))
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND
        ((V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under'))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE confidence >= 70 AND
        ((V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under'))
      ), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §A.1] conf>=70 %: gated=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V1' AS v,
      count(*) FILTER (WHERE confidence >= 70 AND
        ((V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under'))
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND
        ((V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under'))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE confidence >= 70 AND
        ((V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under'))
      ), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §A.2] conf>=70 %: gated=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V3' AS v,
      count(*) FILTER (WHERE confidence >= 70 AND
        ((V3 > line AND pick_side='over') OR (V3 < line AND pick_side='under'))
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND
        ((V3 > line AND pick_side='over') OR (V3 < line AND pick_side='under'))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE confidence >= 70 AND
        ((V3 > line AND pick_side='over') OR (V3 < line AND pick_side='under'))
      ), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §A.3] conf>=70 %: gated=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V6' AS v,
      count(*) FILTER (WHERE confidence >= 70 AND
        ((V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under'))
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND
        ((V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under'))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE confidence >= 70 AND
        ((V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under'))
      ), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §A.4] conf>=70 %: gated=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  -- conf>=80
  RAISE NOTICE '======== D-541 §B: TB OOS at conf>=80, gated by each candidate ========';
  FOR r IN
    SELECT 'V0' AS v,
      count(*) FILTER (WHERE confidence >= 80 AND
        ((V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under'))
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND
        ((V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under'))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE confidence >= 80 AND
        ((V0 > line AND pick_side='over') OR (V0 < line AND pick_side='under'))
      ), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §B.1] conf>=80 %: gated=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V1' AS v,
      count(*) FILTER (WHERE confidence >= 80 AND
        ((V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under'))
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND
        ((V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under'))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE confidence >= 80 AND
        ((V1 > line AND pick_side='over') OR (V1 < line AND pick_side='under'))
      ), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §B.2] conf>=80 %: gated=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'V6' AS v,
      count(*) FILTER (WHERE confidence >= 80 AND
        ((V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under'))
      ) AS gated,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND
        ((V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under'))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE confidence >= 80 AND
        ((V6 > line AND pick_side='over') OR (V6 < line AND pick_side='under'))
      ), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §B.3] conf>=80 %: gated=% win_pct=%', r.v, r.gated, r.win_pct; END LOOP;

  -- Reference baseline
  RAISE NOTICE '======== D-541 §C: TB raw conf-tier win rates on TEST (no gate) ========';
  FOR r IN
    SELECT 'conf>=70 NO GATE' AS tier,
      count(*) FILTER (WHERE confidence >= 70) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND hit)
        / NULLIF(count(*) FILTER (WHERE confidence >= 70), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §C.1] %: n=% win_pct=%', r.tier, r.n, r.win_pct; END LOOP;

  FOR r IN
    SELECT 'conf>=80 NO GATE' AS tier,
      count(*) FILTER (WHERE confidence >= 80) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit)
        / NULLIF(count(*) FILTER (WHERE confidence >= 80), 0)::numeric, 2) AS win_pct
    FROM d541b_proj WHERE is_test
  LOOP RAISE NOTICE '[D-541 §C.2] %: n=% win_pct=%', r.tier, r.n, r.win_pct; END LOOP;

  DROP TABLE d541b_proj;
END $$;
