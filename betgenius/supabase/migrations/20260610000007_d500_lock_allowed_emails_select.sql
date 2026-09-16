-- D-500 SHIP 2 (2026-06-10) — Lock down allowed_emails SELECT.
--
-- WHAT: drops the wide-open `allowed_emails_select_all` policy (cmd=r,
-- roles=- (all), using=true) and replaces it with an admin-only SELECT
-- policy mirroring the existing 3 admin write policies (INSERT/UPDATE/
-- DELETE — all already gated by `is_admin()`).
--
-- WHY: the wide-open SELECT meant any holder of the public anon key
-- (which ships in the frontend bundle by design) could read the entire
-- allow-list. That's a user-email leak. D-500 closes the hole.
--
-- SIGN-IN STILL WORKS because the frontend was rerouted FIRST (in a
-- prior commit + deploy this batch) to call the `check-email-allowed`
-- edge function instead of reading the table directly. The edge fn uses
-- the service-role key server-side, which bypasses RLS, and returns
-- ONLY a boolean (never the row).
--
-- ADMIN MANAGEMENT (src/pages/Admin.tsx) STILL WORKS because Admin
-- carries `Authorization: Bearer <session.access_token>` for the
-- single admin (admin@example.com per is_admin()). The new
-- admin SELECT policy admits exactly that JWT.
--
-- ROLLBACK (if sign-in OR admin management breaks, this restores the
-- pre-D-500 state):
--   DROP POLICY IF EXISTS allowed_emails_select_admin ON public.allowed_emails;
--   CREATE POLICY allowed_emails_select_all ON public.allowed_emails
--     FOR SELECT
--     USING (true);
-- (Then sign-in goes back to reading the table directly — but the leak
-- is back too. Rollback is the abort path, not the steady state.)

-- 1. Drop the wide-open SELECT policy (idempotent via IF EXISTS)
DROP POLICY IF EXISTS allowed_emails_select_all ON public.allowed_emails;

-- 2. Add the admin-only SELECT policy
--    Mirrors `allowed_emails_update_admin` shape (role=authenticated,
--    USING=is_admin()) — same admin-set, same gate.
CREATE POLICY allowed_emails_select_admin ON public.allowed_emails
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- 3. Sanity check inside the migration: verify the new policy is in
--    place and the old one is gone. Aborts the transaction (rolling
--    back the policy drop) if anything is off.
DO $$
DECLARE
  v_old_count INTEGER;
  v_new_count INTEGER;
BEGIN
  SELECT count(*) INTO v_old_count FROM pg_policy
   WHERE polrelid = 'public.allowed_emails'::regclass
     AND polname = 'allowed_emails_select_all';
  SELECT count(*) INTO v_new_count FROM pg_policy
   WHERE polrelid = 'public.allowed_emails'::regclass
     AND polname = 'allowed_emails_select_admin';

  IF v_old_count <> 0 THEN
    RAISE EXCEPTION '[D-500] post-state check failed — allowed_emails_select_all still present (count=%)', v_old_count;
  END IF;
  IF v_new_count <> 1 THEN
    RAISE EXCEPTION '[D-500] post-state check failed — allowed_emails_select_admin not created (count=%)', v_new_count;
  END IF;

  RAISE NOTICE '[D-500] SELECT policy swap clean: wide-open dropped, admin-only added';
END $$;
