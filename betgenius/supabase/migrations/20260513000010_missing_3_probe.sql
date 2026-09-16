DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== Find the 3 missing bets in real_money_bets via bet_id ===';
  FOR r IN
    SELECT bet_id, matched_pick_id, is_matched, placed_at::DATE AS placed,
           player_name, prop_type, pick_side, line, status
    FROM real_money_bets
    WHERE bet_id IN (
      '78797184-53c2-4510-adbf-e5adeb28696e',  -- Donovan Mitchell reb May 7
      'c09fe168-c965-4db0-9c2e-8e83bcccd6b3',  -- Rui Hachimura pts May 7
      'cb536242-c56d-4835-b879-3eadd8180b14'   -- Dean Wade pts May 7
    )
  LOOP
    RAISE NOTICE 'bet_id=% matched_pick_id=% is_matched=% placed=% % %/%@% status=%',
      r.bet_id, COALESCE(r.matched_pick_id::TEXT, 'NULL'), r.is_matched, r.placed,
      r.player_name, r.prop_type, r.pick_side, r.line, r.status;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Direct bets row state for the 3 ===';
  FOR r IN
    SELECT id, pick_id, placed_at, status, user_id::TEXT AS uid
    FROM bets WHERE id IN (
      '78797184-53c2-4510-adbf-e5adeb28696e',
      'c09fe168-c965-4db0-9c2e-8e83bcccd6b3',
      'cb536242-c56d-4835-b879-3eadd8180b14'
    )
  LOOP
    RAISE NOTICE 'bet=% pick_id=% placed=% status=% user=%',
      r.id, COALESCE(r.pick_id::TEXT, 'NULL'), r.placed_at, r.status, r.uid;
  END LOOP;
END $$;
