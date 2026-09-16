-- D-585 SHIP 1 — SYSTEMATIC variance scan across every breakdown JSONB key,
-- both sports, every market. Find the D-562-class silent-constant inputs.
--
-- Method per (sport, market, key):
--   1. Unnest breakdown JSONB; cast values to numeric where parseable
--   2. count distinct numeric values
--   3. % at the single most-common value
--   4. stddev (numeric values)
--   5. mode value
--
-- Flag rule:
--   * top-value share >= 80%  AND distinct < 5    → SUSPECTED FLATLINE
--   * stddev < 1e-9                                → CONSTANT
--   * top-value share >= 50% AND distinct < 10    → LOW VARIANCE (worth checking)

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- ===================================================================
  -- §A — Build a unified (sport, market, key, numeric_value, raw_value)
  -- TEMP table over the recent organic resolved corpus (last 30 days).
  -- ===================================================================
  CREATE TEMP TABLE d585_breakdown_unnest AS
  SELECT
    ph.sport,
    COALESCE(ph.mlb_market_type, LOWER(ph.prop_type)) AS market,
    j.key AS bk_key,
    j.value AS raw_value,
    CASE WHEN j.value::text ~ '^-?[0-9]+(\.[0-9]+)?$'
         THEN (j.value::text)::numeric
         WHEN j.value::text = 'true' THEN 1
         WHEN j.value::text = 'false' THEN 0
         END AS num_value,
    ph.confidence
  FROM public.pick_history ph,
       LATERAL jsonb_each(COALESCE(ph.breakdown, '{}'::jsonb)) AS j
  WHERE ph.sport IN ('mlb','nba')
    AND ph.is_synthetic=false AND ph.voided IS NOT TRUE
    AND ph.hit IS NOT NULL
    AND ph.game_date >= (now() - interval '30 days')::date
    AND ph.breakdown IS NOT NULL AND ph.breakdown <> '{}'::jsonb;

  CREATE INDEX ON d585_breakdown_unnest (sport, market, bk_key);

  RAISE NOTICE '======== D-585 §A: corpus loaded ========';
  FOR r IN
    SELECT sport, market, count(DISTINCT bk_key) AS n_keys, count(*) AS n_rows
    FROM d585_breakdown_unnest GROUP BY 1,2 ORDER BY 1,2
  LOOP RAISE NOTICE '[D-585 §A.1] sport=% market=% keys=% rows=%',
    r.sport, r.market, r.n_keys, r.n_rows; END LOOP;

  -- ===================================================================
  -- §B — Per-key variance (NUMERIC values only)
  -- Aggregate over (sport, market, key) → distinct numeric values count,
  -- top-value share %, stddev, mean.
  -- ===================================================================
  CREATE TEMP TABLE d585_variance AS
  WITH counts AS (
    SELECT sport, market, bk_key,
      count(*) AS n_picks,
      count(DISTINCT num_value) AS n_distinct,
      count(*) FILTER (WHERE num_value IS NULL) AS n_null,
      stddev(num_value) AS sd,
      avg(num_value) AS mean,
      min(num_value) AS min_v,
      max(num_value) AS max_v
    FROM d585_breakdown_unnest
    GROUP BY 1,2,3
  ),
  top_mode AS (
    SELECT sport, market, bk_key, num_value, count(*) AS cnt,
      row_number() OVER (PARTITION BY sport, market, bk_key ORDER BY count(*) DESC) AS rn
    FROM d585_breakdown_unnest
    WHERE num_value IS NOT NULL
    GROUP BY 1,2,3,4
  )
  SELECT
    c.sport, c.market, c.bk_key,
    c.n_picks, c.n_distinct, c.n_null,
    ROUND(c.sd::numeric, 6) AS sd,
    ROUND(c.mean::numeric, 4) AS mean,
    c.min_v, c.max_v,
    tm.num_value AS mode_value,
    tm.cnt AS mode_count,
    ROUND(100.0 * tm.cnt / NULLIF(c.n_picks - c.n_null, 0)::numeric, 2) AS mode_pct_of_nonnull
  FROM counts c
  LEFT JOIN top_mode tm ON tm.sport=c.sport AND tm.market=c.market AND tm.bk_key=c.bk_key AND tm.rn=1;

  -- ===================================================================
  -- §C — FLAGGED FLATLINE candidates (numeric inputs only).
  -- mode_pct >= 80% AND distinct < 5  → suspected silent constant
  -- ===================================================================
  RAISE NOTICE '======== D-585 §C: suspected FLATLINE inputs (>=80%% same value, <5 distinct) ========';
  FOR r IN
    SELECT sport, market, bk_key, n_picks, n_distinct, sd, mode_value, mode_count, mode_pct_of_nonnull
    FROM d585_variance
    WHERE mode_pct_of_nonnull >= 80
      AND n_distinct < 5
      AND n_picks >= 30
    ORDER BY sport, market, mode_pct_of_nonnull DESC, bk_key
  LOOP RAISE NOTICE '[D-585 §C.1] %.%/% n=% distinct=% sd=% mode=% (%.% pct nonnull)',
    r.sport, r.market, r.bk_key, r.n_picks, r.n_distinct, r.sd, r.mode_value,
    r.mode_count, r.mode_pct_of_nonnull; END LOOP;

  -- ===================================================================
  -- §D — LOW VARIANCE (worth checking) — 50-79% same value, distinct<10
  -- ===================================================================
  RAISE NOTICE '======== D-585 §D: LOW VARIANCE inputs (50-79%% same value, <10 distinct) ========';
  FOR r IN
    SELECT sport, market, bk_key, n_picks, n_distinct, sd, mode_value, mode_pct_of_nonnull
    FROM d585_variance
    WHERE mode_pct_of_nonnull >= 50 AND mode_pct_of_nonnull < 80
      AND n_distinct < 10
      AND n_picks >= 30
    ORDER BY sport, market, mode_pct_of_nonnull DESC, bk_key
  LOOP RAISE NOTICE '[D-585 §D.1] %.%/% n=% distinct=% sd=% mode=% mode_pct=%',
    r.sport, r.market, r.bk_key, r.n_picks, r.n_distinct, r.sd, r.mode_value,
    r.mode_pct_of_nonnull; END LOOP;

  -- ===================================================================
  -- §E — NULL COVERAGE — fields missing on >20% of picks (the D-516 class).
  -- ===================================================================
  RAISE NOTICE '======== D-585 §E: NULL coverage (>20%% NULL/missing on numeric fields) ========';
  FOR r IN
    SELECT sport, market, bk_key, n_picks, n_null,
      ROUND(100.0 * n_null / NULLIF(n_picks, 0)::numeric, 1) AS pct_null
    FROM d585_variance
    WHERE n_picks >= 30
      AND 100.0 * n_null / NULLIF(n_picks, 0)::numeric > 20
    ORDER BY sport, market, pct_null DESC
  LOOP RAISE NOTICE '[D-585 §E.1] %.%/% n=% n_null=% (%pct null)',
    r.sport, r.market, r.bk_key, r.n_picks, r.n_null, r.pct_null; END LOOP;

  -- ===================================================================
  -- §F — Top mode-pct list per sport — the top suspects ranked.
  -- ===================================================================
  RAISE NOTICE '======== D-585 §F: top 20 mode-pct flatline candidates (mlb) ========';
  FOR r IN
    SELECT sport, market, bk_key, n_picks, n_distinct, mode_value, mode_pct_of_nonnull
    FROM d585_variance
    WHERE sport='mlb' AND mode_pct_of_nonnull >= 80 AND n_picks >= 30 AND n_distinct < 10
    ORDER BY mode_pct_of_nonnull DESC, bk_key
    LIMIT 20
  LOOP RAISE NOTICE '[D-585 §F.mlb] %.%/% n=% distinct=% mode=% (%pct)',
    r.sport, r.market, r.bk_key, r.n_picks, r.n_distinct, r.mode_value, r.mode_pct_of_nonnull; END LOOP;

  RAISE NOTICE '======== D-585 §F: top 20 mode-pct flatline candidates (nba) ========';
  FOR r IN
    SELECT sport, market, bk_key, n_picks, n_distinct, mode_value, mode_pct_of_nonnull
    FROM d585_variance
    WHERE sport='nba' AND mode_pct_of_nonnull >= 80 AND n_picks >= 30 AND n_distinct < 10
    ORDER BY mode_pct_of_nonnull DESC, bk_key
    LIMIT 20
  LOOP RAISE NOTICE '[D-585 §F.nba] %.%/% n=% distinct=% mode=% (%pct)',
    r.sport, r.market, r.bk_key, r.n_picks, r.n_distinct, r.mode_value, r.mode_pct_of_nonnull; END LOOP;

  DROP TABLE d585_variance;
  DROP TABLE d585_breakdown_unnest;
END $$;
