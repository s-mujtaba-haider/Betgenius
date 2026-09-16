-- D-538 SHIP 1 — Dry-run impact of the hard-gate: refuse to write a
-- pick where sign(projected_stat − line) ≠ pick_side.
--
-- Compute per market on the organic resolved corpus:
--   current    : n / WR / edge at conf>=70
--   gated_rmvd : how many picks the gate would REMOVE at conf>=70
--   gated_kept : the AGREE-with-projection subset at conf>=70 (what survives)
--
-- Also TRAIN/HOLDOUT split to confirm the gate improves edge OOS.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  RAISE NOTICE '======== D-538 §A: pre/post-gate at conf>=70 (full organic corpus) ========';
  FOR r IN
    WITH t AS (
      SELECT
        mlb_market_type AS market,
        hit, odds,
        CASE WHEN odds > 0 THEN 100.0/(odds+100)
             ELSE (-odds)*1.0/((-odds)+100) END AS implied,
        -- agree-with-projection?
        ((pick_side = 'over' AND projected_stat > line)
         OR (pick_side = 'under' AND projected_stat < line)) AS agrees
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND projected_stat IS NOT NULL
        AND confidence >= 70
        AND mlb_market_type IS NOT NULL
        AND pick_side IN ('over','under')
    )
    SELECT
      market,
      -- CURRENT (everything at conf>=70)
      count(*) AS cur_n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS cur_wr,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0)
            - 100.0 * avg(implied), 1) AS cur_edge,
      -- GATED-OUT (would be removed by hard-gate)
      count(*) FILTER (WHERE NOT agrees) AS removed_n,
      ROUND(100.0 * count(*) FILTER (WHERE NOT agrees) / NULLIF(count(*),0), 1) AS pct_removed,
      ROUND(100.0 * count(*) FILTER (WHERE NOT agrees AND hit) / NULLIF(count(*) FILTER (WHERE NOT agrees),0), 1) AS removed_wr,
      -- KEPT (what survives the gate)
      count(*) FILTER (WHERE agrees) AS kept_n,
      ROUND(100.0 * count(*) FILTER (WHERE agrees AND hit) / NULLIF(count(*) FILTER (WHERE agrees),0), 1) AS kept_wr,
      ROUND(100.0 * count(*) FILTER (WHERE agrees AND hit) / NULLIF(count(*) FILTER (WHERE agrees),0)
            - 100.0 * avg(implied) FILTER (WHERE agrees), 1) AS kept_edge
    FROM t GROUP BY market ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-538 §A.1] mkt=% cur(n=% WR=% edge=%) removed(n=% pct=% WR=%) kept(n=% WR=% edge=%)',
    r.market, r.cur_n, r.cur_wr, r.cur_edge,
    r.removed_n, r.pct_removed, r.removed_wr,
    r.kept_n, r.kept_wr, r.kept_edge; END LOOP;

  RAISE NOTICE '======== D-538 §B: HOLDOUT (d532 organic, game_date > 2026-06-05) at conf>=70 ========';
  FOR r IN
    WITH t AS (
      SELECT
        ph.mlb_market_type AS market,
        ph.hit, ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied,
        ((ph.pick_side = 'over' AND ph.projected_stat > ph.line)
         OR (ph.pick_side = 'under' AND ph.projected_stat < ph.line)) AS agrees
      FROM public.pick_history ph
      WHERE ph.sport='mlb' AND ph.is_synthetic=false AND ph.voided IS NOT TRUE
        AND ph.hit IS NOT NULL AND ph.projected_stat IS NOT NULL
        AND ph.confidence >= 70
        AND ph.mlb_market_type IS NOT NULL
        AND ph.pick_side IN ('over','under')
        AND ph.game_date > '2026-06-05'::date
        AND ph.breakdown IS NOT NULL
    )
    SELECT market,
      count(*) AS cur_n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS cur_wr,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0)
            - 100.0 * avg(implied), 1) AS cur_edge,
      count(*) FILTER (WHERE agrees) AS kept_n,
      ROUND(100.0 * count(*) FILTER (WHERE agrees AND hit) / NULLIF(count(*) FILTER (WHERE agrees),0), 1) AS kept_wr,
      ROUND(100.0 * count(*) FILTER (WHERE agrees AND hit) / NULLIF(count(*) FILTER (WHERE agrees),0)
            - 100.0 * avg(implied) FILTER (WHERE agrees), 1) AS kept_edge
    FROM t GROUP BY market ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-538 §B.1 HOLDOUT] mkt=% cur(n=% WR=% edge=%) kept(n=% WR=% edge=%)',
    r.market, r.cur_n, r.cur_wr, r.cur_edge, r.kept_n, r.kept_wr, r.kept_edge; END LOOP;

  RAISE NOTICE '======== D-538 §C: HOLDOUT at conf>=80 (high-conf product surface) ========';
  FOR r IN
    WITH t AS (
      SELECT
        ph.mlb_market_type AS market,
        ph.hit, ph.odds,
        CASE WHEN ph.odds > 0 THEN 100.0/(ph.odds+100)
             ELSE (-ph.odds)*1.0/((-ph.odds)+100) END AS implied,
        ((ph.pick_side = 'over' AND ph.projected_stat > ph.line)
         OR (ph.pick_side = 'under' AND ph.projected_stat < ph.line)) AS agrees
      FROM public.pick_history ph
      WHERE ph.sport='mlb' AND ph.is_synthetic=false AND ph.voided IS NOT TRUE
        AND ph.hit IS NOT NULL AND ph.projected_stat IS NOT NULL
        AND ph.confidence >= 80
        AND ph.mlb_market_type IS NOT NULL
        AND ph.pick_side IN ('over','under')
        AND ph.game_date > '2026-06-05'::date
        AND ph.breakdown IS NOT NULL
    )
    SELECT market,
      count(*) AS cur_n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS cur_wr,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0)
            - 100.0 * avg(implied), 1) AS cur_edge,
      count(*) FILTER (WHERE agrees) AS kept_n,
      ROUND(100.0 * count(*) FILTER (WHERE agrees AND hit) / NULLIF(count(*) FILTER (WHERE agrees),0), 1) AS kept_wr,
      ROUND(100.0 * count(*) FILTER (WHERE agrees AND hit) / NULLIF(count(*) FILTER (WHERE agrees),0)
            - 100.0 * avg(implied) FILTER (WHERE agrees), 1) AS kept_edge
    FROM t GROUP BY market ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-538 §C.1 HOLDOUT@80] mkt=% cur(n=% WR=% edge=%) kept(n=% WR=% edge=%)',
    r.market, r.cur_n, r.cur_wr, r.cur_edge, r.kept_n, r.kept_wr, r.kept_edge; END LOOP;
END $$;
