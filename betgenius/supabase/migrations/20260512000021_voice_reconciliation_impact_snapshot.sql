-- §15.10 Critical #1 Phase 2 — production impact probe.
-- Estimates how today's slate distributes across the three Kelly actions
-- AFTER applying the +5/-5 AI modifier. Mirrors the frontend logic exactly:
--   effective = clamp(confidence + modifier, 50, 100); modifier in {-5, +2, +5, 0}
--   PASS_NO_EDGE if effective < 60
--   SKIP_PRICE if probability_for_effective_tier × decimal_odds ≤ break_even
--   BET otherwise.
-- Tier probability lookups mirror src/lib/kelly.ts:60.

DO $$
DECLARE
  r RECORD;
  total INT := 0;
  bet_count INT := 0;
  skip_count INT := 0;
  pass_count INT := 0;
  was_strong INT := 0;
  was_elite INT := 0;
  newly_bet INT := 0;
BEGIN
  RAISE NOTICE '=== §15.10 #1 Phase 2 impact: today''s slate Kelly classification ===';

  FOR r IN
    WITH classed AS (
      SELECT
        confidence,
        verdict,
        odds,
        ai_analysis,
        -- AI modifier: FADE bias > LEAN > TAKE in trailing window
        CASE
          WHEN ai_analysis IS NULL OR ai_analysis = '' THEN 0
          WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mFADE\M' THEN -5
          WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mLEAN\M' THEN 2
          WHEN UPPER(RIGHT(ai_analysis, 160)) ~ '\mTAKE\M' THEN 5
          ELSE 0
        END AS ai_mod,
        -- Effective confidence (clamp to [50,100])
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
        AND created_at >= NOW() - INTERVAL '6 hours'
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
    ),
    final AS (
      SELECT *,
        (p_tier * dec_odds - (1 - p_tier)) AS kelly_numerator,
        CASE
          WHEN effective_conf < 60 THEN 'PASS_NO_EDGE'
          WHEN (p_tier * dec_odds - (1 - p_tier)) / NULLIF(dec_odds, 0) <= 0 THEN 'SKIP_PRICE'
          ELSE 'BET'
        END AS action
      FROM actioned
    )
    SELECT
      action,
      COUNT(*) AS n,
      ROUND(AVG(confidence)::NUMERIC, 1) AS avg_algo_conf,
      ROUND(AVG(effective_conf)::NUMERIC, 1) AS avg_effective_conf,
      COUNT(*) FILTER (WHERE verdict IN ('Strong Pick','Elite Pick')) AS was_strong_or_elite
    FROM final
    GROUP BY action
    ORDER BY action
  LOOP
    RAISE NOTICE 'action=% n=% avg_algo=% avg_effective=% was_Strong_or_Elite=%',
      RPAD(r.action, 13), r.n, r.avg_algo_conf, r.avg_effective_conf, r.was_strong_or_elite;
    total := total + r.n;
    IF r.action = 'BET' THEN bet_count := r.n; END IF;
    IF r.action = 'SKIP_PRICE' THEN skip_count := r.n; END IF;
    IF r.action = 'PASS_NO_EDGE' THEN pass_count := r.n; END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Strong/Elite picks that ended up SKIP/PASS (trust-fix examples) ===';
  FOR r IN
    WITH classed AS (
      SELECT
        LEFT(player_name, 22) AS player,
        confidence,
        verdict,
        odds,
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
        AND created_at >= NOW() - INTERVAL '6 hours'
        AND odds IS NOT NULL
        AND verdict IN ('Strong Pick','Elite Pick')
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
    SELECT player, confidence, verdict, odds, ai_mod, effective_conf,
      CASE
        WHEN effective_conf < 60 THEN 'PASS_NO_EDGE'
        WHEN (p_tier * dec_odds - (1 - p_tier)) / NULLIF(dec_odds, 0) <= 0 THEN 'SKIP_PRICE'
        ELSE 'BET'
      END AS action
    FROM actioned
    WHERE
      CASE
        WHEN effective_conf < 60 THEN 'PASS_NO_EDGE'
        WHEN (p_tier * dec_odds - (1 - p_tier)) / NULLIF(dec_odds, 0) <= 0 THEN 'SKIP_PRICE'
        ELSE 'BET'
      END <> 'BET'
    ORDER BY confidence DESC
    LIMIT 8
  LOOP
    RAISE NOTICE 'player=% conf=% verdict=% odds=% ai=%+ effective=% → %',
      RPAD(r.player, 22), r.confidence, RPAD(r.verdict, 11), r.odds,
      r.ai_mod, r.effective_conf, r.action;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'SUMMARY: total=% bet=% skip=% pass=%',
    total, bet_count, skip_count, pass_count;
END $$;
