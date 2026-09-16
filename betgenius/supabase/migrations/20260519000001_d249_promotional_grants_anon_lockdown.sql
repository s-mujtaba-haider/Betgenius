-- D-249 (2026-05-19) — promotional_grants anon enumeration lockdown.
--
-- Context: D-253 Task G surfaced that the existing pg_select_by_invite_code
-- policy at 20260518000004:promotional_grants permits anon SELECT for any
-- row WHERE invite_code IS NOT NULL AND status IN ('available','reserved').
-- This is row-by-row permissive — anon callers can dump every unredeemed
-- closed-beta invite code via:
--   GET /rest/v1/promotional_grants?select=invite_code,grant_type,status
--
-- The original policy intent was to let /beta-access?invite=CODE pre-validate
-- the code before signup. But:
--   1. The frontend captures `?invite=CODE` into sessionStorage and does NOT
--      validate via REST (verified via grep across src/). Validation happens
--      server-side in stripe-webhook with service-role key.
--   2. promotional_grants stripe-webhook write at stripe-webhook/index.ts:124
--      uses service-role key (no RLS gating).
--   3. The 50 closed-beta codes seeded in 20260518000004 are meant to be
--      private; enumeration via anon REST defeats the purpose.
--
-- This migration: drop the anon SELECT policy. authenticated SELECT of own
-- row (pg_select_own) remains in place. Service-role retains full access by
-- bypassing RLS. Admin gets full access via the is_admin() helper at
-- 20260429000003.
--
-- Rollback (if needed for any reason):
--   CREATE POLICY pg_select_by_invite_code ON public.promotional_grants
--     FOR SELECT TO anon
--     USING (invite_code IS NOT NULL AND status IN ('available','reserved'));

BEGIN;

DROP POLICY IF EXISTS pg_select_by_invite_code ON public.promotional_grants;

-- Verification block: confirm anon SELECT is now denied + authenticated
-- own-row SELECT is preserved.
DO $$
DECLARE
  anon_policy_count INT;
  authed_policy_count INT;
BEGIN
  SELECT COUNT(*) INTO anon_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'promotional_grants'
      AND 'anon' = ANY(roles);

  SELECT COUNT(*) INTO authed_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'promotional_grants'
      AND 'authenticated' = ANY(roles)
      AND cmd = 'SELECT';

  IF anon_policy_count > 0 THEN
    RAISE EXCEPTION 'D-249 verify FAILED: anon policy(ies) still exist on promotional_grants (count=%)', anon_policy_count;
  END IF;

  IF authed_policy_count = 0 THEN
    RAISE EXCEPTION 'D-249 verify FAILED: no authenticated SELECT policy on promotional_grants — would lock subscribers out of their own invite redemption status';
  END IF;

  RAISE NOTICE 'D-249 OK — anon SELECT policies on promotional_grants: %, authenticated SELECT policies preserved: %', anon_policy_count, authed_policy_count;
END $$;

COMMIT;
