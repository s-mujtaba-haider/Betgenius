-- ============================================================================
-- Migration: path_c_step1_line_shopping_schema
-- Created : 2026-04-28
-- Purpose : Schema foundation for the line-shopping feature (Path C, Step 1).
--           Adds the columns needed to (a) store BOTH over and under rows in
--           props_cache, and (b) preserve every book's line+odds for each
--           scored pick on recommendations_cache.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, defensive
--             DO blocks for the constraint swap. Safe to re-run.
--
-- Cardinal Rule #4 documentation:
--   What     : 1) ALTER props_cache ADD COLUMN pick_side TEXT
--              2) Backfill existing rows with pick_side='over' (fetch-odds
--                 currently filters Over outcomes only — every existing row
--                 IS an over).
--              3) Replace the existing 4-column UNIQUE on
--                 (game_date, player_name, prop_type, bookmaker) with the
--                 5-column UNIQUE on
--                 (game_date, player_name, prop_type, bookmaker, pick_side)
--                 so PostgREST upserts can target separate over/under rows.
--              4) CREATE INDEX on props_cache(pick_side).
--              5) ALTER recommendations_cache ADD COLUMN available_books JSONB
--                 (nullable, will be populated by process-games in Step 3).
--              6) COMMENT ON both new columns.
--
--   Why      : Line-shopping requires (a) under-side rows in props_cache (Step
--              2 will lift the Over-only filter in fetch-odds) and (b) a place
--              to record every book's line+odds for each scored pick so the
--              UI can rank books per pick without re-querying the upstream
--              Odds API. The 4→5 column unique key swap is mandatory: without
--              pick_side in the unique key, the over-row and under-row for the
--              same (player, prop_type, bookmaker) collide on upsert.
--
--   When     : 2026-04-28, after CEO review of this migration plan, manually
--              via supabase db push.
--
--   Impact   : - props_cache: 44,372 existing rows backfilled to
--                pick_side='over'. One UNIQUE constraint dropped + replaced.
--                One new index. No row deletions. fetch-odds is currently
--                using on_conflict=(game_date,player_name,prop_type,bookmaker)
--                — that on_conflict target will fail until Step 2 is shipped
--                (fetch-odds rewrite must include pick_side in its
--                on_conflict URL). Plan: ship Step 2 and Step 1 within the
--                same maintenance window so the new key is in place when the
--                writer learns about it. Worst case between Step 1 and Step
--                2 deploy: fetch-odds upsert returns 409 and is logged but
--                non-fatal — the 5-min cron retries with the same effect.
--                Hot path read consumers (process-games Step 6, Dashboard
--                fetchFromCache) do not reference the unique key — those
--                queries continue to work unchanged.
--              - recommendations_cache: 2,809 existing rows. New column is
--                NULL on every existing row. No row writes. Zero blast on
--                read consumers (Dashboard / Performance) until Step 3
--                populates the column.
--
--   Rollback : ALTER TABLE props_cache DROP COLUMN IF EXISTS pick_side;
--              DROP INDEX IF EXISTS idx_props_cache_pick_side;
--              ALTER TABLE props_cache
--                DROP CONSTRAINT IF EXISTS props_cache_uniq_book_side;
--              ALTER TABLE props_cache
--                ADD CONSTRAINT <orig_name>
--                UNIQUE (game_date, player_name, prop_type, bookmaker);
--              ALTER TABLE recommendations_cache
--                DROP COLUMN IF EXISTS available_books;
--              (Step 1's rollback intentionally re-adds the original 4-col
--               unique — Step 2's fetch-odds rewrite must be reverted FIRST,
--               otherwise re-introducing the 4-col key collides with any
--               under rows already inserted.)
-- ============================================================================

-- 1) Add pick_side column to props_cache
ALTER TABLE public.props_cache
  ADD COLUMN IF NOT EXISTS pick_side TEXT;

-- 2) Backfill: every existing row was an Over outcome (fetch-odds line 131
--    filters `outcome.name !== "Over"`). Make this explicit so the column is
--    safe to use as a non-null filter going forward.
UPDATE public.props_cache
   SET pick_side = 'over'
 WHERE pick_side IS NULL;

-- 3) Swap UNIQUE constraint: drop existing 4-col, add new 5-col.
--    Defensive lookup — the existing constraint may have been auto-named by
--    Postgres when the table was created, so we find it by its column set
--    rather than guessing a name.
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
     AND t.relname = 'props_cache'
     AND c.contype = 'u'
     AND (
       SELECT array_agg(a.attname ORDER BY a.attname)
         FROM unnest(c.conkey) AS k(attnum)
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid
          AND a.attnum   = k.attnum
     ) = ARRAY['bookmaker','game_date','player_name','prop_type']::name[]
   LIMIT 1;

  IF con_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.props_cache DROP CONSTRAINT %I',
      con_name
    );
    RAISE NOTICE 'Dropped pre-existing unique constraint: %', con_name;
  ELSE
    RAISE NOTICE 'No 4-col unique on props_cache found — assuming already migrated or never existed.';
  END IF;
END
$$;

-- Add the new 5-col unique constraint (explicit short name to stay under
-- Postgres' 63-char identifier limit).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'props_cache_uniq_book_side'
  ) THEN
    ALTER TABLE public.props_cache
      ADD CONSTRAINT props_cache_uniq_book_side
        UNIQUE (game_date, player_name, prop_type, bookmaker, pick_side);
    RAISE NOTICE 'Added new 5-col unique constraint props_cache_uniq_book_side';
  ELSE
    RAISE NOTICE 'props_cache_uniq_book_side already present — skipping.';
  END IF;
END
$$;

-- 4) Filter index on pick_side
CREATE INDEX IF NOT EXISTS idx_props_cache_pick_side
  ON public.props_cache (pick_side);

-- 5) Add available_books JSONB column to recommendations_cache
ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS available_books JSONB;

-- 6) Comments (overwrite-safe; PostgreSQL replaces existing comments)
COMMENT ON COLUMN public.props_cache.pick_side IS
  'Side of the prop offered by this row: over | under. Existing rows '
  'backfilled to ''over'' (fetch-odds filtered Over outcomes only prior to '
  'Path C Step 2). Combined with bookmaker, lets us store the over and '
  'under price separately at every book.';

COMMENT ON COLUMN public.recommendations_cache.available_books IS
  'Snapshot of every book that offered this prop at scoring time, as a '
  'JSONB array of {bookmaker, line, odds, pick_side} objects. Populated '
  'by process-games Step 6 (Path C Step 3). Lets the UI rank books per '
  'pick without re-querying the Odds API.';
