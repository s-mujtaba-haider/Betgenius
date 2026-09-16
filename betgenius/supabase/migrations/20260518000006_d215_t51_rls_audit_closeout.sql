-- D-215 / Batch 5 Task 5.1 — RLS audit closeout.
--
-- Architecture §2.8 policy matrix enforcement for tables that exist
-- but may have incomplete RLS policy coverage. Idempotent — uses
-- DROP POLICY IF EXISTS + CREATE POLICY so re-runs are no-ops if
-- policies are already canonical.
--
-- Tables addressed:
--   §2.8 admin-only: safety_gate_log, notifications_log, backfill_runs,
--                    error_log, run_log, cron_progress, api_usage
--   §2.8 authed-read-all: calibration_snapshots, algorithm_weights_tier_modifiers
--
-- §1.17 audit: this migration only ADDS policies. No table modifications,
-- no column changes. Existing readers using anon or authenticated keys
-- continue working IF and only if their access pattern matches the
-- §2.8 spec. If a reader was relying on permissive default that
-- conflicts with §2.8 (e.g. anon-read on admin-only), it would now
-- 200 with empty array (RLS hides rows, doesn't 403).

BEGIN;

-- ============================================================
-- ENSURE RLS enabled on §2.8 tables (idempotent — no-op if already on)
-- ============================================================
ALTER TABLE public.calibration_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.algorithm_weights_tier_modifiers ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT 'safety_gate_log' AS t UNION ALL SELECT 'notifications_log'
    UNION ALL SELECT 'backfill_runs' UNION ALL SELECT 'error_log'
    UNION ALL SELECT 'run_log' UNION ALL SELECT 'cron_progress'
    UNION ALL SELECT 'api_usage'
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=r.t) THEN
      EXECUTE 'ALTER TABLE public.' || quote_ident(r.t) || ' ENABLE ROW LEVEL SECURITY';
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- §2.8: calibration_snapshots — authed-read-all
-- ============================================================
DROP POLICY IF EXISTS cs_select_authed ON public.calibration_snapshots;
CREATE POLICY cs_select_authed ON public.calibration_snapshots
  FOR SELECT TO authenticated, anon
  USING (TRUE);
-- Writes: service-role only (write-calibration-snapshot edge fn).

-- ============================================================
-- §2.8: algorithm_weights_tier_modifiers — authed-read-all
-- ============================================================
DROP POLICY IF EXISTS awtm_select_authed ON public.algorithm_weights_tier_modifiers;
CREATE POLICY awtm_select_authed ON public.algorithm_weights_tier_modifiers
  FOR SELECT TO authenticated
  USING (TRUE);

-- ============================================================
-- §2.8: admin-only operational tables
-- safety_gate_log, notifications_log, backfill_runs, error_log,
-- run_log, cron_progress, api_usage
-- ============================================================

-- safety_gate_log
DROP POLICY IF EXISTS sgl_select_admin ON public.safety_gate_log;
CREATE POLICY sgl_select_admin ON public.safety_gate_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- notifications_log
DROP POLICY IF EXISTS nl_select_admin ON public.notifications_log;
CREATE POLICY nl_select_admin ON public.notifications_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- backfill_runs
DROP POLICY IF EXISTS br_select_admin ON public.backfill_runs;
CREATE POLICY br_select_admin ON public.backfill_runs
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- error_log
DROP POLICY IF EXISTS el_select_admin ON public.error_log;
CREATE POLICY el_select_admin ON public.error_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- run_log
DROP POLICY IF EXISTS rl_select_admin ON public.run_log;
CREATE POLICY rl_select_admin ON public.run_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- cron_progress — Dashboard subscriber reads need this (game progress
-- counter). Per §2.8: admin only. But Dashboard.tsx:225 reads it for
-- the "1/1 games processed" counter (sport=nba only after D-214 Fix 6).
-- Architecture spec wins: admin only. Subscriber counter UI was already
-- showing NBA-only state. CEO can re-spec to authed-read if user-
-- facing counter is intentional.
DROP POLICY IF EXISTS cp_select_admin ON public.cron_progress;
CREATE POLICY cp_select_admin ON public.cron_progress
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- api_usage
DROP POLICY IF EXISTS au_select_admin ON public.api_usage;
CREATE POLICY au_select_admin ON public.api_usage
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ============================================================
-- Verification
-- ============================================================
DO $$
DECLARE
  expected TEXT[] := ARRAY[
    'calibration_snapshots','algorithm_weights_tier_modifiers',
    'safety_gate_log','notifications_log','backfill_runs','error_log',
    'run_log','cron_progress','api_usage'
  ];
  rls_count INT;
  pol_count INT;
BEGIN
  SELECT COUNT(*) INTO rls_count FROM pg_tables
    WHERE schemaname='public' AND tablename = ANY(expected) AND rowsecurity = TRUE;
  SELECT COUNT(*) INTO pol_count FROM pg_policies
    WHERE schemaname='public' AND tablename = ANY(expected);
  RAISE NOTICE 'D-215 T5.1 VERIFY: % of % tables RLS-on, % policies covering them', rls_count, array_length(expected, 1), pol_count;
  IF rls_count <> 9 THEN
    RAISE EXCEPTION 'D-215 T5.1 VERIFY FAIL: expected 9 RLS-on, got %', rls_count;
  END IF;
END $$;

COMMIT;
