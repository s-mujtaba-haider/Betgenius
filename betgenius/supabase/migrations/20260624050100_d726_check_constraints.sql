-- D-726 — Add CHECK constraints encoding baseball invariants + pick-history sanity.
-- Pre-flight probe confirmed ZERO existing violations on all 9 invariants
-- (181,723 boxscore rows + 136,330 pick rows). All constraints added as clean CHECK.
-- No NOT VALID needed.
--
-- Each constraint:
--   1. Encodes a baseball or schema invariant the system has always implicitly assumed.
--   2. Allows NULL on the source column (silent missing data is a separate concern).
--   3. Names the constraint with a d726_ prefix for traceable rollback.
--
-- Rollback: ALTER TABLE ... DROP CONSTRAINT d726_<name>; (any constraint individually).

SET statement_timeout = '120s';

-- ========== cache_mlb_boxscore_player_stats ==========

-- I1: pitcher invariant — can't strike out more batters than you faced (Shane-Baz-class guard)
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d726_strikeouts_le_batters_faced
  CHECK (strikeouts IS NULL OR batters_faced IS NULL OR strikeouts <= batters_faced);

-- I2: batter invariant — total_bases ≥ hits (a hit is worth ≥1 base; HR is worth 4)
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d726_total_bases_ge_hits
  CHECK (total_bases IS NULL OR hits IS NULL OR total_bases >= hits);

-- I3: batter invariant — home_runs ≤ hits (a HR is a hit; HR > hits is impossible)
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d726_home_runs_le_hits
  CHECK (home_runs IS NULL OR hits IS NULL OR home_runs <= hits);

-- I4: batter invariant — hits ≤ at_bats (you can only get a hit during an at-bat)
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d726_hits_le_at_bats
  CHECK (hits IS NULL OR at_bats IS NULL OR hits <= at_bats);

-- I7: pitcher sanity — innings_pitched within [0, 30] (longest MLB outing in history was 26 IP, 1920;
-- 30 is a safe upper bound that still rejects clearly-corrupt rows like negative IP or 100+ IP)
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d726_innings_pitched_sane
  CHECK (innings_pitched IS NULL OR (innings_pitched >= 0 AND innings_pitched <= 30));

-- I8: batters_faced ≥ 0 (negative is corruption)
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d726_batters_faced_non_negative
  CHECK (batters_faced IS NULL OR batters_faced >= 0);

-- I9: at_bats ≥ 0
ALTER TABLE public.cache_mlb_boxscore_player_stats
  ADD CONSTRAINT d726_at_bats_non_negative
  CHECK (at_bats IS NULL OR at_bats >= 0);

-- ========== pick_history ==========

-- I5: confidence in [0,100] — anything outside is a scoring bug
ALTER TABLE public.pick_history
  ADD CONSTRAINT d726_confidence_range
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100));

-- I6: void-state integrity — if voided=true, resolved_at MUST be set.
-- The D-718 silent-failure path was voidPick writing voided=true without resolution_note;
-- this constraint guarantees we at least have a TIMESTAMP of when the void happened.
ALTER TABLE public.pick_history
  ADD CONSTRAINT d726_voided_has_resolved_at
  CHECK (NOT (voided = true AND resolved_at IS NULL));

-- Echo what landed
DO $$ DECLARE rec record; n int;
BEGIN
  RAISE NOTICE '=== D-726 constraints installed ===';
  FOR rec IN
    SELECT conname, conrelid::regclass AS table_name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conname LIKE 'd726_%'
    ORDER BY conrelid::regclass::text, conname
  LOOP
    RAISE NOTICE '  % on %: %', rec.conname, rec.table_name, rec.def;
  END LOOP;
  SELECT count(*) INTO n FROM pg_constraint WHERE conname LIKE 'd726_%';
  RAISE NOTICE '  total D-726 constraints: %', n;
END $$;
