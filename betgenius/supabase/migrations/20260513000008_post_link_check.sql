-- Post-link downstream check v2 — probe real_money_bets columns first.
DO $$
DECLARE r RECORD; matched_count INT; total_linked INT; total_bets INT;
BEGIN
  RAISE NOTICE '=== real_money_bets view columns ===';
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='real_money_bets'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE 'col=%', r.column_name;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Overall bets pick_id linkage ratio ===';
  SELECT COUNT(*) FILTER (WHERE pick_id IS NOT NULL), COUNT(*)
    INTO total_linked, total_bets FROM bets;
  RAISE NOTICE 'bets total=% pick_id_linked=% remaining_NULL=% (Group C: 16 expected)',
    total_bets, total_linked, total_bets - total_linked;

  RAISE NOTICE '';
  RAISE NOTICE '=== 11 newly-linked bets visible via bets.id lookup ===';
  SELECT COUNT(*) INTO matched_count
  FROM bets WHERE id IN (
    '227c42cd-3ae7-4425-bec0-9f6f55eb769b','613e55d2-7f06-45f1-b0c1-c4f61fcaaf11',
    '61e66b57-da50-4392-b23d-88b8f99be661','8be8f637-aa50-4867-b087-ff458b766d0a',
    'cd5430f3-4d7f-488f-85ec-1de29f8ccef3','e3b76074-a9b4-42c5-a320-eba401568c71',
    'f0c084ea-716b-4862-aa82-b1c6f1163420','f5a6d252-2815-4834-9e61-af30441ab66c',
    '78797184-53c2-4510-adbf-e5adeb28696e','c09fe168-c965-4db0-9c2e-8e83bcccd6b3',
    'cb536242-c56d-4835-b879-3eadd8180b14'
  ) AND pick_id IS NOT NULL;
  RAISE NOTICE 'newly_linked_with_pick_id=% (expected 11)', matched_count;
END $$;
