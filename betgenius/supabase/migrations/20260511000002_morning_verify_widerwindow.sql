-- Re-run checks 1+2 with wider window — today's slate completed 14:02 UTC
-- (3+ hours ago). Switching from "last 2 hours" to "today (UTC)".
DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
BEGIN
  RAISE NOTICE '=== Re-verify CHECKS 1+2 with wider window @ % ===', NOW();

  -- CHECK 1: today's pick_history (UTC day)
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 1 (re-do) — today UTC ###';
  FOR v_row IN
    SELECT
      DATE(created_at) AS day,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('points','rebounds','assists','threes','steals','blocks','turnovers')) AS player_props,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('spread','game_total')) AS game_props,
      COUNT(*) FILTER (WHERE is_synthetic = false) AS prod_total
    FROM pick_history
    WHERE created_at >= DATE_TRUNC('day', NOW())
    GROUP BY DATE(created_at)
    ORDER BY day DESC
  LOOP
    RAISE NOTICE '  % : player_props=% game_props=% prod_total=%',
      v_row.day, v_row.player_props, v_row.game_props, v_row.prod_total;
  END LOOP;

  -- per-source breakdown for today
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 1b — source breakdown today ###';
  FOR v_row IN
    SELECT source, COUNT(*) AS n
    FROM pick_history
    WHERE created_at >= DATE_TRUNC('day', NOW())
      AND is_synthetic = false
    GROUP BY source
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '  source=%  rows=%', COALESCE(v_row.source, '(null)'), v_row.n;
  END LOOP;

  -- CHECK 2: today's score_player_injury distribution
  RAISE NOTICE '';
  RAISE NOTICE '### CHECK 2 (re-do) — score_player_injury today UTC ###';
  FOR v_row IN
    SELECT score_player_injury AS spi, COUNT(*) AS n
    FROM pick_history
    WHERE created_at >= DATE_TRUNC('day', NOW())
      AND ABS(COALESCE(score_player_injury, 0)) > 0.01
    GROUP BY score_player_injury
    ORDER BY ABS(score_player_injury) DESC, n DESC
  LOOP
    RAISE NOTICE '  score_player_injury=%  rows=%', v_row.spi, v_row.n;
  END LOOP;

  SELECT COUNT(*) INTO v_count
  FROM pick_history
  WHERE created_at >= DATE_TRUNC('day', NOW())
    AND ABS(COALESCE(score_player_injury, 0)) > 0.01;
  RAISE NOTICE '  total non-zero injury-penalty rows today: %', v_count;

  SELECT COUNT(*) INTO v_count
  FROM pick_history
  WHERE created_at >= DATE_TRUNC('day', NOW())
    AND COALESCE(score_player_injury, 0) = 0;
  RAISE NOTICE '  total zero-injury-penalty rows today: %', v_count;
END $$;
