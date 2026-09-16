-- v2: cache_player_game_logs uses `fetched_at` not `created_at` (probed via
-- 20260513000021). Substitution noted in report; semantically equivalent
-- to "rows written to cache in the last 18 hours".
DO $$
DECLARE
  r RECORD;
  b1_rows INT := 0;
  b1_pen_neg15 INT := 0;
  b1_cap_true INT := 0;
  b1_max_conf INT := 0;
  b2a_new INT := 0;
  b2a_with INT := 0;
  b2a_pct NUMERIC := 0;
  b2b_picks INT := 0;
  b2b_fires INT := 0;
  b2b_rate NUMERIC := 0;
BEGIN
  RAISE NOTICE '=== BLOCK 1 — trivial_pen + cap symmetric (commit c4d2b42) ===';
  FOR r IN
    SELECT LEFT(player_name, 22) AS player,
      prop_type, line, pick_side, odds, confidence,
      score_trivial_line_penalty AS pen,
      score_trivial_line_cap AS cap
    FROM pick_history
    WHERE created_at > NOW() - INTERVAL '18 hours'
      AND line <= 0.5 AND ABS(odds) >= 200
    ORDER BY ABS(odds) DESC LIMIT 20
  LOOP
    RAISE NOTICE '% | % %@% | odds=% conf=% pen=% cap=%',
      RPAD(r.player, 22), RPAD(r.prop_type, 10),
      RPAD(r.pick_side, 6), r.line, r.odds, r.confidence,
      r.pen, COALESCE(r.cap::TEXT, 'NULL');
    b1_rows := b1_rows + 1;
    IF r.pen = -15 THEN b1_pen_neg15 := b1_pen_neg15 + 1; END IF;
    IF r.cap = TRUE THEN b1_cap_true := b1_cap_true + 1; END IF;
    IF r.confidence > b1_max_conf THEN b1_max_conf := r.confidence; END IF;
  END LOOP;
  RAISE NOTICE 'B1 SUMMARY: rows=% pen_-15=% cap_TRUE=% max_conf=%',
    b1_rows, b1_pen_neg15, b1_cap_true, b1_max_conf;

  RAISE NOTICE '';
  RAISE NOTICE '=== BLOCK 2a — cache_player_game_logs fill rate (using fetched_at — see note) ===';
  SELECT COUNT(*), COUNT(is_home),
    ROUND(100.0 * COUNT(is_home) / NULLIF(COUNT(*), 0), 1)
  INTO b2a_new, b2a_with, b2a_pct
  FROM cache_player_game_logs
  WHERE fetched_at >= NOW() - INTERVAL '18 hours';
  RAISE NOTICE 'B2a: new_rows=% with_data=% fill_pct=%', b2a_new, b2a_with, b2a_pct;

  RAISE NOTICE '';
  RAISE NOTICE '=== BLOCK 2b — score_home_away_split fire rate (commit 7ba42c3) ===';
  SELECT COUNT(*), COUNT(NULLIF(score_home_away_split, 0)),
    ROUND(100.0 * COUNT(NULLIF(score_home_away_split, 0)) / NULLIF(COUNT(*), 0), 1)
  INTO b2b_picks, b2b_fires, b2b_rate
  FROM pick_history
  WHERE source = 'process-games' AND is_synthetic = false
    AND created_at >= NOW() - INTERVAL '18 hours';
  RAISE NOTICE 'B2b: picks=% fires=% fire_rate=%', b2b_picks, b2b_fires, b2b_rate;
END $$;
