-- D-644 — Fix real_money_bets timeout.
-- ────────────────────────────────────────────────────────────────────
-- ROOT CAUSE (EXPLAIN plan captured 2026-06-20 via d644_explain_plan_only):
--
--   Merge Join (cost=28,610..30,297 rows=1 width=70)
--     Merge Cond: (lower(p.player_name)=bn.norm_name) AND ...
--     ->  Sort  (cost=28,554..28,739 rows=74,149 width=91)
--           Sort Key: line, (lower(player_name)), (lower(prop_type)),
--                     (lower(pick_side)), sport
--           ->  Index Scan using idx_pick_history_game_date on pick_history
--                 Index Cond: (game_date IS NOT NULL)
--
-- The view's ranked_matches CTE sorts ALL 74,161 pick_history rows by
-- five lower(...)-computed keys on EVERY query, even though:
--   (a) 787 of 826 bets already have bets.pick_id populated by the
--       D-021 trigger and the pinned_picks CTE resolves them in O(1)
--       via pick_history_pkey index scan. Only 39 bets need the
--       ranked_matches natural-key resolver.
--   (b) No index covers (lower(player_name), lower(prop_type),
--       lower(pick_side), line, sport, game_date) → the planner has
--       to compute lower() on every row and sort.
--
-- Result: 60s+ statement timeout. Browser sees 500 / 57014.
-- D-623/D-624 added a placed_at>=48h probe filter so the PROBE no
-- longer times out, but the VIEW under the Performance.tsx query
-- (user_id=eq.<uid>&order=placed_at.desc&limit=1000) was never fixed.
--
-- TWO-PRONGED FIX:
--   1. Functional index on pick_history covering the JOIN keys (the
--      load-bearing change — eliminates the sort).
--   2. CTE filter: ranked_matches only runs for bets WITHOUT a
--      pinned pick_id (defense-in-depth: 787/826 = 95% of bets
--      skip the natural-key path entirely).
--
-- Output shape of the view is BIT-IDENTICAL (same 22 columns, same
-- order, same types, same names) so CREATE OR REPLACE VIEW succeeds.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.idx_ph_rmb_join;
--   (re-apply 20260514000013_d144_real_money_bets_coalesce.sql to
--    restore the pre-D-644 ranked_matches CTE without the WHERE.)

-- ── §1. Functional index covering the natural-key JOIN ──────────────
-- Covers the merge join's five keys plus game_date (used in the ±1d
-- date filter on the JOIN). Partial index restricts to rows with a
-- known game_date (matches the existing JOIN condition).
CREATE INDEX IF NOT EXISTS idx_ph_rmb_join
  ON public.pick_history (
    lower(player_name),
    lower(prop_type),
    lower(pick_side),
    line,
    sport,
    game_date
  )
  WHERE game_date IS NOT NULL;

ANALYZE public.pick_history;

-- ── §2. View rewrite — add the pinned_pick_id IS NULL filter ────────
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
    b.pick_id                                    AS pinned_pick_id,
    to_char((b.placed_at AT TIME ZONE 'America/New_York')::date,
            'YYYYMMDD')                          AS bet_game_date_et,
    lower(b.player_name)                         AS norm_name,
    lower(b.prop_type)                           AS norm_prop,
    lower(b.pick_side)                           AS norm_side
  FROM public.bets b
),
pinned_picks AS (
  SELECT
    bn.bet_id                                    AS bet_id,
    p.id                                         AS pinned_id,
    p.source                                     AS pinned_source,
    p.confidence                                 AS pinned_confidence,
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
   AND ABS(p.game_date - to_date(bn.bet_game_date_et, 'YYYYMMDD')) <= 1
   AND p.sport              = bn.sport
  -- D-644 ─ skip the expensive natural-key join for bets already
  -- pinned via bets.pick_id. The pinned_picks CTE resolves them via
  -- pick_history_pkey (O(1)). 787 of 826 bets (95%) are pinned.
  WHERE bn.pinned_pick_id IS NULL
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
  COALESCE(pp.pinned_id,         rm.matched_pick_id)         AS matched_pick_id,
  COALESCE(pp.pinned_source,     rm.matched_pick_source)     AS matched_pick_source,
  COALESCE(pp.pinned_confidence, rm.matched_pick_confidence) AS matched_pick_confidence,
  COALESCE(pp.pinned_game_date,  rm.matched_pick_game_date)  AS matched_pick_game_date,
  COALESCE(pp.pinned_created_at, rm.matched_pick_created_at) AS matched_pick_created_at,
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
  'D-144 (May 13, 2026): bets.pick_id is canonical when non-null (pinned_picks '
  'CTE LEFT JOIN), falling back to natural-key resolver only when bets.pick_id '
  'IS NULL. D-644 (June 20, 2026): ranked_matches CTE now WHERE-filtered to '
  'bets without a pinned pick_id (95% of bets skip the expensive natural-key '
  'JOIN). Companion functional index idx_ph_rmb_join covers the JOIN keys, '
  'eliminating the 74K-row sort that caused 60s+ timeouts. is_matched flags '
  'rows where either path resolved.';
