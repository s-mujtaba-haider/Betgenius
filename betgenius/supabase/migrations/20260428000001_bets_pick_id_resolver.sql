-- ============================================================================
-- Migration: bets_pick_id_resolver
-- Created : 2026-04-28
-- Purpose : Wire bets.pick_id to pick_history via a natural-key resolver that
--           runs automatically on every INSERT, plus a one-shot backfill of
--           the existing rows that currently have pick_id = NULL.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE
--             TRIGGER, defensive DO-block FK drop, CREATE INDEX IF NOT EXISTS,
--             backfill UPDATE guarded by `pick_id IS NULL`. Safe to re-run.
--
-- Cardinal Rule #4 documentation:
--   What     : 1) Drop the legacy FK constraint on bets(pick_id), which
--                 currently references the unused public.picks table — found
--                 dynamically by column set so the auto-generated name doesn't
--                 matter.
--              2) CREATE OR REPLACE FUNCTION resolve_bet_pick_id() —
--                 BEFORE INSERT plpgsql trigger that runs the same natural-key
--                 match as the real_money_bets view: lower(player_name),
--                 prop_type, line, pick_side, game_date within ±1 day of the
--                 bet's effective ET date. Same tiebreak: process-games >
--                 dashboard > evaluator, then confidence DESC NULLS LAST,
--                 then created_at DESC, LIMIT 1. Respects an explicitly-set
--                 NEW.pick_id (only resolves when NEW.pick_id IS NULL).
--              3) CREATE TRIGGER bets_resolve_pick_id BEFORE INSERT ON bets.
--              4) Backfill: UPDATE bets SET pick_id = sub.matched_pick_id
--                 FROM (SELECT … FROM real_money_bets WHERE is_matched) sub
--                 WHERE bets.id = sub.bet_id AND bets.pick_id IS NULL.
--              5) CREATE INDEX idx_bets_pick_id (filtered, only NOT NULL).
--              6) COMMENT ON FUNCTION + TRIGGER.
--
--   Why      : Yesterday's C17 work made bets ⨝ pick_history queryable via
--              the real_money_bets view's natural-key join. That keeps the
--              join logic in one SQL place but recomputes the match every
--              time the view is read. Storing the resolved pick_id on the
--              bet row itself (a) makes future queries trivial (id-based
--              join), (b) gives downstream tooling a stable foreign key
--              even after the natural-key match ages out, and (c) lets
--              new writers (BetTracker manual form, Dashboard "Log" buttons,
--              future edge functions) auto-populate the link without
--              duplicating the resolver in the frontend.
--
--   When     : 2026-04-28, after CEO review of this migration plan, manually
--              via supabase db push.
--
--   Impact   : - bets table:
--                  * One legacy FK constraint dropped (was dormant — pick_id
--                    has been NULL on every row in production for the life
--                    of the project).
--                  * One BEFORE INSERT trigger added; runs ~one indexed
--                    SELECT against pick_history per insert (acceptable on
--                    a table that sees ~10-50 inserts/day).
--                  * Backfill UPDATE touches ~673 of 689 existing rows
--                    (~97.7% match rate per real_money_bets). The remaining
--                    ~16 rows stay NULL — those are the off-algorithm bets
--                    the user logged against props the algorithm never
--                    picked. Correct outcome, not an error.
--                  * One filtered index added. Cheap; the table is small.
--              - Read consumers: real_money_bets view continues to work
--                unchanged. Performance.tsx and any other consumers see
--                the same rows; pick_id is now an additional fact, not a
--                replacement.
--              - No new FK is added against pick_history. pick_history is
--                effectively append-only in normal operation but a FK would
--                break if any future cleanup deletes rows. Better to keep
--                pick_id as a soft reference, mirroring how the natural-key
--                view operates.
--
--   Rollback : DROP TRIGGER IF EXISTS bets_resolve_pick_id ON public.bets;
--              DROP FUNCTION IF EXISTS public.resolve_bet_pick_id();
--              DROP INDEX IF EXISTS idx_bets_pick_id;
--              UPDATE public.bets SET pick_id = NULL;  -- if backfill
--                                                      -- needs to be undone
--              ALTER TABLE public.bets
--                ADD CONSTRAINT bets_pick_id_fkey
--                FOREIGN KEY (pick_id) REFERENCES public.picks(id);
--              (Re-adding the legacy FK is only needed if rolling back
--               below the legacy state — usually skip this line.)
-- ============================================================================

-- 1) Drop the legacy FK on bets(pick_id), if present. Dynamic lookup by column
--    set (single column = pick_id) so an auto-generated name doesn't matter.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT c.conname
    INTO con_name
    FROM pg_constraint c
    JOIN pg_class t      ON t.oid = c.conrelid
    JOIN pg_namespace n  ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'bets'
     AND c.contype = 'f'
     AND (
       SELECT array_agg(a.attname ORDER BY a.attname)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid
          AND a.attnum   = k.attnum
     ) = ARRAY['pick_id']::name[]
   LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.bets DROP CONSTRAINT %I', con_name);
    RAISE NOTICE 'Dropped legacy FK on bets(pick_id): %', con_name;
  ELSE
    RAISE NOTICE 'No FK on bets(pick_id) found — already dropped or never existed.';
  END IF;
END
$$;

-- 2) Resolver function — natural-key match against pick_history with tiebreak.
--    plpgsql is required for the conditional return + assignment.
CREATE OR REPLACE FUNCTION public.resolve_bet_pick_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_game_date_et TEXT;
  v_pick_id      UUID;
BEGIN
  -- Respect explicitly-set pick_id; only resolve when NULL.
  IF NEW.pick_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Bet's effective game date in ET (YYYYMMDD), DST-aware.
  -- COALESCE handles the (rare) case of an INSERT with placed_at omitted.
  v_game_date_et := to_char(
    (COALESCE(NEW.placed_at, NOW()) AT TIME ZONE 'America/New_York')::date,
    'YYYYMMDD'
  );

  SELECT p.id
    INTO v_pick_id
    FROM public.pick_history p
   WHERE lower(p.player_name) = lower(NEW.player_name)
     AND p.prop_type           = NEW.prop_type
     AND p.pick_side           = NEW.pick_side
     AND p.line                = NEW.line
     AND p.game_date IS NOT NULL
     AND ABS(p.game_date::int - v_game_date_et::int) <= 1
   ORDER BY
     CASE p.source
       WHEN 'process-games' THEN 1
       WHEN 'dashboard'     THEN 2
       WHEN 'evaluator'     THEN 3
       ELSE 9
     END,
     p.confidence DESC NULLS LAST,
     p.created_at DESC
   LIMIT 1;

  -- v_pick_id is NULL if no match — that's fine, the bet stays unlinked
  -- (this matches the off-algorithm semantic in real_money_bets).
  NEW.pick_id := v_pick_id;
  RETURN NEW;
END;
$$;

-- 3) BEFORE INSERT trigger. DROP IF EXISTS for idempotent re-run.
DROP TRIGGER IF EXISTS bets_resolve_pick_id ON public.bets;
CREATE TRIGGER bets_resolve_pick_id
  BEFORE INSERT ON public.bets
  FOR EACH ROW
  EXECUTE FUNCTION public.resolve_bet_pick_id();

-- 4) One-shot backfill. Reuses the real_money_bets view's natural-key match.
--    The pick_id IS NULL guard makes this idempotent on re-run.
UPDATE public.bets b
   SET pick_id = sub.matched_pick_id
  FROM (
    SELECT bet_id, matched_pick_id
      FROM public.real_money_bets
     WHERE is_matched
  ) sub
 WHERE b.id      = sub.bet_id
   AND b.pick_id IS NULL;

-- 5) Filtered index for the bets-by-pick_id lookup path. Filtered to NOT NULL
--    so the ~16 unmatched rows don't bloat the index.
CREATE INDEX IF NOT EXISTS idx_bets_pick_id
  ON public.bets (pick_id)
  WHERE pick_id IS NOT NULL;

-- 6) Comments (overwrite-safe; PostgreSQL replaces existing comments).
COMMENT ON FUNCTION public.resolve_bet_pick_id() IS
  'BEFORE INSERT trigger function for bets. Resolves pick_id by natural-key '
  'match against pick_history (lower(player_name), prop_type, line, pick_side, '
  'game_date within ±1 day in ET). Tiebreak: process-games > dashboard > '
  'evaluator, then confidence DESC NULLS LAST, then created_at DESC. Same '
  'logic as real_money_bets view. Respects explicitly-set NEW.pick_id (only '
  'resolves when NULL).';

COMMENT ON TRIGGER bets_resolve_pick_id ON public.bets IS
  'Auto-populates pick_id on every new bet INSERT via natural-key match '
  'against pick_history. See resolve_bet_pick_id() for details.';
