-- ============================================================================
-- Migration: default_bet_user_id
-- Created : 2026-04-29
-- Purpose : Extend the existing resolve_bet_pick_id() trigger to also default
--           bets.user_id to the placeholder UUID when callers omit it. Plus a
--           one-shot backfill of the 14 rows that landed since yesterday's
--           initial 689-row backfill.
--
-- Idempotent: CREATE OR REPLACE FUNCTION (preserves the existing trigger that
--             references it); backfill UPDATE guarded by `user_id IS NULL`.
--             Safe to re-run.
--
-- Cardinal Rule #4 documentation:
--   What     : 1) CREATE OR REPLACE FUNCTION public.resolve_bet_pick_id() —
--                 keep the entire existing pick_id resolver body (natural-key
--                 match against pick_history with source/confidence/created_at
--                 tiebreak), and prepend a small block that defaults
--                 NEW.user_id to '00000000-0000-0000-0000-000000000001'::uuid
--                 when NULL. The existing trigger
--                 `bets_resolve_pick_id BEFORE INSERT ON bets` continues to
--                 reference this function — no DROP/CREATE TRIGGER needed.
--              2) Backfill: UPDATE bets SET user_id = placeholder WHERE
--                 user_id IS NULL.
--              3) COMMENT ON FUNCTION updated.
--
--   Why      : Yesterday's `add_user_id_to_bets` migration backfilled the 676
--              existing rows but did not affect future inserts. None of the 3
--              frontend insert paths (BetTracker manual form, Dashboard "Log
--              All Picks", Dashboard per-card "Log Bet") set user_id, so 14
--              new rows since yesterday landed with user_id NULL. Performance
--              filters `?user_id=eq.<placeholder>` and so doesn't display them.
--              Defaulting in the trigger fixes every existing writer + every
--              future writer in one place, mirroring how pick_id is resolved.
--
--   When     : 2026-04-29, after CEO review of this migration plan, manually
--              via supabase db push.
--
--   Impact   : - Trigger function: existing pick_id resolution logic preserved
--                byte-for-byte. New 4-line guard at top of body. The IS NULL
--                check protects any future writer that DOES set user_id
--                explicitly (e.g. after Supabase Auth ships) from being
--                clobbered.
--              - Backfill: 14 rows updated to placeholder UUID. No row writes
--                outside that set. After backfill, every bets row has a
--                non-null user_id and Performance shows all 690 in the lifetime
--                view (assuming user_id filter still equals placeholder).
--              - No schema change. No new column. No new index.
--              - Read consumers: Performance.tsx already filters on the
--                placeholder UUID — backfill makes today's 14 bets visible.
--                real_money_bets view is unaffected (it scopes via user_id
--                filter on read, not on view definition).
--
--   Rollback : -- Restore the previous (non-defaulting) function body:
--              CREATE OR REPLACE FUNCTION public.resolve_bet_pick_id()
--              -- (paste yesterday's function body)
--              UPDATE public.bets SET user_id = NULL WHERE user_id =
--                '00000000-0000-0000-0000-000000000001'::uuid
--                AND placed_at >= '2026-04-28T15:00:00Z';
--              -- (only un-defaults the rows we set today, keeps yesterday's
--              -- 676-row backfill intact)
-- ============================================================================

-- 1) Extended trigger function: defaults user_id, then runs the existing
--    pick_id resolver. Function body below is the same plpgsql logic from
--    20260428000001_bets_pick_id_resolver.sql with one new IF block at top.
CREATE OR REPLACE FUNCTION public.resolve_bet_pick_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_game_date_et TEXT;
  v_pick_id      UUID;
BEGIN
  -- Default user_id to placeholder when caller omits it. Single-user phase
  -- only; remove this block once Supabase Auth ships and frontends supply
  -- the auth UUID directly.
  IF NEW.user_id IS NULL THEN
    NEW.user_id := '00000000-0000-0000-0000-000000000001'::uuid;
  END IF;

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
  -- (matches the off-algorithm semantic in real_money_bets).
  NEW.pick_id := v_pick_id;
  RETURN NEW;
END;
$$;

-- 2) One-shot backfill. Idempotent via the IS NULL guard.
UPDATE public.bets
   SET user_id = '00000000-0000-0000-0000-000000000001'::uuid
 WHERE user_id IS NULL;

-- 3) Comment update. Overwrite-safe.
COMMENT ON FUNCTION public.resolve_bet_pick_id() IS
  'BEFORE INSERT trigger function for bets. Defaults user_id to the '
  'single-user placeholder UUID when null, then resolves pick_id by '
  'natural-key match against pick_history (lower(player_name), prop_type, '
  'line, pick_side, game_date within ±1 day in ET). Tiebreak: process-games '
  '> dashboard > evaluator, then confidence DESC NULLS LAST, then created_at '
  'DESC. Same logic as real_money_bets view. Respects explicitly-set '
  'NEW.pick_id and NEW.user_id (only resolves when NULL).';
