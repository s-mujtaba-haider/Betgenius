-- May 7-9 organic backfill data-availability audit (May 9, 2026).
-- Read-only. Confirms what source data exists for a backfill of those dates.

DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
BEGIN
  RAISE NOTICE '=== May 7-9 backfill data audit @ % ===', NOW();

  -- 1. props_cache — does it have May 7-9 data?
  RAISE NOTICE '';
  RAISE NOTICE '--- props_cache by game_date for May 7-9 ---';
  FOR v_row IN
    SELECT game_date, COUNT(*) AS prop_rows,
           COUNT(DISTINCT event_id) AS games,
           COUNT(DISTINCT player_name) FILTER (WHERE player_name IS NOT NULL) AS players
    FROM props_cache
    WHERE game_date IN ('20260507','20260508','20260509')
    GROUP BY game_date
    ORDER BY game_date
  LOOP
    RAISE NOTICE '  %: rows=% games=% players=%',
      v_row.game_date, v_row.prop_rows, v_row.games, v_row.players;
  END LOOP;

  -- 2. cache_player_game_logs — does it have May 7-9 data?
  RAISE NOTICE '';
  RAISE NOTICE '--- cache_player_game_logs by game_date for May 6-9 ---';
  FOR v_row IN
    SELECT game_date, COUNT(*) AS log_rows
    FROM cache_player_game_logs
    WHERE game_date >= '2026-05-06' AND game_date <= '2026-05-09'
    GROUP BY game_date
    ORDER BY game_date
  LOOP
    RAISE NOTICE '  %: %', v_row.game_date, v_row.log_rows;
  END LOOP;

  -- 3. recommendations_cache for May 7-9 — what we have already (with confidence + scoring)
  RAISE NOTICE '';
  RAISE NOTICE '--- recommendations_cache by game_date for May 7-9 (player-prop only, sport=nba) ---';
  FOR v_row IN
    SELECT game_date, COUNT(*) AS rows
    FROM recommendations_cache
    WHERE game_date IN ('2026-05-07','2026-05-08','2026-05-09')
      AND prop_type NOT IN ('spread','game_total')
      AND sport = 'nba'
    GROUP BY game_date
    ORDER BY game_date
  LOOP
    RAISE NOTICE '  %: %', v_row.game_date, v_row.rows;
  END LOOP;

  -- 4. pick_history baseline for May 6-9 (per CEO TASK 2)
  RAISE NOTICE '';
  RAISE NOTICE '--- pick_history pre-backfill baseline for May 6-9 ---';
  FOR v_row IN
    SELECT
      DATE(created_at) AS day,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('points','rebounds','assists','threes','steals','blocks','turnovers')) AS player_props,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('spread','game_total')) AS game_props,
      COUNT(*) FILTER (WHERE is_synthetic = false) AS prod_total
    FROM pick_history
    WHERE created_at >= '2026-05-06' AND created_at < '2026-05-10'
    GROUP BY DATE(created_at)
    ORDER BY day
  LOOP
    RAISE NOTICE '  %: player_props=% game_props=% prod_total=%',
      v_row.day, v_row.player_props, v_row.game_props, v_row.prod_total;
  END LOOP;

  -- 5. Spot check — is there matching opponent / team / game_time data in
  --    recommendations_cache for May 7+8 that we'd need to copy to pick_history?
  RAISE NOTICE '';
  RAISE NOTICE '--- recommendations_cache field availability for backfill ---';
  FOR v_row IN
    SELECT game_date,
           COUNT(*) FILTER (WHERE team IS NOT NULL) AS has_team,
           COUNT(*) FILTER (WHERE opponent IS NOT NULL) AS has_opp,
           COUNT(*) FILTER (WHERE game_time IS NOT NULL) AS has_game_time,
           COUNT(*) FILTER (WHERE confidence IS NOT NULL) AS has_confidence,
           COUNT(*) FILTER (WHERE score_l5 IS NOT NULL) AS has_score_l5,
           COUNT(*) FILTER (WHERE projected_stat IS NOT NULL) AS has_projected,
           COUNT(*) AS total
    FROM recommendations_cache
    WHERE game_date IN ('2026-05-07','2026-05-08','2026-05-09')
      AND prop_type NOT IN ('spread','game_total')
      AND sport = 'nba'
    GROUP BY game_date
    ORDER BY game_date
  LOOP
    RAISE NOTICE '  %: total=% team=% opp=% game_time=% conf=% score_l5=% projected=%',
      v_row.game_date, v_row.total, v_row.has_team, v_row.has_opp,
      v_row.has_game_time, v_row.has_confidence, v_row.has_score_l5, v_row.has_projected;
  END LOOP;

  -- 6. backfill_runs — show recent runs (column names probed at runtime)
  RAISE NOTICE '';
  RAISE NOTICE '--- backfill_runs recent (last 5) ---';
  FOR v_row IN
    SELECT id, status, started_at
    FROM backfill_runs
    ORDER BY started_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  id=% status=% started=%', v_row.id, v_row.status, v_row.started_at;
  END LOOP;

  -- 7. Stale pending bets count (TASK 5 prep)
  SELECT COUNT(*) INTO v_count FROM bets WHERE status = 'pending' AND placed_at >= '2026-05-07';
  RAISE NOTICE '';
  RAISE NOTICE '--- bets pending placed >= May 7: % ---', v_count;
END $$;
