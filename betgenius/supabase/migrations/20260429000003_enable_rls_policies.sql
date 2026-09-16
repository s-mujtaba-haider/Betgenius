-- ============================================================================
-- Migration: enable_rls_policies (security lockdown before friends invitations)
-- Created : 2026-04-29
-- Purpose : Enable Row Level Security across every user-facing table and
--           define policies so that:
--             - Each user only reads/writes their own bets.
--             - Algorithm-output tables (pick_history, recommendations_cache,
--               props_cache) are readable by any authenticated user.
--             - Operational tables (algorithm_weights, cron_progress,
--               api_usage, error_log, run_log) are readable by admins only.
--             - allowed_emails is readable by anon (AuthGate needs to check
--               the allowlist BEFORE sending the magic link, which happens
--               pre-auth) and writable by admins only.
--           Service role bypasses RLS automatically (Supabase default), so
--           every edge function (process-games, fetch-odds, resolve-picks,
--           etc.) keeps working unchanged.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE POLICY; ENABLE RLS is
--             a no-op if already on. Safe to re-run.
--
-- Cardinal Rule #4 documentation:
--   What     : 1) CREATE FUNCTION public.is_admin() — STABLE SQL helper
--                 returning TRUE when the calling JWT's email is in the
--                 ADMIN_EMAILS list. Keeps the admin set in DB-resident
--                 SQL (today: admin@example.com only); a future
--                 migration can move this to a column.
--              2) ALTER TABLE ... ENABLE ROW LEVEL SECURITY on 10 tables.
--              3) CREATE POLICY ... per the rules above.
--              4) ALTER VIEW public.real_money_bets SET (security_invoker =
--                 true) so the view evaluates RLS as the calling user (NOT
--                 as the view owner — that would defeat per-user isolation).
--
--   Why      : Auth shipped Apr 29 with allowlist gating, but RLS is OFF on
--              every user-facing table. Any signed-in user can read every
--              other user's bets via direct PostgREST. Friends stress test
--              starts in 1-3 days. Without RLS, isolation is a fiction.
--              §15.2 RLS-policies-on-user-data-tables flagged URGENT.
--
--   When     : 2026-04-29, applied via supabase db push immediately AFTER
--              this commit (which also lands frontend session-JWT header
--              fixes — without those, the app breaks the moment RLS turns
--              on, because Performance/Games/Admin currently send anon as
--              the Authorization Bearer for raw /rest/v1 fetches).
--
--   Impact   : - 10 tables protected by RLS. 11 policies created. 1
--                helper function. 1 view setting changed.
--              - Edge functions (service_role) untouched — they bypass RLS.
--              - Frontend reads: Dashboard / Settings via supabase-js client
--                already attach session JWT automatically. Performance /
--                Games / Admin (raw fetch) updated in the same commit to
--                source Authorization from session.access_token.
--              - allowed_emails kept readable to anon (intentional —
--                AuthGate runs pre-auth). Writes locked to admin.
--              - is_admin() returns FALSE for anon (auth.jwt() is null in
--                anon role), so admin-only tables are invisible to non-CEO.
--              - 690 historical bets all carry user_id = placeholder UUID
--                (00000000-0000-0000-0000-000000000001). Any signed-in user
--                will see ZERO of these in their Performance view. That
--                matches the §D-029 design intent: "Performance shows
--                whoever's signed in." If the CEO wants to inherit all 690,
--                a later migration can re-tag bets.user_id to the CEO's
--                auth UUID.
--
--   Rollback : -- Disable RLS on every table:
--              ALTER TABLE public.bets                  DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.pick_history          DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.recommendations_cache DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.props_cache           DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.allowed_emails        DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.algorithm_weights     DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.cron_progress         DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.api_usage             DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.error_log             DISABLE ROW LEVEL SECURITY;
--              ALTER TABLE public.run_log               DISABLE ROW LEVEL SECURITY;
--              -- Drop policies (DROP POLICY IF EXISTS won't error on missing):
--              -- (any combination of "DROP POLICY <name> ON public.<table>")
--              -- Drop helper:
--              DROP FUNCTION IF EXISTS public.is_admin();
--              -- Restore view default:
--              ALTER VIEW public.real_money_bets SET (security_invoker = false);
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Helper: is_admin()
-- ----------------------------------------------------------------------------
-- Returns TRUE if the caller's JWT carries an email in the admin set. STABLE
-- so Postgres can cache the result within a query. SQL (not plpgsql) is
-- inlinable. Returns FALSE (not NULL) for anon, which simplifies USING
-- expressions — we don't have to write `coalesce(public.is_admin(), false)`
-- everywhere.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(
    (auth.jwt() ->> 'email') = 'admin@example.com',
    false
  );
$$;

COMMENT ON FUNCTION public.is_admin() IS
  'Returns true when the calling JWT email is in the admin set. Used by RLS '
  'policies on operational tables (algorithm_weights, cron_progress, etc.). '
  'TODO: replace hardcoded email with a column on allowed_emails or a '
  'user_profile table when the admin set grows beyond one.';

-- ----------------------------------------------------------------------------
-- 2) bets — per-user isolation
-- ----------------------------------------------------------------------------
ALTER TABLE public.bets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bets_select_own ON public.bets;
CREATE POLICY bets_select_own ON public.bets
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS bets_insert_own ON public.bets;
CREATE POLICY bets_insert_own ON public.bets
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS bets_update_own ON public.bets;
CREATE POLICY bets_update_own ON public.bets
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS bets_delete_own ON public.bets;
CREATE POLICY bets_delete_own ON public.bets
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3) pick_history — read-all to authenticated, write-only via service role
-- ----------------------------------------------------------------------------
ALTER TABLE public.pick_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pick_history_select_authed ON public.pick_history;
CREATE POLICY pick_history_select_authed ON public.pick_history
  FOR SELECT TO authenticated
  USING (true);

-- ----------------------------------------------------------------------------
-- 4) recommendations_cache — read-all to authenticated
-- ----------------------------------------------------------------------------
ALTER TABLE public.recommendations_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recommendations_cache_select_authed ON public.recommendations_cache;
CREATE POLICY recommendations_cache_select_authed ON public.recommendations_cache
  FOR SELECT TO authenticated
  USING (true);

-- ----------------------------------------------------------------------------
-- 5) props_cache — read-all to authenticated
-- ----------------------------------------------------------------------------
ALTER TABLE public.props_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS props_cache_select_authed ON public.props_cache;
CREATE POLICY props_cache_select_authed ON public.props_cache
  FOR SELECT TO authenticated
  USING (true);

-- ----------------------------------------------------------------------------
-- 6) allowed_emails — read-all (incl. anon for AuthGate), write only admin
-- ----------------------------------------------------------------------------
-- DELIBERATE DEVIATION FROM SPEC: the original spec said "SELECT only admins"
-- on allowed_emails. AuthGate.tsx checks the allowlist BEFORE sending the
-- magic link, which means before the user is authenticated — so the SELECT
-- has to work for anon. The information disclosure is bounded (it tells you
-- which emails are allowed; it doesn't expose any user data). The Apr 29
-- migration's docstring already justified anon SELECT for this exact reason.
-- Writes are locked to admin so non-admins can't add themselves.
ALTER TABLE public.allowed_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allowed_emails_select_all ON public.allowed_emails;
CREATE POLICY allowed_emails_select_all ON public.allowed_emails
  FOR SELECT
  USING (true);

DROP POLICY IF EXISTS allowed_emails_insert_admin ON public.allowed_emails;
CREATE POLICY allowed_emails_insert_admin ON public.allowed_emails
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS allowed_emails_update_admin ON public.allowed_emails;
CREATE POLICY allowed_emails_update_admin ON public.allowed_emails
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS allowed_emails_delete_admin ON public.allowed_emails;
CREATE POLICY allowed_emails_delete_admin ON public.allowed_emails
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 7) algorithm_weights — admin-only SELECT
-- ----------------------------------------------------------------------------
ALTER TABLE public.algorithm_weights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS algorithm_weights_select_admin ON public.algorithm_weights;
CREATE POLICY algorithm_weights_select_admin ON public.algorithm_weights
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 8) cron_progress — admin-only SELECT
-- ----------------------------------------------------------------------------
ALTER TABLE public.cron_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cron_progress_select_admin ON public.cron_progress;
CREATE POLICY cron_progress_select_admin ON public.cron_progress
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 9) api_usage — admin-only SELECT
-- ----------------------------------------------------------------------------
ALTER TABLE public.api_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_usage_select_admin ON public.api_usage;
CREATE POLICY api_usage_select_admin ON public.api_usage
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 10) error_log — admin-only SELECT
-- ----------------------------------------------------------------------------
ALTER TABLE public.error_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS error_log_select_admin ON public.error_log;
CREATE POLICY error_log_select_admin ON public.error_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 11) run_log — admin-only SELECT
-- ----------------------------------------------------------------------------
ALTER TABLE public.run_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_log_select_admin ON public.run_log;
CREATE POLICY run_log_select_admin ON public.run_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 12) real_money_bets view — explicit security_invoker
-- ----------------------------------------------------------------------------
-- A view defaults to running queries as the OWNER, which means RLS on the
-- underlying bets table would be evaluated against the view-owner's role
-- (typically a superuser-like role) — defeating per-user isolation. Setting
-- security_invoker = true makes the view evaluate RLS as the calling user.
ALTER VIEW public.real_money_bets SET (security_invoker = true);
