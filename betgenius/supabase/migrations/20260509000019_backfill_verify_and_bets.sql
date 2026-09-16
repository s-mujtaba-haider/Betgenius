-- TASK 4 + TASK 5 verification (May 9, 2026, post-backfill).
-- Read-only.

DO $$
DECLARE
  v_row RECORD;
  v_count INTEGER;
  v_pending_pre INTEGER;
  v_pending_now INTEGER;
  v_resolved_count INTEGER;
BEGIN
  RAISE NOTICE '=== May 7-9 backfill verify @ % ===', NOW();

  -- TASK 4: per-day pick_history breakdown post-backfill
  RAISE NOTICE '';
  RAISE NOTICE '--- TASK 4: pick_history per-day breakdown (May 5-9) ---';
  FOR v_row IN
    SELECT
      game_date,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('points','rebounds','assists','threes','steals','blocks','turnovers')) AS player_props,
      COUNT(*) FILTER (WHERE is_synthetic = false
        AND prop_type IN ('spread','game_total')) AS game_props,
      COUNT(*) FILTER (WHERE is_synthetic = false) AS prod_total
    FROM pick_history
    WHERE game_date >= '2026-05-05' AND game_date <= '2026-05-09'
    GROUP BY game_date
    ORDER BY game_date
  LOOP
    RAISE NOTICE '  %: player_props=% game_props=% prod_total=%',
      v_row.game_date, v_row.player_props, v_row.game_props, v_row.prod_total;
  END LOOP;

  -- Source breakdown for the new rows
  RAISE NOTICE '';
  RAISE NOTICE '--- pick_history source breakdown for May 7-9 organic ---';
  FOR v_row IN
    SELECT source, COUNT(*) AS rows
    FROM pick_history
    WHERE game_date IN ('2026-05-07','2026-05-08','2026-05-09')
      AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total')
    GROUP BY source
    ORDER BY rows DESC
  LOOP
    RAISE NOTICE '  source=%: %', COALESCE(v_row.source, '(null)'), v_row.rows;
  END LOOP;

  -- Spot-check a backfilled row: confirm scoring fields populated
  RAISE NOTICE '';
  RAISE NOTICE '--- spot-check: 3 random backfill rows ---';
  FOR v_row IN
    SELECT id, player_name, prop_type, pick_side, line, confidence, source,
           is_synthetic, hit, score_l5, score_season, projected_stat
    FROM pick_history
    WHERE source = 'backfill-may7-9-organic'
    ORDER BY RANDOM()
    LIMIT 3
  LOOP
    RAISE NOTICE '  % %/% line=% conf=% syn=% hit=% score_l5=% projected=%',
      v_row.player_name, v_row.prop_type, v_row.pick_side, v_row.line,
      v_row.confidence, v_row.is_synthetic, COALESCE(v_row.hit::TEXT, 'NULL'),
      v_row.score_l5, v_row.projected_stat;
  END LOOP;

  -- TASK 5: bets pick_id observation
  RAISE NOTICE '';
  RAISE NOTICE '=== TASK 5: bets.pick_id resolution status ===';

  SELECT COUNT(*) INTO v_pending_now
  FROM bets WHERE status = 'pending' AND placed_at >= '2026-05-07';
  RAISE NOTICE 'Pending bets placed >= May 7: % (audit had 8 pre-backfill)', v_pending_now;

  -- Show each one with current pick_id state
  RAISE NOTICE '';
  RAISE NOTICE '--- pending bets placed since May 7 (each row + pick_id state) ---';
  FOR v_row IN
    SELECT id, player_name, prop_type, line, pick_side, status,
           pick_id, placed_at, sport
    FROM bets
    WHERE status = 'pending'
      AND placed_at >= '2026-05-07'
    ORDER BY placed_at DESC
  LOOP
    RAISE NOTICE '  bet_id=% % %/% line=% sport=% pick_id=% placed_at=%',
      v_row.id, v_row.player_name, v_row.prop_type, v_row.pick_side,
      v_row.line, v_row.sport,
      COALESCE(v_row.pick_id::TEXT, 'NULL'),
      v_row.placed_at;
  END LOOP;

  -- Specifically: how many of the 8 pending bets now have non-NULL pick_id?
  -- (Trigger fires on INSERT, not UPDATE — these existing bets shouldn't have
  -- been auto-relinked. This query confirms expected state.)
  SELECT COUNT(*) INTO v_resolved_count
  FROM bets
  WHERE status = 'pending'
    AND placed_at >= '2026-05-07'
    AND pick_id IS NOT NULL;
  RAISE NOTICE '';
  RAISE NOTICE 'Pending bets with non-NULL pick_id: % (expected 0 — trigger only fires on INSERT)', v_resolved_count;

  -- Real_money_bets view sanity: how many of these bets would now show is_matched=true
  -- via the view's natural-key join (post-backfill the matching pick_history rows exist)?
  RAISE NOTICE '';
  RAISE NOTICE '--- real_money_bets view: how many May-7+ bets would match a backfilled pick_history row? ---';
  FOR v_row IN
    SELECT
      COUNT(*) FILTER (WHERE is_matched) AS matched,
      COUNT(*) FILTER (WHERE NOT is_matched) AS unmatched,
      COUNT(*) AS total
    FROM real_money_bets
    WHERE placed_at >= '2026-05-07'
  LOOP
    RAISE NOTICE '  total=% matched=% unmatched=% (view matches via natural-key, doesn''t require pick_id)',
      v_row.total, v_row.matched, v_row.unmatched;
  END LOOP;
END $$;
