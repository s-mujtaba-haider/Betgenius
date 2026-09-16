-- C40 RPC smoke test (May 9, 2026). Verify upsert_pick_history works for
-- both INSERT-new and UPDATE-on-conflict paths. Read-only on real production
-- data; uses sentinel player_name for isolation + cleanup at end.

DO $$
DECLARE
  v_test_player CONSTANT TEXT := 'C40_RPC_SMOKE_DELETE_ME';
  v_today CONSTANT DATE := CURRENT_DATE;
  v_payload_v1 JSONB;
  v_payload_v2 JSONB;
  v_id_v1 UUID;
  v_id_v2 UUID;
  v_count INTEGER;
  v_row RECORD;
BEGIN
  DELETE FROM pick_history WHERE player_name = v_test_player;
  RAISE NOTICE '=== C40 RPC smoke @ % ===', NOW();

  -- v1: first insert
  v_payload_v1 := jsonb_build_object(
    'player_name', v_test_player, 'team', 'TEST_TEAM', 'opponent', 'OPP',
    'prop_type', 'points', 'line', 99.5, 'pick_side', 'over', 'odds', -110,
    'game_date', v_today,
    'confidence', 50, 'verdict', 'Strong Pick', 'source', 'c40-rpc-smoke-v1',
    'is_synthetic', false, 'sport', 'nba'
  );
  v_id_v1 := public.upsert_pick_history(v_payload_v1);
  RAISE NOTICE '  insert v1 returned id=% (confidence=50, source=c40-rpc-smoke-v1)', v_id_v1;

  -- v2: same natural key, different values → expect UPDATE not INSERT
  v_payload_v2 := jsonb_build_object(
    'player_name', v_test_player, 'team', 'TEST_TEAM_2', 'opponent', 'OPP_2',
    'prop_type', 'points', 'line', 99.5, 'pick_side', 'over', 'odds', -120,
    'game_date', v_today,
    'confidence', 75, 'verdict', 'Elite Pick', 'source', 'c40-rpc-smoke-v2',
    'is_synthetic', false, 'sport', 'nba'
  );
  v_id_v2 := public.upsert_pick_history(v_payload_v2);
  RAISE NOTICE '  upsert v2 returned id=% (confidence=75, source=c40-rpc-smoke-v2)', v_id_v2;

  -- Confirm same id (= UPDATE path)
  IF v_id_v1 = v_id_v2 THEN
    RAISE NOTICE '  v1 id == v2 id ✓ (UPDATE path resolved correctly)';
  ELSE
    RAISE NOTICE '  v1 id != v2 id ✗ (split into 2 rows — partial index NOT honored!)';
  END IF;

  -- Confirm row count
  SELECT COUNT(*) INTO v_count FROM pick_history WHERE player_name = v_test_player;
  RAISE NOTICE '  total rows for test player: % (expected 1)', v_count;

  -- Confirm UPDATE actually changed values
  SELECT * INTO v_row FROM pick_history WHERE player_name = v_test_player LIMIT 1;
  RAISE NOTICE '  current state: confidence=% verdict=% source=% odds=% team=%',
    v_row.confidence, v_row.verdict, v_row.source, v_row.odds, v_row.team;
  IF v_row.confidence = 75 AND v_row.source = 'c40-rpc-smoke-v2' AND v_row.odds = -120 THEN
    RAISE NOTICE '  UPDATE columns landed correctly ✓';
  ELSE
    RAISE NOTICE '  UPDATE columns did NOT land — confidence/source/odds mismatch ✗';
  END IF;

  -- Cleanup
  DELETE FROM pick_history WHERE player_name = v_test_player;
  RAISE NOTICE '  cleanup: deleted test rows';
END $$;
