-- C40 empirical probe v2 (May 9, 2026). Tests which ON CONFLICT syntaxes work
-- against the partial unique index `pick_history_production_natural_uniq`.
-- Each option in its own BEGIN/EXCEPTION block so one failure doesn't abort
-- the whole probe. All test rows isolated via sentinel player_name.

DO $$
DECLARE
  v_test_player CONSTANT TEXT := 'C40_PROBE_DELETE_ME_xyz123';
  v_today CONSTANT DATE := CURRENT_DATE;
  v_test_line CONSTANT NUMERIC := 99.5;
  v_err TEXT;
  v_count INTEGER;
  v_existing_count INTEGER;
  v_row RECORD;
BEGIN
  -- Clean any leftover
  DELETE FROM pick_history WHERE player_name = v_test_player;

  RAISE NOTICE '=== C40 ON CONFLICT probe @ % ===', NOW();

  -- Set up base row (with required NOT NULL fields)
  BEGIN
    INSERT INTO pick_history (
      player_name, prop_type, line, game_date, pick_side, odds,
      confidence, is_synthetic, source
    ) VALUES (
      v_test_player, 'points', v_test_line, v_today, 'over', -110,
      50, false, 'c40-probe-base'
    );
    RAISE NOTICE 'Setup: 1 base row inserted player_name=%', v_test_player;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE 'Setup FAILED — %', v_err;
    RETURN;
  END;

  -- Option (a): ON CONFLICT (cols) DO UPDATE — current PostgREST pattern
  RAISE NOTICE '';
  RAISE NOTICE '--- Option (a): ON CONFLICT (player_name, prop_type, line, game_date) DO UPDATE ---';
  BEGIN
    INSERT INTO pick_history (
      player_name, prop_type, line, game_date, pick_side, odds,
      confidence, is_synthetic, source
    ) VALUES (
      v_test_player, 'points', v_test_line, v_today, 'over', -110,
      55, false, 'c40-probe-a'
    )
    ON CONFLICT (player_name, prop_type, line, game_date) DO UPDATE
      SET source = EXCLUDED.source;
    RAISE NOTICE '  WORKS — Postgres resolved conflict_target to partial index without WHERE';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '  FAILS — % / SQLSTATE=%', v_err, SQLSTATE;
  END;

  -- Option (b): ON CONFLICT (cols) WHERE predicate
  RAISE NOTICE '';
  RAISE NOTICE '--- Option (b): ON CONFLICT (cols) WHERE is_synthetic = false DO UPDATE ---';
  BEGIN
    INSERT INTO pick_history (
      player_name, prop_type, line, game_date, pick_side, odds,
      confidence, is_synthetic, source
    ) VALUES (
      v_test_player, 'points', v_test_line, v_today, 'over', -110,
      60, false, 'c40-probe-b'
    )
    ON CONFLICT (player_name, prop_type, line, game_date) WHERE is_synthetic = false DO UPDATE
      SET source = EXCLUDED.source;
    RAISE NOTICE '  WORKS — partial index resolved via WHERE predicate';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '  FAILS — % / SQLSTATE=%', v_err, SQLSTATE;
  END;

  -- Option (c): ON CONFLICT ON CONSTRAINT name
  RAISE NOTICE '';
  RAISE NOTICE '--- Option (c): ON CONFLICT ON CONSTRAINT pick_history_production_natural_uniq DO UPDATE ---';
  BEGIN
    INSERT INTO pick_history (
      player_name, prop_type, line, game_date, pick_side, odds,
      confidence, is_synthetic, source
    ) VALUES (
      v_test_player, 'points', v_test_line, v_today, 'over', -110,
      65, false, 'c40-probe-c'
    )
    ON CONFLICT ON CONSTRAINT pick_history_production_natural_uniq DO UPDATE
      SET source = EXCLUDED.source;
    RAISE NOTICE '  WORKS — index name accepted directly';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '  FAILS — % / SQLSTATE=%', v_err, SQLSTATE;
  END;

  -- Option (d): plain INSERT (no ON CONFLICT) — should raise unique_violation
  RAISE NOTICE '';
  RAISE NOTICE '--- Option (d): plain INSERT (no ON CONFLICT) ---';
  BEGIN
    INSERT INTO pick_history (
      player_name, prop_type, line, game_date, pick_side, odds,
      confidence, is_synthetic, source
    ) VALUES (
      v_test_player, 'points', v_test_line, v_today, 'over', -110,
      70, false, 'c40-probe-d'
    );
    RAISE NOTICE '  Inserted (no conflict raised — partial index NOT enforcing). Unexpected.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '  RAISED 23505 unique_violation as expected — partial index DOES enforce';
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '  Unexpected error — % / SQLSTATE=%', v_err, SQLSTATE;
  END;

  -- Option (e): ON CONFLICT DO NOTHING (no target columns)
  RAISE NOTICE '';
  RAISE NOTICE '--- Option (e): ON CONFLICT DO NOTHING (no target) ---';
  BEGIN
    INSERT INTO pick_history (
      player_name, prop_type, line, game_date, pick_side, odds,
      confidence, is_synthetic, source
    ) VALUES (
      v_test_player, 'points', v_test_line, v_today, 'over', -110,
      75, false, 'c40-probe-e'
    )
    ON CONFLICT DO NOTHING;
    SELECT COUNT(*) INTO v_count FROM pick_history WHERE player_name = v_test_player AND source = 'c40-probe-e';
    RAISE NOTICE '  WORKS — % rows added (0 = conflict skipped, 1 = no conflict)', v_count;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE NOTICE '  FAILS — % / SQLSTATE=%', v_err, SQLSTATE;
  END;

  -- Final state
  SELECT COUNT(*) INTO v_existing_count FROM pick_history WHERE player_name = v_test_player;
  RAISE NOTICE '';
  RAISE NOTICE '--- Final probe state: % rows for test player ---', v_existing_count;
  FOR v_row IN
    SELECT id, source, confidence FROM pick_history
    WHERE player_name = v_test_player
    ORDER BY created_at
  LOOP
    RAISE NOTICE '  id=% source=% confidence=%', v_row.id, v_row.source, v_row.confidence;
  END LOOP;

  -- Cleanup
  DELETE FROM pick_history WHERE player_name = v_test_player;
  RAISE NOTICE '';
  RAISE NOTICE 'cleanup: deleted % test rows', v_existing_count;
END $$;
