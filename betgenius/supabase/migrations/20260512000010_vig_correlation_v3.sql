DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== Juice bucket correlation (post-May-4 organic) ===';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('juice', 11), LPAD('n', 5), LPAD('vig_fires', 10),
    LPAD('vig_silent', 11), LPAD('triv_fires', 11), LPAD('avg_vig', 8);
  FOR r IN
    WITH bucketed AS (
      SELECT
        CASE WHEN ABS(odds) >= 500 THEN '500+'
          WHEN ABS(odds) >= 300 THEN '300-499'
          WHEN ABS(odds) >= 200 THEN '200-299'
          WHEN ABS(odds) >= 150 THEN '150-199'
          WHEN ABS(odds) >= 120 THEN '120-149'
          ELSE 'under 120' END AS juice_bucket,
        score_vig_filter, score_trivial_line_penalty
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND created_at >= '2026-05-04'::timestamptz
        AND odds IS NOT NULL
        AND prop_type NOT IN ('spread','game_total')
    )
    SELECT juice_bucket,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE score_vig_filter < 0) AS vig_fires,
      COUNT(*) FILTER (WHERE score_vig_filter = 0 OR score_vig_filter IS NULL) AS vig_silent,
      COUNT(*) FILTER (WHERE score_trivial_line_penalty < 0) AS trivial_fires,
      ROUND(AVG(score_vig_filter)::NUMERIC, 2) AS avg_vig,
      CASE juice_bucket WHEN '500+' THEN 1 WHEN '300-499' THEN 2 WHEN '200-299' THEN 3
        WHEN '150-199' THEN 4 WHEN '120-149' THEN 5 ELSE 6 END AS sort_key
    FROM bucketed
    GROUP BY juice_bucket
    ORDER BY sort_key
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.juice_bucket, 11), LPAD(r.n::TEXT, 5),
      LPAD(r.vig_fires::TEXT, 10), LPAD(r.vig_silent::TEXT, 11),
      LPAD(r.trivial_fires::TEXT, 11), LPAD(r.avg_vig::TEXT, 8);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Trivial-line (line <= 0.5) picks by odds sign ===';
  FOR r IN
    WITH classed AS (
      SELECT
        CASE WHEN odds >= 200 THEN '+200_or_more_LONGSHOT'
          WHEN odds > 0 THEN '+pos_lt_200'
          WHEN odds <= -200 THEN '-200_or_more_neg_FAVORITE'
          ELSE 'neg_lt_200' END AS odds_class,
        score_vig_filter, score_trivial_line_penalty
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND created_at >= '2026-05-04'::timestamptz
        AND prop_type NOT IN ('spread','game_total')
        AND line <= 0.5
    )
    SELECT odds_class,
      COUNT(*) AS n,
      COUNT(*) FILTER (WHERE score_trivial_line_penalty <= -15) AS trivial_minus15,
      COUNT(*) FILTER (WHERE score_trivial_line_penalty = -8) AS trivial_minus8,
      COUNT(*) FILTER (WHERE COALESCE(score_trivial_line_penalty, 0) = 0) AS trivial_zero,
      COUNT(*) FILTER (WHERE score_vig_filter < 0) AS vig_fires
    FROM classed
    GROUP BY odds_class ORDER BY odds_class
  LOOP
    RAISE NOTICE 'class=% n=% triv=-15: % triv=-8: % triv=0: % vig_fires=%',
      RPAD(r.odds_class, 26), r.n, r.trivial_minus15, r.trivial_minus8, r.trivial_zero, r.vig_fires;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== vig + trivial co-fire matrix ===';
  FOR r IN
    SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE score_vig_filter < 0 AND score_trivial_line_penalty < 0) AS both_fire,
      COUNT(*) FILTER (WHERE score_vig_filter < 0 AND COALESCE(score_trivial_line_penalty, 0) = 0) AS vig_only,
      COUNT(*) FILTER (WHERE COALESCE(score_vig_filter, 0) = 0 AND score_trivial_line_penalty < 0) AS trivial_only,
      COUNT(*) FILTER (WHERE COALESCE(score_vig_filter, 0) = 0 AND COALESCE(score_trivial_line_penalty, 0) = 0) AS neither
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND created_at >= '2026-05-04'::timestamptz
      AND prop_type NOT IN ('spread','game_total')
  LOOP
    RAISE NOTICE 'total=% both=% vig_only=% trivial_only=% neither=%',
      r.total, r.both_fire, r.vig_only, r.trivial_only, r.neither;
  END LOOP;
END $$;
