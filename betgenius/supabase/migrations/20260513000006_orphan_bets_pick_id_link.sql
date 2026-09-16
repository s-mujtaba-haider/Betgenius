-- =============================================================================
-- §15.10 H5 selection-bias prep — 11 orphan bets get pick_id linked.
-- CEO §19.3 approval May 12, 2026.
-- Audit:    /tmp/orphan_bets_cleanup_may12.md
-- Forward-ref: D-132
-- =============================================================================
-- Two groups updated:
--   Group A (8 unambiguous single-match organic bets, May 7-9)
--   Group B (3 ambiguous, resolved via "prefer organic over synthetic" rule,
--            May 7) — subscribers physically saw the organic picks, never the
--            synthetic D-125 calibration artifacts.
-- Group C (16 Feb 3 → Mar 20 zero-match orphans) DEFERRED to fuzzy audit.
--
-- Transactional safety: a single DO block is one implicit transaction. Each
-- UPDATE checks GET DIAGNOSTICS ROW_COUNT and RAISES EXCEPTION if != 1, which
-- rolls back the entire block before any row mutates.
--
-- The `AND pick_id IS NULL` guard on every UPDATE prevents accidental
-- overwrite if the bet was modified between audit and execution.

DO $$
DECLARE
  r RECORD;
  affected INT;
BEGIN
  RAISE NOTICE '=== Pre-state snapshot (11 orphan bets) ===';
  FOR r IN
    SELECT id, pick_id, LEFT(player_name, 22) AS player, prop_type,
           pick_side, line, odds, stake, placed_at::DATE AS placed
    FROM bets
    WHERE id IN (
      '227c42cd-3ae7-4425-bec0-9f6f55eb769b',
      '613e55d2-7f06-45f1-b0c1-c4f61fcaaf11',
      '61e66b57-da50-4392-b23d-88b8f99be661',
      '8be8f637-aa50-4867-b087-ff458b766d0a',
      'cd5430f3-4d7f-488f-85ec-1de29f8ccef3',
      'e3b76074-a9b4-42c5-a320-eba401568c71',
      'f0c084ea-716b-4862-aa82-b1c6f1163420',
      'f5a6d252-2815-4834-9e61-af30441ab66c',
      '78797184-53c2-4510-adbf-e5adeb28696e',
      'c09fe168-c965-4db0-9c2e-8e83bcccd6b3',
      'cb536242-c56d-4835-b879-3eadd8180b14'
    )
    ORDER BY placed_at, id
  LOOP
    RAISE NOTICE 'pre: bet=% pick_id=% % %/%@% placed=%',
      r.id, COALESCE(r.pick_id::TEXT, 'NULL'),
      RPAD(r.player, 22), RPAD(r.prop_type, 12),
      RPAD(r.pick_side, 6), r.line, r.placed;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Group A: 8 unambiguous single-match UPDATEs ===';

  -- A1: Dean Wade rebounds O3.5 May 9
  UPDATE bets SET pick_id = '40f29551-5448-4513-935b-a68b4267f6c6'
    WHERE id = '227c42cd-3ae7-4425-bec0-9f6f55eb769b' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A1 (Dean Wade reb) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A1 ✓ Dean Wade reb O3.5 May 9 → pick 40f29551';

  -- A2: Isaiah Joe points O3.5 May 9
  UPDATE bets SET pick_id = '993409e8-8dd8-471d-8438-6dac2038f96a'
    WHERE id = '613e55d2-7f06-45f1-b0c1-c4f61fcaaf11' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A2 (Isaiah Joe pts) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A2 ✓ Isaiah Joe pts O3.5 May 9 → pick 993409e8';

  -- A3: Chet Holmgren blocks O1.5 May 9
  UPDATE bets SET pick_id = 'ce36d30a-3a81-4e30-9e4f-f079ac788894'
    WHERE id = '61e66b57-da50-4392-b23d-88b8f99be661' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A3 (Chet Holmgren blk) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A3 ✓ Chet Holmgren blk O1.5 May 9 → pick ce36d30a';

  -- A4: Tobias Harris points O18.5 May 9
  UPDATE bets SET pick_id = 'af06085a-64c1-4fcd-a1f6-0f0317e7d54c'
    WHERE id = '8be8f637-aa50-4867-b087-ff458b766d0a' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A4 (Tobias Harris pts) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A4 ✓ Tobias Harris pts O18.5 May 9 → pick af06085a';

  -- A5: Donovan Mitchell points U26.5 May 9
  UPDATE bets SET pick_id = 'a5dff258-15d1-45e4-9481-76313b2b62ef'
    WHERE id = 'cd5430f3-4d7f-488f-85ec-1de29f8ccef3' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A5 (Donovan Mitchell pts U) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A5 ✓ Donovan Mitchell pts U26.5 May 9 → pick a5dff258';

  -- A6: Max Strus rebounds O3.5 May 9
  UPDATE bets SET pick_id = '03c4bd97-8c1a-41d7-b13c-b3743adcaed0'
    WHERE id = 'e3b76074-a9b4-42c5-a320-eba401568c71' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A6 (Max Strus reb) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A6 ✓ Max Strus reb O3.5 May 9 → pick 03c4bd97';

  -- A7: Karl-Anthony Towns points U20.5 May 8
  UPDATE bets SET pick_id = '2fa8d4ae-cd23-44cd-9638-1b3454c649a4'
    WHERE id = 'f0c084ea-716b-4862-aa82-b1c6f1163420' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A7 (Karl-Anthony Towns pts U) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A7 ✓ KAT pts U20.5 May 8 → pick 2fa8d4ae';

  -- A8: Miles McBride rebounds U2.5 May 8
  UPDATE bets SET pick_id = '091607d3-020d-4202-b7e6-c1fd109abe25'
    WHERE id = 'f5a6d252-2815-4834-9e61-af30441ab66c' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'A8 (Miles McBride reb U) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'A8 ✓ Miles McBride reb U2.5 May 8 → pick 091607d3';

  RAISE NOTICE '';
  RAISE NOTICE '=== Group B: 3 ambiguous (prefer-organic rule) UPDATEs ===';

  -- B1: Donovan Mitchell rebounds O3.5 May 7 — choose organic conf 90 over synth conf 92
  UPDATE bets SET pick_id = '6b2eb184-a1ab-40f1-ad94-b7a42249821c'
    WHERE id = '78797184-53c2-4510-adbf-e5adeb28696e' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'B1 (Donovan Mitchell reb May 7) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'B1 ✓ Donovan Mitchell reb O3.5 May 7 → pick 6b2eb184 (organic conf 90)';

  -- B2: Rui Hachimura points O12.5 May 7 — choose organic conf 92 over synth conf 94
  UPDATE bets SET pick_id = '198cf98d-34bb-4c7e-ae0c-18a31c638d76'
    WHERE id = 'c09fe168-c965-4db0-9c2e-8e83bcccd6b3' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'B2 (Rui Hachimura pts May 7) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'B2 ✓ Rui Hachimura pts O12.5 May 7 → pick 198cf98d (organic conf 92)';

  -- B3: Dean Wade points O4.5 May 7 — choose organic conf 81 over synth conf 83
  UPDATE bets SET pick_id = '186bae07-00e9-4322-bc24-41b04a81ac3a'
    WHERE id = 'cb536242-c56d-4835-b879-3eadd8180b14' AND pick_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'B3 (Dean Wade pts May 7) affected % rows, aborting', affected; END IF;
  RAISE NOTICE 'B3 ✓ Dean Wade pts O4.5 May 7 → pick 186bae07 (organic conf 81)';

  RAISE NOTICE '';
  RAISE NOTICE '=== Post-state verification ===';

  -- All 11 should now have pick_id set, joining cleanly to pick_history.
  FOR r IN
    SELECT b.id AS bet_id, b.pick_id, LEFT(b.player_name, 22) AS bet_player,
           LEFT(p.player_name, 22) AS pick_player,
           b.prop_type AS bet_prop, p.prop_type AS pick_prop,
           b.line AS bet_line, p.line AS pick_line,
           b.pick_side AS bet_side, p.pick_side AS pick_side,
           p.is_synthetic, p.confidence
    FROM bets b
    LEFT JOIN pick_history p ON p.id = b.pick_id
    WHERE b.id IN (
      '227c42cd-3ae7-4425-bec0-9f6f55eb769b',
      '613e55d2-7f06-45f1-b0c1-c4f61fcaaf11',
      '61e66b57-da50-4392-b23d-88b8f99be661',
      '8be8f637-aa50-4867-b087-ff458b766d0a',
      'cd5430f3-4d7f-488f-85ec-1de29f8ccef3',
      'e3b76074-a9b4-42c5-a320-eba401568c71',
      'f0c084ea-716b-4862-aa82-b1c6f1163420',
      'f5a6d252-2815-4834-9e61-af30441ab66c',
      '78797184-53c2-4510-adbf-e5adeb28696e',
      'c09fe168-c965-4db0-9c2e-8e83bcccd6b3',
      'cb536242-c56d-4835-b879-3eadd8180b14'
    )
  LOOP
    -- Hard assertion: each linked pick must natural-key match the bet.
    IF r.bet_player IS DISTINCT FROM r.pick_player
       OR r.bet_prop IS DISTINCT FROM r.pick_prop
       OR r.bet_line IS DISTINCT FROM r.pick_line
       OR r.bet_side IS DISTINCT FROM r.pick_side THEN
      RAISE EXCEPTION 'Natural-key mismatch on bet %: bet=%/%/% vs pick=%/%/% — aborting',
        r.bet_id,
        r.bet_player, r.bet_prop, r.bet_line || ' ' || r.bet_side,
        r.pick_player, r.pick_prop, r.pick_line || ' ' || r.pick_side;
    END IF;
    IF r.is_synthetic THEN
      RAISE EXCEPTION 'Synthetic pick linked for bet % — prefer-organic rule violated', r.bet_id;
    END IF;
    RAISE NOTICE 'post: bet=% → pick=% % %/%@% syn=% conf=%',
      r.bet_id, r.pick_id,
      RPAD(r.pick_player, 22), RPAD(r.pick_prop, 12),
      RPAD(r.pick_side, 6), r.pick_line,
      r.is_synthetic, r.confidence;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Remaining orphans (expected: 16 Group C deferred) ===';
  SELECT COUNT(*) INTO affected FROM bets WHERE pick_id IS NULL;
  RAISE NOTICE 'remaining_orphans=%', affected;
  IF affected <> 16 THEN
    RAISE WARNING 'Expected 16 remaining orphans, got % — investigate Group C count drift', affected;
  END IF;
END $$;
