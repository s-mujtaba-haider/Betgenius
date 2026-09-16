-- D-645 — fix column ambiguity (market var shadows column name).
DROP FUNCTION IF EXISTS public.d645_q1_factor_population();
CREATE OR REPLACE FUNCTION public.d645_q1_factor_population()
RETURNS TABLE (
  mkt TEXT, factor_name TEXT, n_total BIGINT, n_present BIGINT,
  n_active_num BIGINT, n_active_str BIGINT,
  pct_present NUMERIC, pct_active NUMERIC, coverage TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '180s';
  RETURN QUERY
  WITH base AS (
    SELECT ph.mlb_market_type AS mkt2, ph.breakdown
    FROM public.pick_history ph
    WHERE ph.mlb_market_type IN ('batter_runs_scored','batter_total_bases')
      AND COALESCE(ph.is_synthetic, FALSE) = FALSE
      AND COALESCE(ph.voided, FALSE) = FALSE
      AND ph.created_at > NOW() - INTERVAL '21 days'
      AND ph.breakdown IS NOT NULL
  ),
  totals AS ( SELECT base.mkt2, COUNT(*) AS n_total FROM base GROUP BY base.mkt2 ),
  keys AS (
    SELECT b.mkt2, kv.key, kv.value
    FROM base b, LATERAL jsonb_each(b.breakdown) AS kv
    WHERE kv.key LIKE 'score\_%' ESCAPE '\'
  ),
  agg AS (
    SELECT k.mkt2, k.key AS factor_name,
      COUNT(*) AS n_present,
      SUM(CASE WHEN jsonb_typeof(k.value)='number'
               AND (k.value)::text::numeric <> 0 THEN 1 ELSE 0 END) AS n_active_num,
      SUM(CASE WHEN jsonb_typeof(k.value)='string'
               AND LENGTH(k.value::text) > 2 THEN 1 ELSE 0 END) AS n_active_str
    FROM keys k GROUP BY k.mkt2, k.key
  )
  SELECT a.mkt2, a.factor_name, t.n_total, a.n_present,
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
  FROM agg a JOIN totals t ON t.mkt2 = a.mkt2
  ORDER BY a.mkt2, pct_active ASC;
END $$;
GRANT EXECUTE ON FUNCTION public.d645_q1_factor_population() TO service_role;
