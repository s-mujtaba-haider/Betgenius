-- ============================================================================
-- Migration: create_real_money_bets_view
-- Created : 2026-04-27
-- Purpose : Materialize the natural-key bets ⨝ pick_history join as a SQL VIEW
--           so the Performance Real-Money UI can read it via PostgREST without
--           re-implementing the join in TypeScript.
--
-- Idempotent: CREATE OR REPLACE VIEW. Safe to re-run.
--
-- Cardinal Rule #4 documentation:
--   What     : Create VIEW public.real_money_bets selecting from public.bets
--              LEFT JOIN public.pick_history via lower(player_name) /
--              prop_type / pick_side / line, date window ±1 day in ET,
--              with deterministic tiebreak (process-games > dashboard >
--              evaluator, then highest confidence, then most recent
--              created_at) via ROW_NUMBER OVER PARTITION.
--   Why      : C17 Real Money UI needs every bet joined to the most relevant
--              algorithm pick context. SQL VIEW keeps the join logic in one
--              place (the validated /tmp/real_money_query.sql), keeps tier
--              membership / confidence consistent across the page, and lets
--              the frontend query a single endpoint with PostgREST filters.
--   When     : 2026-04-27, after Migration A succeeds and verification of
--              0 NULL user_id rows.
--   Impact   : Adds a read-only view. No table writes. No code path other
--              than the new Performance UI reads it. Existing pages
--              unaffected.
--   Rollback : DROP VIEW IF EXISTS public.real_money_bets;
--
-- Performance note: the underlying join scans bets and a date-bounded slice
-- of pick_history. Indexes already exist on pick_history(game_date) and
-- bets(user_id from Migration A). PostgREST queries should always include
-- user_id=eq.<uuid> to prune to one user.
--
-- Time zone note: bet_game_date_et uses
--   (placed_at AT TIME ZONE 'America/New_York')::date
-- which is DST-aware. PostgreSQL handles the EDT/EST switch automatically
-- via the IANA tzdata shipped with the cluster. Earlier draft used a
-- hardcoded -4 hours (EDT) and would have drifted by one day for picks
-- placed in EST months (~Nov–Mar).
-- ============================================================================

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
    -- Bet's effective game date in Eastern (YYYYMMDD), DST-aware.
    -- 'America/New_York' on a timestamptz converts to ET wall-clock and
    -- handles the EDT/EST boundary automatically.
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
)
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
  (rm.matched_pick_id IS NOT NULL)               AS is_matched
FROM bets_normalized bn
LEFT JOIN ranked_matches rm
  ON rm.bet_id = bn.bet_id
 AND rm.rn     = 1;

COMMENT ON VIEW public.real_money_bets IS
  'C17 Real Money: every bet joined to its most-relevant pick_history row '
  'via natural key (player/prop/side/line) within ±1 day ET. Tiebreak: '
  'process-games > dashboard > evaluator, then highest confidence, then '
  'most recent created_at. is_matched flags rows with no algo pick. '
  'Read-only; powers the Performance Real-Money UI.';
