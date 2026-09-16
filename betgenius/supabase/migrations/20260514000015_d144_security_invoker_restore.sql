-- D-144 HOTFIX — restore security_invoker = true on real_money_bets view.
-- =============================================================================
-- INCIDENT: D-144 view CREATE OR REPLACE (migration 20260514000013) reset
-- the `security_invoker = true` property that migration 20260429000003 set
-- explicitly. CREATE OR REPLACE VIEW does NOT preserve view options like
-- security_invoker — Postgres resets to the default (security_definer)
-- when the view is re-created.
--
-- IMPACT: Anon-key + anon-bearer PostgREST GET to /rest/v1/real_money_bets
-- returned a row immediately post-D-144 ship, confirming the view was
-- bypassing per-user RLS on the underlying bets table. Pre-D-144 the same
-- request returned empty (RLS-blocked).
--
-- DURATION: D-144 applied at ~2026-05-14T00:1X UTC. Hotfix applied within
-- minutes. Friends-Friday stress test has NOT started; CEO is sole user.
-- No multi-tenant leakage in practice — but the security property must be
-- restored before any subscriber-launch scenario.
--
-- ROOT CAUSE: D-144 missed reading migration 20260429000003 step 12
-- ("real_money_bets view — explicit security_invoker") before doing the
-- CREATE OR REPLACE. The security_invoker property is not visible in
-- pg_views output by default; only in pg_class.reloptions.
--
-- =============================================================================
-- LESSON FOR FUTURE VIEW CHANGES (framework v2.39 candidate addition):
-- Any CREATE OR REPLACE VIEW must be paired with explicit ALTER VIEW
-- restoration of: (a) security_invoker, (b) any RLS-adjacent property,
-- (c) GRANT statements if the view had explicit privilege grants. Postgres
-- does NOT preserve these across CREATE OR REPLACE.
-- =============================================================================

ALTER VIEW public.real_money_bets SET (security_invoker = true);

COMMENT ON VIEW public.real_money_bets IS
  'C17 Real Money: every bet joined to its most-relevant pick_history row. '
  'D-144 (May 13, 2026): bets.pick_id is canonical when non-null '
  '(pinned_picks CTE LEFT JOIN), falling back to natural-key resolver '
  '(player/prop/side/line ±1 day ET, within-sport) only when bets.pick_id '
  'IS NULL. security_invoker = true (restored post-D-144 hotfix, migration '
  '20260514000015) — view evaluates RLS as calling user, NOT as owner. '
  'Tiebreak in fallback: process-games > dashboard > evaluator, then '
  'highest confidence, then most recent created_at. is_matched flags rows '
  'where either path resolved. Read-only; powers the Performance Real-Money '
  'UI. Closes D-132 Group B open follow-up.';
