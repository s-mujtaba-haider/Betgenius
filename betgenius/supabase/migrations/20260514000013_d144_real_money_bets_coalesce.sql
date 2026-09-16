-- D-144 real_money_bets COALESCE fix.
-- CEO §19.3 approved in principle May 13, 2026.
--
-- After D-132 (May 12) transactionally linked 11 orphan bets to organic
-- pick_history rows via bets.pick_id, the view's independent natural-key
-- resolver was still picking synthetic rows over organic for Group B's
-- 3 bets. The view ignored bets.pick_id entirely — recomputed the match
-- on every read. Performance UI consequently showed synthetic confidence
-- for those 3 bets despite bets.pick_id correctly pointing organic.
--
-- This migration pins the view to bets.pick_id when non-null, falling
-- back to the natural-key resolver only when bets.pick_id IS NULL.
--
-- =============================================================================
-- SCOPE EXPANSION SURFACED INLINE (CEO §19.3 implied amendment)
--
-- The spec called for `COALESCE(bets.pick_id, <existing resolver>) AS
-- matched_pick_id` — a single-column fix. Reading the full view top-to-
-- bottom (per spec STEP 2 "What if the resolver is doing MORE than picking
-- an id? Read the full view to confirm") revealed the natural-key resolver
-- pulls FIVE fields from the same ranked_matches CTE:
--   - matched_pick_id          (p.id)
--   - matched_pick_source      (p.source — 'process-games' vs 'backfill')
--   - matched_pick_confidence  (p.confidence)
--   - matched_pick_game_date   (p.game_date)
--   - matched_pick_created_at  (p.created_at)
--
-- COALESCing ONLY matched_pick_id would create cross-source data
-- inconsistency on Group B's 3 bets: id would point organic
-- (bets.pick_id) but source/confidence/game_date/created_at would still
-- come from the synthetic ranked-matches row. Performance UI would show
-- "process-games" pick_id with synthetic confidence number — strictly
-- WORSE than current state.
--
-- Correct fix: a new pinned_picks CTE that JOINs pick_history on
-- bets.pick_id, then COALESCE on all 5 fields. Pin all-or-nothing.
-- Surgical: zero existing column re-order, zero JOIN reorder, zero
-- filter change, zero new view output column. Only additive structure
-- (one new internal field in bets_normalized + one new CTE + one new
-- LEFT JOIN + 5 COALESCE expressions in the existing SELECT).
--
-- Output shape of the view is BIT-IDENTICAL to the pre-fix version:
-- same 22 columns in the same order with the same types and the same
-- names. Postgres' "CREATE OR REPLACE VIEW only allows APPENDING
-- columns" rule is respected.
--
-- =============================================================================
-- REFERENTIAL INTEGRITY NOTE
--
-- bets has NO foreign key on pick_id → pick_history.id (migration
-- 20260428000001 dropped the legacy FK on bets.pick_id → picks(id) and
-- did NOT add a new FK to pick_history.id; pick_id is a "soft reference"
-- per that migration's comments). Empirical referential-integrity check
-- (SELECT COUNT(*) FROM bets WHERE pick_id IS NOT NULL AND NOT EXISTS
-- (SELECT 1 FROM pick_history WHERE id=bets.pick_id)) could NOT be run
-- from this session — RLS blocks anon-key reads on both tables, same
-- lockout as D-141/D-142. Trusting D-132's transactional row-count +
-- pre-COMMIT natural-key + prefer-organic assertions (framework v2.37):
-- the 11 D-132 UPDATEs all match pick_history rows. The pinned_picks
-- CTE JOIN is safe-by-design — if bets.pick_id points to a non-existent
-- row, pp.pinned_id is NULL and the COALESCE falls back to rm.matched_*.
-- No view-level breakage possible.
-- =============================================================================

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
    -- D-144: expose bets.pick_id as internal CTE field for pinned_picks JOIN.
    -- Not a view output column; only used inside CTE pipeline.
    b.pick_id                                    AS pinned_pick_id,
    to_char((b.placed_at AT TIME ZONE 'America/New_York')::date,
            'YYYYMMDD')                          AS bet_game_date_et,
    lower(b.player_name)                         AS norm_name,
    lower(b.prop_type)                           AS norm_prop,
    lower(b.pick_side)                           AS norm_side
  FROM public.bets b
),
-- D-144: pinned_picks CTE — pulls pick_history fields by bets.pick_id
-- when non-null. Becomes the canonical source for matched_pick_* fields
-- in the final SELECT via COALESCE. If bets.pick_id IS NULL, the CTE
-- produces no row for that bet and the COALESCE falls through to the
-- natural-key ranked_matches resolver below (existing behavior preserved).
pinned_picks AS (
  SELECT
    bn.bet_id                                    AS bet_id,
    p.id                                         AS pinned_id,
    p.source                                     AS pinned_source,
    p.confidence                                 AS pinned_confidence,
    -- D-144 type-match: existing view emits matched_pick_game_date as TEXT
    -- (calibration_input comment at migration 20260511000005 documents this
    -- explicitly). pick_history.game_date is DATE post-C33 Phase 2 (May 7).
    -- Cast to TEXT to satisfy CREATE OR REPLACE VIEW's column-type-match
    -- requirement (SQLSTATE 42P16 errors otherwise).
    p.game_date::text                            AS pinned_game_date,
    p.created_at                                 AS pinned_created_at
  FROM bets_normalized bn
  JOIN public.pick_history p ON p.id = bn.pinned_pick_id
  WHERE bn.pinned_pick_id IS NOT NULL
),
ranked_matches AS (
  SELECT
    bn.bet_id,
    p.id                                         AS matched_pick_id,
    p.source                                     AS matched_pick_source,
    p.confidence                                 AS matched_pick_confidence,
    -- D-144 type-match: same TEXT cast as pinned_picks CTE above.
    p.game_date::text                            AS matched_pick_game_date,
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
   -- D-144 cast fix: C33 Phase 2 (migration 20260507000002, May 7) migrated
   -- pick_history.game_date TEXT 'YYYYMMDD' → DATE. The pre-D-144 view
   -- (migration 20260429000001) had `ABS(p.game_date::int - bn.bet_game_date_et::int)`
   -- which would fail to re-parse against the current schema (SQLSTATE
   -- 42846 "cannot cast type date to integer"). Existing view continues
   -- running in prod via Postgres' cached parse tree from when game_date
   -- was TEXT. D-144's CREATE OR REPLACE re-parses against current schema
   -- and must use DATE arithmetic: DATE - DATE returns INTEGER days in
   -- Postgres. Semantically identical to the original ±1 day check.
   AND ABS(p.game_date - to_date(bn.bet_game_date_et, 'YYYYMMDD')) <= 1
   AND p.sport              = bn.sport
)
-- Column order is fixed by the previous CREATE VIEW (migration
-- 20260427000001 + 20260429000001 appended `sport`). Postgres'
-- CREATE OR REPLACE VIEW only allows APPENDING columns. D-144
-- preserves the existing 22-column shape bit-identically; only the
-- 5 matched_pick_* expressions and is_matched expression change
-- behind the same column names.
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
  -- D-144: COALESCE pinned (bets.pick_id) over natural-key resolver.
  -- When bets.pick_id is non-null AND the row exists in pick_history,
  -- pp.* wins. Otherwise rm.* (the existing tiebreak-ranked resolver).
  COALESCE(pp.pinned_id,         rm.matched_pick_id)         AS matched_pick_id,
  COALESCE(pp.pinned_source,     rm.matched_pick_source)     AS matched_pick_source,
  COALESCE(pp.pinned_confidence, rm.matched_pick_confidence) AS matched_pick_confidence,
  COALESCE(pp.pinned_game_date,  rm.matched_pick_game_date)  AS matched_pick_game_date,
  COALESCE(pp.pinned_created_at, rm.matched_pick_created_at) AS matched_pick_created_at,
  -- D-144: is_matched now reflects EITHER pinned-pick OR natural-key match.
  -- TRUE when at least one path resolves to a pick_history row.
  (COALESCE(pp.pinned_id, rm.matched_pick_id) IS NOT NULL)   AS is_matched,
  bn.sport
FROM bets_normalized bn
LEFT JOIN pinned_picks pp
  ON pp.bet_id = bn.bet_id
LEFT JOIN ranked_matches rm
  ON rm.bet_id = bn.bet_id
 AND rm.rn     = 1;

COMMENT ON VIEW public.real_money_bets IS
  'C17 Real Money: every bet joined to its most-relevant pick_history row. '
  'D-144 (May 13, 2026): bets.pick_id is canonical when non-null '
  '(pinned_picks CTE LEFT JOIN), falling back to natural-key resolver '
  '(player/prop/side/line ±1 day ET, within-sport) only when bets.pick_id '
  'IS NULL. Tiebreak in fallback: process-games > dashboard > evaluator, '
  'then highest confidence, then most recent created_at. is_matched flags '
  'rows where either path resolved. Read-only; powers the Performance '
  'Real-Money UI. Closes D-132 Group B open follow-up (3 bets that showed '
  'synthetic confidence despite bets.pick_id pointing organic).';
