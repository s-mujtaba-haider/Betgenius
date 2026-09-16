-- D-536 — Critical: WR when projection AGREES with pick_side vs when
-- it DISAGREES. If the projection has signal but the picks are inverted,
-- the disagree-with-pick WR should be HIGHER than the agree-with-pick WR
-- (i.e., the algorithm is picking the wrong side).
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-536 §I: WR by projection-vs-pick agreement ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      -- "agree": pick_side matches the projection's preferred side
      count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat > line)
        OR (pick_side = 'under' AND projected_stat < line)
      ) AS n_agree,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((pick_side = 'over' AND projected_stat > line) OR
         (pick_side = 'under' AND projected_stat < line))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat > line)
        OR (pick_side = 'under' AND projected_stat < line)
      ), 0), 1) AS wr_when_agree,
      -- "disagree": pick_side is OPPOSITE the projection
      count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat < line)
        OR (pick_side = 'under' AND projected_stat > line)
      ) AS n_disagree,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((pick_side = 'over' AND projected_stat < line) OR
         (pick_side = 'under' AND projected_stat > line))
        AND hit
      ) / NULLIF(count(*) FILTER (WHERE
        (pick_side = 'over' AND projected_stat < line)
        OR (pick_side = 'under' AND projected_stat > line)
      ), 0), 1) AS wr_when_disagree
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL
      AND projected_stat IS NOT NULL AND mlb_market_type IS NOT NULL
      AND pick_side IN ('over','under')
    GROUP BY mlb_market_type
    ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-536 §I.1] mkt=% agree(n=% WR=%) disagree(n=% WR=%)',
    r.market, r.n_agree, r.wr_when_agree, r.n_disagree, r.wr_when_disagree; END LOOP;

  RAISE NOTICE '======== D-536 §J: confidence vs edge — does conf>=80 capture the high-edge picks? ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      ROUND(avg(abs(projected_stat - line)) FILTER (WHERE confidence < 70), 3) AS avg_edge_lt70,
      ROUND(avg(abs(projected_stat - line)) FILTER (WHERE confidence BETWEEN 70 AND 79), 3) AS avg_edge_70_79,
      ROUND(avg(abs(projected_stat - line)) FILTER (WHERE confidence BETWEEN 80 AND 89), 3) AS avg_edge_80_89,
      ROUND(avg(abs(projected_stat - line)) FILTER (WHERE confidence >= 90), 3) AS avg_edge_90plus
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL
      AND projected_stat IS NOT NULL AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type
    ORDER BY count(*) DESC LIMIT 8
  LOOP RAISE NOTICE '[D-536 §J.1] mkt=% avg|proj-line| by conf tier: <70=% 70-79=% 80-89=% 90+=%',
    r.market, r.avg_edge_lt70, r.avg_edge_70_79, r.avg_edge_80_89, r.avg_edge_90plus; END LOOP;
END $$;
