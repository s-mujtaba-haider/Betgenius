-- D-272-INF-5 #4 (2026-05-20) — Align algorithm_weights RLS policy.
--
-- D-239 noted ambiguity: spec said "admin-only" but live usage shows
-- frontend (Admin.tsx:1885) reads algorithm_weights via authed REST.
-- Decision: authed read + service-role write. Admin.tsx already
-- requires authed session; the read is safe to expose. Writes remain
-- gated to service_role / postgres (the apply RPC inside run-optimizer-v2).
--
-- This migration is idempotent: drops + recreates the canonical
-- policies. No-op if state already matches.
--
-- Rollback:
--   DROP POLICY IF EXISTS algorithm_weights_authed_read ON public.algorithm_weights;
--   DROP POLICY IF EXISTS algorithm_weights_service_write ON public.algorithm_weights;

ALTER TABLE public.algorithm_weights ENABLE ROW LEVEL SECURITY;

-- Authed read (Admin.tsx reads this)
DROP POLICY IF EXISTS algorithm_weights_authed_read ON public.algorithm_weights;
CREATE POLICY algorithm_weights_authed_read
  ON public.algorithm_weights
  FOR SELECT
  TO authenticated
  USING (true);

-- Service role full access (apply RPC + observability)
DROP POLICY IF EXISTS algorithm_weights_service_all ON public.algorithm_weights;
CREATE POLICY algorithm_weights_service_all
  ON public.algorithm_weights
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Explicit denial of anon SELECT (in case prior policy granted it)
DROP POLICY IF EXISTS algorithm_weights_anon_read ON public.algorithm_weights;

COMMENT ON TABLE public.algorithm_weights IS
  'D-272-INF-5 #4: RLS aligned 2026-05-20. authenticated SELECT '
  '(Admin.tsx UI), service_role ALL (run-optimizer-v2 apply RPC). '
  'anon explicitly NOT granted SELECT.';
