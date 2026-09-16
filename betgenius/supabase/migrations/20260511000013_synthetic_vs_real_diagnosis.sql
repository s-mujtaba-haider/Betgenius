-- Forensic diagnostic — synthetic backfill vs real-money 70-79 tier gap.
-- READ-ONLY. No UPDATE/DELETE/schema/function changes.
--
-- Goal: identify why backtest_weights_v3_synthetic_windowed reported
-- 63.94% hit rate at 70-79 tier on synthetic corpus, while real-money
-- calibration tracking (D-118) reports 44.9% at same tier.
--
-- Tests 5 hypotheses (H1-H5) using only existing columns + the
-- real_money_bets view. Output via RAISE NOTICE.

DO $$
DECLARE
  r RECORD;
BEGIN
  -- ============================================================
  -- TASK 1.1 — Source identification at 70-79 tier
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== T1.1 — pick_history rows at 70-79 by (source, is_synthetic) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | % | %',
    RPAD('source', 24), RPAD('is_syn', 6), LPAD('total', 7),
    LPAD('hits', 6), LPAD('miss', 6), LPAD('void', 6), LPAD('wr%', 7);
  FOR r IN
    SELECT
      COALESCE(source, '(null)') AS source,
      is_synthetic,
      COUNT(*) AS total,
      SUM(CASE WHEN hit = true THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN hit = false THEN 1 ELSE 0 END) AS misses,
      SUM(CASE WHEN voided = true THEN 1 ELSE 0 END) AS voided_cnt,
      ROUND(100.0 * SUM(CASE WHEN hit = true THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM pick_history
    WHERE confidence >= 70 AND confidence < 80
      AND prop_type NOT IN ('spread', 'game_total')
    GROUP BY COALESCE(source, '(null)'), is_synthetic
    ORDER BY total DESC
  LOOP
    RAISE NOTICE '% | % | % | % | % | % | %',
      RPAD(r.source, 24), RPAD(r.is_synthetic::TEXT, 6),
      LPAD(r.total::TEXT, 7), LPAD(r.hits::TEXT, 6), LPAD(r.misses::TEXT, 6),
      LPAD(r.voided_cnt::TEXT, 6), LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  -- Date span per source (when does each live?)
  RAISE NOTICE '';
  RAISE NOTICE '=== Date spans per source × is_synthetic (player-prop) ===';
  RAISE NOTICE '% | % | % | % | %',
    RPAD('source', 24), RPAD('is_syn', 6),
    RPAD('earliest', 12), RPAD('latest', 12), LPAD('total', 7);
  FOR r IN
    SELECT
      COALESCE(source, '(null)') AS source,
      is_synthetic,
      MIN(game_date)::TEXT AS earliest,
      MAX(game_date)::TEXT AS latest,
      COUNT(*) AS total
    FROM pick_history
    WHERE prop_type NOT IN ('spread', 'game_total')
    GROUP BY COALESCE(source, '(null)'), is_synthetic
    ORDER BY total DESC
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      RPAD(r.source, 24), RPAD(r.is_synthetic::TEXT, 6),
      RPAD(r.earliest, 12), RPAD(r.latest, 12), LPAD(r.total::TEXT, 7);
  END LOOP;

  -- ============================================================
  -- TASK 2.1 — H1: hit determination correctness on synthetic backfill
  -- Approximation: check whether the recorded actual_value matches the
  -- hit determination math (actual > line for over, actual < line for
  -- under). If hit field disagrees with arithmetic, the writer is buggy.
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== T2.1 H1 — hit-determination correctness at 70-79 ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE 'Counts where pick_history.hit disagrees with the';
  RAISE NOTICE 'arithmetic (actual_value vs line vs pick_side):';
  FOR r IN
    SELECT
      COALESCE(source, '(null)') AS source,
      is_synthetic,
      COUNT(*) FILTER (WHERE hit IS NOT NULL AND actual_value IS NOT NULL) AS resolved,
      -- "should_hit" = strict comparison; voided handled separately
      COUNT(*) FILTER (
        WHERE hit = true
          AND ((pick_side = 'over'  AND actual_value <= line)
            OR (pick_side = 'under' AND actual_value >= line))
      ) AS hits_that_shouldnt_have,
      COUNT(*) FILTER (
        WHERE hit = false
          AND ((pick_side = 'over'  AND actual_value > line)
            OR (pick_side = 'under' AND actual_value < line))
      ) AS misses_that_shouldnt_have
    FROM pick_history
    WHERE confidence >= 70 AND confidence < 80
      AND prop_type NOT IN ('spread', 'game_total')
      AND voided IS NOT TRUE
    GROUP BY COALESCE(source, '(null)'), is_synthetic
    ORDER BY resolved DESC
  LOOP
    RAISE NOTICE 'source=% is_syn=% resolved=% hits-that-should-be-misses=% misses-that-should-be-hits=%',
      r.source, r.is_synthetic, r.resolved,
      r.hits_that_shouldnt_have, r.misses_that_shouldnt_have;
  END LOOP;

  -- ============================================================
  -- TASK 2.2 — H2: voided rate per source
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== T2.2 H2 — voided rate at 70-79 by source ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('source', 24), RPAD('is_syn', 6),
    LPAD('total', 7), LPAD('voided', 7), LPAD('hit_null', 8), LPAD('void%', 7);
  FOR r IN
    SELECT
      COALESCE(source, '(null)') AS source,
      is_synthetic,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE voided = true) AS voided_cnt,
      COUNT(*) FILTER (WHERE hit IS NULL) AS hit_null,
      ROUND(100.0 * COUNT(*) FILTER (WHERE voided = true) / NULLIF(COUNT(*), 0), 2) AS pct
    FROM pick_history
    WHERE confidence >= 70 AND confidence < 80
      AND prop_type NOT IN ('spread', 'game_total')
    GROUP BY COALESCE(source, '(null)'), is_synthetic
    ORDER BY total DESC
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.source, 24), RPAD(r.is_synthetic::TEXT, 6),
      LPAD(r.total::TEXT, 7), LPAD(r.voided_cnt::TEXT, 7),
      LPAD(r.hit_null::TEXT, 8), LPAD(COALESCE(r.pct::TEXT, '—'), 7);
  END LOOP;

  -- ============================================================
  -- TASK 2.3 — H3: line distribution comparison synthetic vs organic
  -- Compare mean/median line by prop_type at 70-79 across is_synthetic.
  -- If synthetic lines systematically lower (overs) / higher (unders)
  -- the backfill is using friendlier reconstructed lines.
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== T2.3 H3 — line distribution by (prop_type, pick_side, is_synthetic) at 70-79 ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('prop', 12), RPAD('side', 6), RPAD('is_syn', 6),
    LPAD('n', 6), LPAD('avg_line', 9), LPAD('hit%', 6);
  FOR r IN
    SELECT
      prop_type, pick_side, is_synthetic,
      COUNT(*) AS n,
      ROUND(AVG(line)::NUMERIC, 2) AS avg_line,
      ROUND(100.0 * SUM(CASE WHEN hit = true THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM pick_history
    WHERE confidence >= 70 AND confidence < 80
      AND prop_type NOT IN ('spread', 'game_total')
      AND voided IS NOT TRUE
    GROUP BY prop_type, pick_side, is_synthetic
    HAVING COUNT(*) >= 20
    ORDER BY prop_type, pick_side, is_synthetic
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(r.prop_type, 12), RPAD(r.pick_side, 6), RPAD(r.is_synthetic::TEXT, 6),
      LPAD(r.n::TEXT, 6), LPAD(r.avg_line::TEXT, 9),
      LPAD(COALESCE(r.wr::TEXT, '—'), 6);
  END LOOP;

  -- ============================================================
  -- TASK 2.4 — H4: pre/post-megadeploy era split (May 4)
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== T2.4 H4 — pre/post-megadeploy split at 70-79 ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | %',
    RPAD('era', 18), RPAD('source', 24), RPAD('is_syn', 6),
    LPAD('n', 7), LPAD('wr%', 7);
  FOR r IN
    SELECT
      CASE WHEN game_date < '20260504' THEN 'pre-megadeploy'
           ELSE 'post-megadeploy' END AS era,
      COALESCE(source, '(null)') AS source,
      is_synthetic,
      COUNT(*) FILTER (WHERE hit IS NOT NULL) AS n,
      ROUND(100.0 * SUM(CASE WHEN hit = true THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM pick_history
    WHERE confidence >= 70 AND confidence < 80
      AND prop_type NOT IN ('spread', 'game_total')
      AND voided IS NOT TRUE
    GROUP BY era, COALESCE(source, '(null)'), is_synthetic
    HAVING COUNT(*) FILTER (WHERE hit IS NOT NULL) >= 10
    ORDER BY era, n DESC
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      RPAD(r.era, 18), RPAD(r.source, 24), RPAD(r.is_synthetic::TEXT, 6),
      LPAD(r.n::TEXT, 7), LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  -- ============================================================
  -- TASK 2.5 — H5: selection bias (bet on vs not bet on)
  -- Compare 70-79 pick hit rate split by whether the pick was bet on.
  -- Only meaningful for organic post-May-7 picks (when real money bets
  -- could match to pick_history rows via the resolver trigger).
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== T2.5 H5 — selection bias at 70-79 (organic only, post-May-7) ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | %',
    RPAD('bet_status', 10), LPAD('n', 6), LPAD('wr%', 7);
  FOR r IN
    WITH organic_70_79 AS (
      SELECT
        ph.id, ph.hit, ph.voided,
        EXISTS (SELECT 1 FROM real_money_bets rmb WHERE rmb.matched_pick_id = ph.id) AS bet_on
      FROM pick_history ph
      WHERE ph.confidence >= 70 AND ph.confidence < 80
        AND ph.prop_type NOT IN ('spread', 'game_total')
        AND ph.is_synthetic = false
        AND ph.created_at >= '2026-05-07'::timestamptz
        AND ph.voided IS NOT TRUE
    )
    SELECT
      CASE WHEN bet_on THEN 'bet_on' ELSE 'not_bet' END AS bet_status,
      COUNT(*) FILTER (WHERE hit IS NOT NULL) AS n,
      ROUND(100.0 * SUM(CASE WHEN hit = true THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM organic_70_79
    GROUP BY bet_on
    ORDER BY bet_status
  LOOP
    RAISE NOTICE '% | % | %',
      RPAD(r.bet_status, 10), LPAD(r.n::TEXT, 6), LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  -- Sample raw bet match rate for context
  RAISE NOTICE '';
  RAISE NOTICE 'Total resolved organic 70-79 picks post-May-7: %',
    (SELECT COUNT(*) FROM pick_history
     WHERE confidence >= 70 AND confidence < 80
       AND prop_type NOT IN ('spread','game_total')
       AND is_synthetic = false
       AND created_at >= '2026-05-07'::timestamptz
       AND hit IS NOT NULL AND voided IS NOT TRUE);
  RAISE NOTICE 'Of those, distinct matched_pick_id in real_money_bets: %',
    (SELECT COUNT(DISTINCT rmb.matched_pick_id) FROM real_money_bets rmb
     JOIN pick_history ph ON ph.id = rmb.matched_pick_id
     WHERE ph.confidence >= 70 AND ph.confidence < 80
       AND ph.prop_type NOT IN ('spread','game_total')
       AND ph.is_synthetic = false
       AND ph.created_at >= '2026-05-07'::timestamptz
       AND ph.hit IS NOT NULL AND ph.voided IS NOT TRUE);

  -- ============================================================
  -- Cross-check: organic-only post-megadeploy 70-79 WR
  -- This is the closest "apples-to-apples" comparison to real-money
  -- calibration: same is_synthetic=false rows the calibration view
  -- uses, just NOT filtered to bets-only.
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== Cross-check: organic post-megadeploy 70-79 by source ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | %',
    RPAD('source', 24), LPAD('n', 6), LPAD('wr%', 7);
  FOR r IN
    SELECT
      COALESCE(source, '(null)') AS source,
      COUNT(*) FILTER (WHERE hit IS NOT NULL) AS n,
      ROUND(100.0 * SUM(CASE WHEN hit = true THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM pick_history
    WHERE confidence >= 70 AND confidence < 80
      AND prop_type NOT IN ('spread', 'game_total')
      AND is_synthetic = false
      AND game_date >= '20260504'
      AND voided IS NOT TRUE
    GROUP BY COALESCE(source, '(null)')
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '% | % | %',
      RPAD(r.source, 24), LPAD(r.n::TEXT, 6),
      LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  -- Same cross-check via real_money_bets view to confirm calibration
  -- input is what we think it is.
  RAISE NOTICE '';
  RAISE NOTICE '=== Sanity: 70-79 from real_money_bets perspective ===';
  RAISE NOTICE '% | % | %',
    RPAD('source', 24), LPAD('n', 6), LPAD('wr%', 7);
  FOR r IN
    SELECT
      COALESCE(matched_pick_source, '(null)') AS source,
      COUNT(*) FILTER (WHERE status NOT IN ('pending')) AS n,
      ROUND(100.0 * SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN status IN ('won','lost') THEN 1 ELSE 0 END), 0), 2) AS wr
    FROM real_money_bets
    WHERE matched_pick_confidence >= 70 AND matched_pick_confidence < 80
      AND is_matched = true
    GROUP BY COALESCE(matched_pick_source, '(null)')
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '% | % | %',
      RPAD(r.source, 24), LPAD(r.n::TEXT, 6),
      LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== DONE ===';
END $$;
