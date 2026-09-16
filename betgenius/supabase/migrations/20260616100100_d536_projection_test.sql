-- D-536 SHIP 1 — Projection vs actual outcome.
-- The make-or-break test: does the projected stat actually predict the
-- real outcome better than chance?
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- §E.1 — Sign-accuracy per market.
  -- sign(projected_stat − line) should match sign(actual_value − line)
  -- if the projection carries real signal. For a fair coin: 50%.
  RAISE NOTICE '======== D-536 §E: projection direction agreement with actual (sign-accuracy) ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      -- Sign agreement = projection predicts the right side of the line
      count(*) FILTER (WHERE
        (projected_stat > line AND actual_value > line)
        OR (projected_stat < line AND actual_value < line)
        OR (projected_stat = line AND actual_value = line)
      ) AS n_proj_correct,
      ROUND(100.0 * count(*) FILTER (WHERE
        (projected_stat > line AND actual_value > line)
        OR (projected_stat < line AND actual_value < line)
        OR (projected_stat = line AND actual_value = line)
      ) / NULLIF(count(*),0), 1) AS pct_correct,
      -- For comparison: the pick's actual WR
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS pick_wr
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL
      AND projected_stat IS NOT NULL AND actual_value IS NOT NULL
      AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type
    ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-536 §E.1] mkt=% n=% proj_correct_n=% proj_correct_pct=% (vs pick_WR=%)',
    r.market, r.n, r.n_proj_correct, r.pct_correct, r.pick_wr; END LOOP;

  -- §E.2 — Pearson correlation between projected_stat and actual_value.
  -- For each market — does the projection have any continuous predictive
  -- signal beyond the binary above-line/below-line direction?
  RAISE NOTICE '======== D-536 §F: Pearson corr(projected, actual) per market ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      ROUND(corr(projected_stat::numeric, actual_value::numeric)::numeric, 3) AS r_pearson,
      ROUND(avg(projected_stat)::numeric, 2) AS avg_proj,
      ROUND(avg(actual_value)::numeric, 2) AS avg_actual,
      ROUND(stddev(projected_stat)::numeric, 2) AS sd_proj,
      ROUND(stddev(actual_value)::numeric, 2) AS sd_actual
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL
      AND projected_stat IS NOT NULL AND actual_value IS NOT NULL
      AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type
    HAVING count(*) >= 50
    ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-536 §F.1] mkt=% n=% r=% avg_proj=% avg_actual=% sd_proj=% sd_actual=%',
    r.market, r.n, r.r_pearson, r.avg_proj, r.avg_actual, r.sd_proj, r.sd_actual; END LOOP;

  -- §E.3 — Calibration: if we rank picks purely by the raw edge magnitude
  -- |projected − line|, does WR rise with that magnitude? A predictive
  -- model should show monotonic increase: bigger projected distance
  -- from line → higher confidence → higher WR.
  RAISE NOTICE '======== D-536 §G: edge-magnitude calibration (per market) ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      CASE
        WHEN abs(projected_stat - line) < 0.25 THEN '0.00-0.25'
        WHEN abs(projected_stat - line) < 0.5  THEN '0.25-0.50'
        WHEN abs(projected_stat - line) < 1.0  THEN '0.50-1.00'
        WHEN abs(projected_stat - line) < 2.0  THEN '1.00-2.00'
        ELSE '2.00+'
      END AS edge_band,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS wr
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL
      AND projected_stat IS NOT NULL AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type, edge_band
    HAVING count(*) >= 25
    ORDER BY mlb_market_type, edge_band
  LOOP RAISE NOTICE '[D-536 §G.1] mkt=% edge_band=% n=% wr=%',
    r.market, r.edge_band, r.n, r.wr; END LOOP;

  -- §E.4 — Now the critical one: is the projection's predictive
  -- ability CONDITIONAL on the pick_side? I.e., does the projection
  -- agree with the pick AT ALL for these resolved picks?
  RAISE NOTICE '======== D-536 §H: projection agreement with pick_side (does the scorer pick the side projection says?) ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat > line)
        OR (pick_side = 'under' AND projected_stat < line)
        OR (pick_side IN ('home','away') AND projected_stat IS NOT NULL)  -- game markets always agree by definition
      ) AS n_proj_agrees_with_pick,
      ROUND(100.0 * count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat > line)
        OR (pick_side = 'under' AND projected_stat < line)
        OR (pick_side IN ('home','away') AND projected_stat IS NOT NULL)
      ) / NULLIF(count(*),0), 1) AS pct_agree
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL
      AND projected_stat IS NOT NULL AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-536 §H.1] mkt=% n=% proj_agrees_with_pick=%  pct=%',
    r.market, r.n, r.n_proj_agrees_with_pick, r.pct_agree; END LOOP;

END $$;
