-- CHECK 2 sanity (corrected — breakdown JSONB is on recommendations_cache,
-- not pick_history). Verify (a) injury-match code ran today by inspecting
-- breakdown.playerInjuryPenalty in recs_cache, (b) the teams playing today.

DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
  v_distinct_players INTEGER;
BEGIN
  RAISE NOTICE '=== CHECK 2 sanity (corrected) @ % ===', NOW();

  -- (a) Sample today's recommendations_cache rows for breakdown.playerInjuryPenalty
  RAISE NOTICE '';
  RAISE NOTICE '--- recs_cache.breakdown.playerInjuryPenalty today (sample 10) ---';
  FOR v_row IN
    SELECT
      player_name, team,
      breakdown->>'playerInjuryPenalty' AS pip_field,
      confidence
    FROM recommendations_cache
    WHERE game_date = CURRENT_DATE
      AND prop_type NOT IN ('spread', 'game_total')
      AND sport = 'nba'
    ORDER BY created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  player=% team=% pip_in_breakdown=% confidence=%',
      v_row.player_name, v_row.team,
      COALESCE(v_row.pip_field, '(missing)'),
      v_row.confidence;
  END LOOP;

  -- (b) Distribution of breakdown.playerInjuryPenalty values today
  RAISE NOTICE '';
  RAISE NOTICE '--- distribution of breakdown.playerInjuryPenalty today ---';
  FOR v_row IN
    SELECT
      breakdown->>'playerInjuryPenalty' AS pip,
      COUNT(*) AS n
    FROM recommendations_cache
    WHERE game_date = CURRENT_DATE
      AND prop_type NOT IN ('spread', 'game_total')
      AND sport = 'nba'
    GROUP BY breakdown->>'playerInjuryPenalty'
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '  pip=%  rows=%', COALESCE(v_row.pip, '(missing)'), v_row.n;
  END LOOP;

  -- (c) Teams playing today
  RAISE NOTICE '';
  RAISE NOTICE '--- teams playing today ---';
  FOR v_row IN
    SELECT DISTINCT team
    FROM pick_history
    WHERE created_at >= DATE_TRUNC('day', NOW())
      AND is_synthetic = false
      AND prop_type NOT IN ('spread', 'game_total')
    ORDER BY team
  LOOP
    RAISE NOTICE '  %', v_row.team;
  END LOOP;

  -- (d) Distinct players today
  SELECT COUNT(DISTINCT player_name) INTO v_distinct_players
  FROM pick_history
  WHERE created_at >= DATE_TRUNC('day', NOW())
    AND is_synthetic = false
    AND prop_type NOT IN ('spread', 'game_total');
  RAISE NOTICE '';
  RAISE NOTICE 'Distinct players today (player-prop only): %', v_distinct_players;
END $$;
