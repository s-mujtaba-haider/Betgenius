-- D-645 — READ-ONLY diagnose for batter_runs_scored.
-- Three queries: factor population on RS, comparison to TB, confidence math drilldown.
-- Dropped via 20260621401000 after readout.

CREATE OR REPLACE FUNCTION public.d645_q1_factor_population()
RETURNS TABLE (
  market TEXT, factor_name TEXT, n_total BIGINT, n_present BIGINT,
  n_active_num BIGINT, n_active_str BIGINT,
  pct_present NUMERIC, pct_active NUMERIC, coverage TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT mlb_market_type AS market, breakdown
    FROM public.pick_history
    WHERE mlb_market_type IN ('batter_runs_scored','batter_total_bases')
      AND COALESCE(is_synthetic, FALSE) = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND created_at > NOW() - INTERVAL '21 days'
      AND breakdown IS NOT NULL
  ),
  totals AS ( SELECT market, COUNT(*) AS n_total FROM base GROUP BY market ),
  keys AS (
    SELECT b.market, kv.key, kv.value
    FROM base b, LATERAL jsonb_each(b.breakdown) AS kv
    WHERE kv.key LIKE 'score\_%' ESCAPE '\'
  ),
  agg AS (
    SELECT k.market, k.key AS factor_name,
      COUNT(*) AS n_present,
      SUM(CASE WHEN jsonb_typeof(k.value)='number'
               AND (k.value)::text::numeric <> 0 THEN 1 ELSE 0 END) AS n_active_num,
      SUM(CASE WHEN jsonb_typeof(k.value)='string'
               AND LENGTH(k.value::text) > 2 THEN 1 ELSE 0 END) AS n_active_str
    FROM keys k GROUP BY k.market, k.key
  )
  SELECT a.market, a.factor_name, t.n_total, a.n_present,
    a.n_active_num, a.n_active_str,
    ROUND(100.0 * a.n_present / NULLIF(t.n_total,0), 1),
    ROUND(100.0 * (a.n_active_num + a.n_active_str) / NULLIF(t.n_total,0), 1),
    CASE
      WHEN 100.0 * (a.n_active_num + a.n_active_str) / NULLIF(t.n_total,0) <  1 THEN 'DEAD'
      WHEN 100.0 * (a.n_active_num + a.n_active_str) / NULLIF(t.n_total,0) <  5 THEN 'NEAR_DEAD'
      WHEN 100.0 * (a.n_active_num + a.n_active_str) / NULLIF(t.n_total,0) < 25 THEN 'LOW'
      WHEN 100.0 * (a.n_active_num + a.n_active_str) / NULLIF(t.n_total,0) < 60 THEN 'PARTIAL'
      ELSE 'HEALTHY'
    END
  FROM agg a JOIN totals t USING (market)
  ORDER BY a.market, pct_active ASC;
END $$;
GRANT EXECUTE ON FUNCTION public.d645_q1_factor_population() TO service_role;

-- Q2 — per-pick: how many factors fire on a runs_scored pick? And how does it correlate
-- with confidence (do ELITE 100 picks have many or few factors firing)?
CREATE OR REPLACE FUNCTION public.d645_q2_factors_per_pick()
RETURNS TABLE (
  market TEXT,
  n_picks BIGINT,
  avg_factors_active NUMERIC,
  median_factors_active NUMERIC,
  p10_factors NUMERIC,
  p90_factors NUMERIC,
  factors_in_breakdown_keys BIGINT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT id, mlb_market_type AS market, breakdown
    FROM public.pick_history
    WHERE mlb_market_type IN ('batter_runs_scored','batter_total_bases')
      AND COALESCE(is_synthetic, FALSE) = FALSE
      AND COALESCE(voided, FALSE) = FALSE
      AND created_at > NOW() - INTERVAL '21 days'
      AND breakdown IS NOT NULL
  ),
  counts AS (
    SELECT b.id, b.market,
      (SELECT COUNT(*) FROM jsonb_each(b.breakdown) AS kv
        WHERE kv.key LIKE 'score\_%' ESCAPE '\'
          AND ((jsonb_typeof(kv.value)='number' AND (kv.value)::text::numeric <> 0)
            OR (jsonb_typeof(kv.value)='string' AND LENGTH(kv.value::text) > 2))
      ) AS n_active,
      (SELECT COUNT(*) FROM jsonb_each(b.breakdown) AS kv
        WHERE kv.key LIKE 'score\_%' ESCAPE '\'
      ) AS n_keys
    FROM base b
  )
  SELECT c.market, COUNT(*) AS n_picks,
    ROUND(AVG(c.n_active)::NUMERIC, 2),
    PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY c.n_active),
    PERCENTILE_DISC(0.1) WITHIN GROUP (ORDER BY c.n_active),
    PERCENTILE_DISC(0.9) WITHIN GROUP (ORDER BY c.n_active),
    ROUND(AVG(c.n_keys)::NUMERIC, 0)::BIGINT
  FROM counts c GROUP BY c.market ORDER BY c.market;
END $$;
GRANT EXECUTE ON FUNCTION public.d645_q2_factors_per_pick() TO service_role;

-- Q3 — for runs_scored ELITE-tier picks (conf >= 90), show base projection vs line vs
-- factor sum. Reveals whether 100-conf is driven by projection or factor stacking.
CREATE OR REPLACE FUNCTION public.d645_q3_runs_elite_breakdown()
RETURNS TABLE (
  confidence INT,
  pick_side TEXT,
  line NUMERIC,
  projected_stat NUMERIC,
  edge NUMERIC,
  base_from_edge_x8 NUMERIC,
  score_batter_obp NUMERIC,
  score_recent_run_form NUMERIC,
  score_opposing_pitcher_quality NUMERIC,
  score_ballpark_factor NUMERIC,
  score_lineup_spot NUMERIC,
  score_bullpen_quality NUMERIC,
  score_opp_pp_quality NUMERIC,
  factor_sum NUMERIC,
  n_active_factors INT,
  raw_total NUMERIC,
  n_rows BIGINT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.confidence, ph.pick_side, ph.line,
      ph.breakdown,
      COALESCE((ph.breakdown->>'projected_stat')::numeric, 0) AS proj,
      COALESCE((ph.breakdown->>'raw_edge')::numeric, 0) AS edge_b
    FROM public.pick_history ph
    WHERE ph.mlb_market_type = 'batter_runs_scored'
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.confidence >= 90
      AND ph.created_at > NOW() - INTERVAL '21 days'
      AND ph.breakdown IS NOT NULL
  ),
  per AS (
    SELECT
      b.confidence,
      b.pick_side,
      b.line,
      b.proj AS projected_stat,
      b.edge_b AS edge,
      ROUND(b.edge_b * 8, 1) AS base_from_edge_x8,
      COALESCE((b.breakdown->>'score_batter_obp')::numeric, 0) AS obp,
      COALESCE((b.breakdown->>'score_recent_run_form')::numeric, 0) AS rrf,
      COALESCE((b.breakdown->>'score_opposing_pitcher_quality')::numeric, 0) AS opq,
      COALESCE((b.breakdown->>'score_ballpark_factor')::numeric, 0) AS bp,
      COALESCE((b.breakdown->>'score_lineup_spot')::numeric, 0) AS ls,
      COALESCE((b.breakdown->>'score_bullpen_quality')::numeric, 0) AS bpq,
      COALESCE((b.breakdown->>'score_opp_pitcher_pitchtype_quality')::numeric, 0) AS oppp
    FROM base b
  )
  SELECT
    p.confidence::INT, p.pick_side, p.line, p.projected_stat, p.edge, p.base_from_edge_x8,
    ROUND(AVG(p.obp), 2),
    ROUND(AVG(p.rrf), 2),
    ROUND(AVG(p.opq), 2),
    ROUND(AVG(p.bp), 2),
    ROUND(AVG(p.ls), 2),
    ROUND(AVG(p.bpq), 2),
    ROUND(AVG(p.oppp), 2),
    ROUND(AVG(p.obp + p.rrf + p.opq + p.bp + p.ls + p.bpq + p.oppp), 2) AS factor_sum,
    ROUND(AVG((p.obp <> 0)::int + (p.rrf <> 0)::int + (p.opq <> 0)::int + (p.bp <> 0)::int
              + (p.ls <> 0)::int + (p.bpq <> 0)::int + (p.oppp <> 0)::int))::INT AS n_active,
    ROUND(AVG(50 + p.base_from_edge_x8 + p.obp + p.rrf + p.opq + p.bp + p.ls + p.bpq + p.oppp), 1) AS raw_total,
    COUNT(*) AS n_rows
  FROM per p
  GROUP BY p.confidence, p.pick_side, p.line, p.projected_stat, p.edge, p.base_from_edge_x8
  ORDER BY p.confidence DESC, n_rows DESC
  LIMIT 30;
END $$;
GRANT EXECUTE ON FUNCTION public.d645_q3_runs_elite_breakdown() TO service_role;
