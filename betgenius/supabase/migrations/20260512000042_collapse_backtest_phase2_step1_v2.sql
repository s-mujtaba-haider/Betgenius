-- v2: replace all %% literals with plain-text suffix to avoid PL/pgSQL
-- RAISE placeholder-count mismatch (v1 errored at line 24).

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== BASELINE production tier WR ===';
  RAISE NOTICE 'tier     |     n |  hits |    WR';
  FOR r IN
    SELECT
      CASE WHEN confidence < 60 THEN '<60'
           WHEN confidence < 70 THEN '60-69'
           WHEN confidence < 80 THEN '70-79'
           WHEN confidence < 90 THEN '80-89'
           ELSE '90+' END AS tier,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE hit = true) AS hits,
      ROUND(100.0 * AVG(CASE WHEN hit THEN 1.0 ELSE 0.0 END)::NUMERIC, 2) AS wr,
      CASE WHEN confidence < 60 THEN 1 WHEN confidence < 70 THEN 2
           WHEN confidence < 80 THEN 3 WHEN confidence < 90 THEN 4 ELSE 5 END AS sk
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND game_date >= '2026-05-04'
      AND hit IS NOT NULL AND voided = false
    GROUP BY 1, sk ORDER BY sk
  LOOP
    RAISE NOTICE '% | % | % | %',
      RPAD(r.tier, 8), LPAD(r.n::TEXT, 5),
      LPAD(r.hits::TEXT, 5), LPAD(r.wr::TEXT || ' pct', 8);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Candidate per-tier WR ===';
  RAISE NOTICE 'cand  | tier     |     n |  hits |    WR';
  FOR r IN
    WITH u AS (
      SELECT hit, confidence,
             COALESCE(score_recent_form, 0) AS rf,
             COALESCE(score_regression, 0) AS reg,
             game_date
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND game_date >= '2026-05-04'
        AND hit IS NOT NULL AND voided = false
    ),
    sim AS (
      SELECT u.*,
        confidence + ((0.5 - 1.0) * rf) + ((-1.0 - 0.5) * reg) AS sim_D,
        confidence + ((1.0 - 1.0) * rf) + ((-1.0 - 1.0) * reg) AS sim_A,
        confidence + ((2.0 - 1.0) * rf) + ((-1.0 - 2.0) * reg) AS sim_C
      FROM u
    )
    SELECT 'D=0.5' AS cand, tier, n, hits, wr, sk FROM (
      SELECT
        CASE WHEN sim_D < 60 THEN '<60'
             WHEN sim_D < 70 THEN '60-69'
             WHEN sim_D < 80 THEN '70-79'
             WHEN sim_D < 90 THEN '80-89'
             ELSE '90+' END AS tier,
        COUNT(*) AS n,
        COUNT(*) FILTER (WHERE hit = true) AS hits,
        ROUND(100.0 * AVG(CASE WHEN hit THEN 1.0 ELSE 0.0 END)::NUMERIC, 2) AS wr,
        CASE WHEN sim_D < 60 THEN 1 WHEN sim_D < 70 THEN 2
             WHEN sim_D < 80 THEN 3 WHEN sim_D < 90 THEN 4 ELSE 5 END AS sk
      FROM sim GROUP BY 1, sk
    ) z
    UNION ALL
    SELECT 'A=1.0', tier, n, hits, wr, sk FROM (
      SELECT
        CASE WHEN sim_A < 60 THEN '<60'
             WHEN sim_A < 70 THEN '60-69'
             WHEN sim_A < 80 THEN '70-79'
             WHEN sim_A < 90 THEN '80-89'
             ELSE '90+' END AS tier,
        COUNT(*) AS n,
        COUNT(*) FILTER (WHERE hit = true) AS hits,
        ROUND(100.0 * AVG(CASE WHEN hit THEN 1.0 ELSE 0.0 END)::NUMERIC, 2) AS wr,
        CASE WHEN sim_A < 60 THEN 1 WHEN sim_A < 70 THEN 2
             WHEN sim_A < 80 THEN 3 WHEN sim_A < 90 THEN 4 ELSE 5 END AS sk
      FROM sim GROUP BY 1, sk
    ) z
    UNION ALL
    SELECT 'C=2.0', tier, n, hits, wr, sk FROM (
      SELECT
        CASE WHEN sim_C < 60 THEN '<60'
             WHEN sim_C < 70 THEN '60-69'
             WHEN sim_C < 80 THEN '70-79'
             WHEN sim_C < 90 THEN '80-89'
             ELSE '90+' END AS tier,
        COUNT(*) AS n,
        COUNT(*) FILTER (WHERE hit = true) AS hits,
        ROUND(100.0 * AVG(CASE WHEN hit THEN 1.0 ELSE 0.0 END)::NUMERIC, 2) AS wr,
        CASE WHEN sim_C < 60 THEN 1 WHEN sim_C < 70 THEN 2
             WHEN sim_C < 80 THEN 3 WHEN sim_C < 90 THEN 4 ELSE 5 END AS sk
      FROM sim GROUP BY 1, sk
    ) z
    ORDER BY cand, sk
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      RPAD(r.cand, 5),
      RPAD(r.tier, 8),
      LPAD(r.n::TEXT, 5),
      LPAD(r.hits::TEXT, 5),
      LPAD(r.wr::TEXT || ' pct', 8);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Pick migration vs baseline tier ===';
  FOR r IN
    WITH u AS (
      SELECT confidence,
             COALESCE(score_recent_form, 0) AS rf,
             COALESCE(score_regression, 0) AS reg, hit
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND game_date >= '2026-05-04'
        AND hit IS NOT NULL AND voided = false
    ),
    sim AS (
      SELECT *,
        CASE WHEN confidence < 60 THEN 1 WHEN confidence < 70 THEN 2
             WHEN confidence < 80 THEN 3 WHEN confidence < 90 THEN 4 ELSE 5 END AS base_t,
        confidence + ((0.5 - 1.0) * rf) + ((-1.0 - 0.5) * reg) AS sim_D,
        confidence + ((1.0 - 1.0) * rf) + ((-1.0 - 1.0) * reg) AS sim_A,
        confidence + ((2.0 - 1.0) * rf) + ((-1.0 - 2.0) * reg) AS sim_C
      FROM u
    ),
    migrated AS (
      SELECT *,
        CASE WHEN sim_D < 60 THEN 1 WHEN sim_D < 70 THEN 2
             WHEN sim_D < 80 THEN 3 WHEN sim_D < 90 THEN 4 ELSE 5 END AS d_t,
        CASE WHEN sim_A < 60 THEN 1 WHEN sim_A < 70 THEN 2
             WHEN sim_A < 80 THEN 3 WHEN sim_A < 90 THEN 4 ELSE 5 END AS a_t,
        CASE WHEN sim_C < 60 THEN 1 WHEN sim_C < 70 THEN 2
             WHEN sim_C < 80 THEN 3 WHEN sim_C < 90 THEN 4 ELSE 5 END AS c_t
      FROM sim
    )
    SELECT 'D=0.5' AS cand,
      COUNT(*) FILTER (WHERE d_t > base_t) AS up,
      COUNT(*) FILTER (WHERE d_t < base_t) AS down,
      COUNT(*) FILTER (WHERE d_t = base_t) AS same,
      COUNT(*) AS total
    FROM migrated
    UNION ALL SELECT 'A=1.0',
      COUNT(*) FILTER (WHERE a_t > base_t),
      COUNT(*) FILTER (WHERE a_t < base_t),
      COUNT(*) FILTER (WHERE a_t = base_t),
      COUNT(*) FROM migrated
    UNION ALL SELECT 'C=2.0',
      COUNT(*) FILTER (WHERE c_t > base_t),
      COUNT(*) FILTER (WHERE c_t < base_t),
      COUNT(*) FILTER (WHERE c_t = base_t),
      COUNT(*) FROM migrated
  LOOP
    RAISE NOTICE 'cand=% up=% down=% same=% total=%',
      r.cand, r.up, r.down, r.same, r.total;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Walk-forward: 70-79 tier WR by window ===';
  FOR r IN
    WITH u AS (
      SELECT confidence,
             COALESCE(score_recent_form, 0) AS rf,
             COALESCE(score_regression, 0) AS reg, hit,
             CASE WHEN game_date < '2026-05-08' THEN 'w1_4to7' ELSE 'w2_8to12' END AS win
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND game_date >= '2026-05-04'
        AND hit IS NOT NULL AND voided = false
    ),
    sim AS (
      SELECT *,
        confidence + ((0.5 - 1.0) * rf) + ((-1.0 - 0.5) * reg) AS sim_D,
        confidence + ((1.0 - 1.0) * rf) + ((-1.0 - 1.0) * reg) AS sim_A,
        confidence + ((2.0 - 1.0) * rf) + ((-1.0 - 2.0) * reg) AS sim_C
      FROM u
    )
    SELECT win,
      COUNT(*) FILTER (WHERE confidence >= 70 AND confidence < 80) AS base_n,
      ROUND(100.0 * (COUNT(*) FILTER (WHERE confidence >= 70 AND confidence < 80 AND hit = true)::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE confidence >= 70 AND confidence < 80), 0)), 2) AS base_wr,
      COUNT(*) FILTER (WHERE sim_D >= 70 AND sim_D < 80) AS d_n,
      ROUND(100.0 * (COUNT(*) FILTER (WHERE sim_D >= 70 AND sim_D < 80 AND hit = true)::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE sim_D >= 70 AND sim_D < 80), 0)), 2) AS d_wr,
      COUNT(*) FILTER (WHERE sim_A >= 70 AND sim_A < 80) AS a_n,
      ROUND(100.0 * (COUNT(*) FILTER (WHERE sim_A >= 70 AND sim_A < 80 AND hit = true)::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE sim_A >= 70 AND sim_A < 80), 0)), 2) AS a_wr,
      COUNT(*) FILTER (WHERE sim_C >= 70 AND sim_C < 80) AS c_n,
      ROUND(100.0 * (COUNT(*) FILTER (WHERE sim_C >= 70 AND sim_C < 80 AND hit = true)::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE sim_C >= 70 AND sim_C < 80), 0)), 2) AS c_wr
    FROM sim
    GROUP BY win ORDER BY win
  LOOP
    RAISE NOTICE 'win=% base[n=% WR=%] D[n=% WR=%] A[n=% WR=%] C[n=% WR=%]',
      r.win, r.base_n, r.base_wr, r.d_n, r.d_wr, r.a_n, r.a_wr, r.c_n, r.c_wr;
  END LOOP;
END $$;
