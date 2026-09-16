-- ============================================================================
-- Migration: add_sport_column
-- Created : 2026-04-29
-- Purpose : Add `sport` column to pick_history, recommendations_cache,
--           props_cache, and bets so the data layer can hold rows for any
--           sport. Backfill all existing rows to 'nba'. Composite index
--           on (sport, game_date) where applicable. Update real_money_bets
--           view to enforce within-sport joins.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE
--             OR REPLACE VIEW. Safe to re-run.
--
-- Cardinal Rule #4 documentation:
--   What     : 1) ALTER each of 4 tables ADD COLUMN sport TEXT NOT NULL
--                 DEFAULT 'nba'. Postgres 11+ stores the default in
--                 pg_attribute without rewriting rows.
--              2) CREATE INDEX (sport, game_date) on pick_history and
--                 recommendations_cache.
--              3) CREATE OR REPLACE VIEW public.real_money_bets — preserve
--                 the existing definition exactly, but expose b.sport in
--                 bets_normalized and add `AND p.sport = bn.sport` to the
--                 ranked_matches JOIN clause so cross-sport collisions
--                 (e.g. an NBA pick and an MLB pick happening to share a
--                 player name like "Anthony Rizzo") are impossible.
--
--   Why      : MLB foundation. Single-table architecture is sport-agnostic
--              enough to extend with one column rather than parallel tables.
--              Sport-specific stat columns (ERA, WHIP, etc.) defer to a
--              future migration when MLB scoring lands.
--
--   When     : 2026-04-29, after CEO approval, manually via supabase db push.
--
--   Impact   : - 70,938 rows total backfilled to sport='nba' (12,077 +
--                3,011 + 55,160 + 690). Backfill is essentially free —
--                Postgres 11+ stores DEFAULT on column metadata; only when
--                a row's sport is later UPDATEd to a non-default value
--                does the row physically change.
--              - Two new composite indexes. Combined size estimate ~150KB.
--              - View shape unchanged from a consumer's perspective. Adds
--                one column (sport) and one new bet-side filter. Every
--                existing row has sport='nba' on both bets and pick_history,
--                so all current matches stay matched.
--              - No edge function deploy required for the migration to take
--                effect. fetch-odds-mlb is a NEW function shipped in the
--                same commit but separately deployed.
--              - Read consumers (Performance, Admin, Dashboard, Games)
--                continue working unchanged because none filter on sport
--                today; they behave as if every row is NBA, which is true
--                until fetch-odds-mlb is manually triggered to seed MLB
--                rows.
--
--   Rollback : DROP INDEX IF EXISTS idx_pick_history_sport_date;
--              DROP INDEX IF EXISTS idx_recommendations_cache_sport_date;
--              -- Restore the previous view (paste from migration
--              -- 20260427000001_create_real_money_bets_view.sql)
--              CREATE OR REPLACE VIEW public.real_money_bets AS ... ;
--              ALTER TABLE public.bets DROP COLUMN IF EXISTS sport;
--              ALTER TABLE public.props_cache DROP COLUMN IF EXISTS sport;
--              ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS sport;
--              ALTER TABLE public.pick_history DROP COLUMN IF EXISTS sport;
-- ============================================================================

-- 1) Add sport column to all 4 tables.
ALTER TABLE public.pick_history          ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'nba';
ALTER TABLE public.recommendations_cache ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'nba';
ALTER TABLE public.props_cache           ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'nba';
ALTER TABLE public.bets                  ADD COLUMN IF NOT EXISTS sport TEXT NOT NULL DEFAULT 'nba';

-- 2) Composite indexes.
CREATE INDEX IF NOT EXISTS idx_pick_history_sport_date
  ON public.pick_history (sport, game_date);
CREATE INDEX IF NOT EXISTS idx_recommendations_cache_sport_date
  ON public.recommendations_cache (sport, game_date);

-- 3) Re-create real_money_bets view with sport-aware join.
CREATE OR REPLACE VIEW public.real_money_bets AS
WITH bets_normalized AS (
  SELECT
    b.id                                         AS bet_id,
    b.user_id,
    b.placed_at,
    b.settled_at,
    b.player_name                                AS player_name,
    b.prop_type                                  AS prop_type,
    b.line                                       AS line,
    b.pick_side                                  AS pick_side,
    b.odds,
    b.stake,
    b.status,
    b.result_value,
    b.payout,
    b.book,
    b.sport                                      AS sport,
    to_char((b.placed_at AT TIME ZONE 'America/New_York')::date,
            'YYYYMMDD')                          AS bet_game_date_et,
    lower(b.player_name)                         AS norm_name,
    lower(b.prop_type)                           AS norm_prop,
    lower(b.pick_side)                           AS norm_side
  FROM public.bets b
),
ranked_matches AS (
  SELECT
    bn.bet_id,
    p.id                                         AS matched_pick_id,
    p.source                                     AS matched_pick_source,
    p.confidence                                 AS matched_pick_confidence,
    p.game_date                                  AS matched_pick_game_date,
    p.created_at                                 AS matched_pick_created_at,
    ROW_NUMBER() OVER (
      PARTITION BY bn.bet_id
      ORDER BY
        CASE p.source
          WHEN 'process-games' THEN 1
          WHEN 'dashboard'     THEN 2
          WHEN 'evaluator'     THEN 3
          ELSE 9
        END,
        p.confidence DESC NULLS LAST,
        p.created_at DESC
    )                                            AS rn
  FROM bets_normalized bn
  JOIN public.pick_history p
    ON lower(p.player_name) = bn.norm_name
   AND lower(p.prop_type)   = bn.norm_prop
   AND lower(p.pick_side)   = bn.norm_side
   AND p.line               = bn.line
   AND p.game_date IS NOT NULL
   AND ABS(p.game_date::int - bn.bet_game_date_et::int) <= 1
   AND p.sport              = bn.sport
)
-- Column order is fixed by the previous CREATE VIEW (migration
-- 20260427000001). Postgres' CREATE OR REPLACE VIEW only allows APPENDING
-- columns; reordering or inserting in the middle errors with 42P16. So
-- `bn.sport` is appended after the existing 21 columns.
SELECT
  bn.bet_id,
  bn.user_id,
  bn.placed_at,
  bn.settled_at,
  bn.player_name,
  bn.prop_type,
  bn.line,
  bn.pick_side,
  bn.odds,
  bn.stake,
  bn.status,
  bn.result_value,
  bn.payout,
  bn.book,
  bn.bet_game_date_et,
  rm.matched_pick_id,
  rm.matched_pick_source,
  rm.matched_pick_confidence,
  rm.matched_pick_game_date,
  rm.matched_pick_created_at,
  (rm.matched_pick_id IS NOT NULL)               AS is_matched,
  bn.sport
FROM bets_normalized bn
LEFT JOIN ranked_matches rm
  ON rm.bet_id = bn.bet_id
 AND rm.rn     = 1;

COMMENT ON VIEW public.real_money_bets IS
  'C17 Real Money: every bet joined to its most-relevant pick_history row '
  'via natural key (player/prop/side/line) within ±1 day ET, filtered to '
  'within-sport matches only. Tiebreak: process-games > dashboard > '
  'evaluator, then highest confidence, then most recent created_at. '
  'is_matched flags rows with no algo pick. Read-only; powers the '
  'Performance Real-Money UI.';

COMMENT ON COLUMN public.pick_history.sport IS
  'Sport code: nba, mlb, nfl, nhl. All historical rows backfilled to nba.';
COMMENT ON COLUMN public.recommendations_cache.sport IS
  'Sport code. Dashboard / Games filter by selected sport on read.';
COMMENT ON COLUMN public.props_cache.sport IS
  'Sport code. fetch-odds-* writers tag rows with their sport.';
COMMENT ON COLUMN public.bets.sport IS
  'Sport code. real_money_bets view enforces same-sport joins.';
