-- v2: widen window to 36h since recent cron output isn't yet in the 6h slice.
DO $$
DECLARE
  r RECORD;
  total INT := 0;
  bet_count INT := 0;
  skip_count INT := 0;
  pass_count INT := 0;
BEGIN
  RAISE NOTICE '=== §15.10 #1 Phase 2 impact — last 36h organic ===';
  FOR r IN
    WITH classed AS (
      SELECT
        confidence, verdict, odds, ai_analysis,
        CASE
          WHEN ai_analysis IS NULL OR ai_analysis = '' THEN 0
          WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mFADE\M' THEN -5
          WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mLEAN\M' THEN 2
          WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mTAKE\M' THEN 5
          ELSE 0
        END AS ai_mod,
        LEAST(100, GREATEST(50,
          confidence + CASE
            WHEN ai_analysis IS NULL OR ai_analysis = '' THEN 0
            WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mFADE\M' THEN -5
            WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mLEAN\M' THEN 2
            WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mTAKE\M' THEN 5
            ELSE 0
          END
        )) AS effective_conf
      FROM pick_history
      WHERE source = 'process-games' AND is_synthetic = false
        AND created_at >= NOW() - INTERVAL '36 hours'
        AND odds IS NOT NULL
    ),
    actioned AS (
      SELECT *,
        CASE WHEN effective_conf >= 90 THEN 0.700
             WHEN effective_conf >= 80 THEN 0.595
             WHEN effective_conf >= 70 THEN 0.560
             WHEN effective_conf >= 60 THEN 0.555
             ELSE 0.500 END AS p_tier,
        CASE WHEN odds < 0 THEN 100.0 / ABS(odds)
             ELSE odds / 100.0 END AS dec_odds
      FROM classed
    )
    SELECT
      CASE
        WHEN effective_conf < 60 THEN 'PASS_NO_EDGE'
        WHEN (p_tier * dec_odds - (1 - p_tier)) / NULLIF(dec_odds, 0) <= 0 THEN 'SKIP_PRICE'
        ELSE 'BET'
      END AS action,
      COUNT(*) AS n,
      ROUND(AVG(confidence)::NUMERIC, 1) AS avg_algo,
      ROUND(AVG(effective_conf)::NUMERIC, 1) AS avg_effective,
      COUNT(*) FILTER (WHERE verdict IN ('Strong Pick','Elite Pick')) AS was_strong_or_elite
    FROM actioned
    GROUP BY 1
    ORDER BY 1
  LOOP
    RAISE NOTICE 'action=% n=% avg_algo=% avg_effective=% Strong/Elite=%',
      RPAD(r.action, 13), r.n, r.avg_algo, r.avg_effective, r.was_strong_or_elite;
    total := total + r.n;
    IF r.action = 'BET' THEN bet_count := r.n; END IF;
    IF r.action = 'SKIP_PRICE' THEN skip_count := r.n; END IF;
    IF r.action = 'PASS_NO_EDGE' THEN pass_count := r.n; END IF;
  END LOOP;

  IF total > 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE 'SUMMARY total=% bet=% (%%%) skip=% (%%%) pass=% (%%%)',
      total, bet_count, ROUND(100.0 * bet_count / total, 0),
      skip_count, ROUND(100.0 * skip_count / total, 0),
      pass_count, ROUND(100.0 * pass_count / total, 0);
  ELSE
    RAISE NOTICE 'No organic picks in 36h window.';
  END IF;
END $$;
