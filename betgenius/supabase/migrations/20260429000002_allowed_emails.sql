-- ============================================================================
-- Migration: allowed_emails (auth allowlist foundation)
-- Created : 2026-04-29
-- Purpose : Email-allowlist table backing the Supabase magic-link auth flow.
--           Only emails present in this table can request a sign-in link.
--           Seeded with the CEO's email so the first sign-up is possible.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING.
--             Safe to re-run.
--
-- Cardinal Rule #4 documentation:
--   What     : 1) CREATE TABLE allowed_emails (email PK, added_by, added_at,
--                 notes).
--              2) Seed CEO email so initial auth flow can succeed.
--
--   Why      : Foundation for friends-stress-test in 3-4 days, then paid
--              subscriber launch later. Without an allowlist, anyone with
--              the URL could sign up. Magic-link auth + allowlist = invite-
--              only without us building a full membership system yet.
--
--   When     : 2026-04-29, applied via supabase db push.
--
--   Impact   : New table, ~1 row seeded. Zero impact on any existing
--              read/write surface. AuthGate component (shipped in same
--              commit) is the only consumer. RLS NOT enabled on this
--              table this session — anon read is OK because the only
--              info exposed is "is this email allowed", which the auth
--              flow needs to check pre-magic-link. Tomorrow's RLS session
--              will lock down per-user row visibility on bets / pick_history
--              and revisit allowed_emails policy.
--
--   Rollback : DROP TABLE IF EXISTS public.allowed_emails;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.allowed_emails (
  email     TEXT PRIMARY KEY CHECK (email = lower(email)),
  added_by  TEXT,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes     TEXT
);

COMMENT ON TABLE public.allowed_emails IS
  'Auth allowlist. Email must be in this table to request a magic-link '
  'sign-in. Maintained from Admin > Manage Allowed Emails. PK enforces '
  'lowercase uniqueness via CHECK. RLS will be added in the upcoming '
  'lockdown session (Apr 30).';

-- Seed: CEO. Replace `admin@example.com` if the CEO email differs;
-- the upsert is idempotent so re-running with a different email is safe
-- (it adds rather than replaces).
INSERT INTO public.allowed_emails (email, added_by, notes)
VALUES ('admin@example.com', 'system-seed', 'CEO — initial seed (Apr 29)')
ON CONFLICT (email) DO NOTHING;
