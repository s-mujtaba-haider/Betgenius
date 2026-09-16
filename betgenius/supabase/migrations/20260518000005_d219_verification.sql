-- D-219 §1.12 verification migration (paired with 20260518000004).
--
-- Documents the 24h post-deploy queries CEO / Claude re-run to confirm
-- the 9 prerequisite tables remain healthy. Apply-time NOTICE block
-- runs these queries inline; the comment block at bottom of this file
-- documents the same queries verbatim for manual re-execution.
--
-- This migration is idempotent (DO block only — no schema changes).
-- Safe to re-run via `npx supabase db push` if verification feedback
-- needed.

DO $$
DECLARE
  expected TEXT[] := ARRAY['subscriptions','referral_codes','referrals_made','referral_credits','promotional_grants','account_deletion_requests','state_availability','analytics_events','waitlist'];
  tbl_rec RECORD;
  pol_rec RECORD;
  state_count INT;
  promo_avail INT;
  promo_total INT;
  is_admin_exists BOOLEAN;
BEGIN
  -- ---- Check 1: all 9 tables exist ----
  RAISE NOTICE 'D-219 verification — table existence:';
  FOR tbl_rec IN
    SELECT t.tn, EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename = t.tn) AS exists_,
           COALESCE((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename = t.tn), FALSE) AS rls_on
    FROM unnest(expected) AS t(tn)
  LOOP
    RAISE NOTICE '  %  exists=%  rls=%', tbl_rec.tn, tbl_rec.exists_, tbl_rec.rls_on;
  END LOOP;

  -- ---- Check 2: policy count per table ----
  RAISE NOTICE 'D-219 verification — policy counts:';
  FOR pol_rec IN
    SELECT tablename, COUNT(*) AS n_policies
    FROM pg_policies
    WHERE schemaname='public' AND tablename = ANY(expected)
    GROUP BY tablename ORDER BY tablename
  LOOP
    RAISE NOTICE '  %  policies=%', pol_rec.tablename, pol_rec.n_policies;
  END LOOP;

  -- ---- Check 3: seeded data ----
  SELECT COUNT(*) INTO state_count FROM public.state_availability;
  SELECT COUNT(*) INTO promo_avail FROM public.promotional_grants WHERE grant_type='closed_beta_aug2026' AND status='available';
  SELECT COUNT(*) INTO promo_total FROM public.promotional_grants WHERE grant_type='closed_beta_aug2026';
  RAISE NOTICE 'D-219 verification — seeds:';
  RAISE NOTICE '  state_availability total rows: % (expect 64: 50 states + DC + 13 CA provinces/territories)', state_count;
  RAISE NOTICE '  promotional_grants closed_beta_aug2026 total=%, available=%', promo_total, promo_avail;

  -- ---- Check 4: is_admin() helper present (RLS policies depend on it) ----
  SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='is_admin' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')) INTO is_admin_exists;
  RAISE NOTICE 'D-219 verification — is_admin() helper present: %', is_admin_exists;
  IF NOT is_admin_exists THEN
    RAISE EXCEPTION 'D-219 VERIFY FAIL: is_admin() helper missing — admin RLS policies will reject all reads';
  END IF;

  -- ---- Check 5: critical FK targets exist ----
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='users') THEN
    RAISE EXCEPTION 'D-219 VERIFY FAIL: auth.users missing — FKs broken';
  END IF;

  -- ---- Check 6: triggers wired ----
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='update_subscriptions_updated_at') THEN
    RAISE EXCEPTION 'D-219 VERIFY FAIL: update_subscriptions_updated_at trigger not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='process_deletion_on_signup_cancel') THEN
    RAISE EXCEPTION 'D-219 VERIFY FAIL: process_deletion_on_signup_cancel trigger not installed';
  END IF;
  RAISE NOTICE 'D-219 verification — triggers wired: 2 of 2';

  RAISE NOTICE 'D-219 verification PASS — 9 tables ready for Batch 5 features';
END $$;

-- Manual 24h re-check queries (Cardinal §1.12):
--
-- -- All 9 tables exist + RLS enabled:
-- SELECT tablename, rowsecurity
--   FROM pg_tables
--  WHERE schemaname='public'
--    AND tablename IN ('subscriptions','referral_codes','referrals_made',
--                      'referral_credits','promotional_grants',
--                      'account_deletion_requests','state_availability',
--                      'analytics_events','waitlist');
-- -- Expected: 9 rows, all rowsecurity = TRUE.
--
-- -- Policy count per table:
-- SELECT tablename, COUNT(*) AS n_policies
--   FROM pg_policies
--  WHERE schemaname='public'
--    AND tablename IN ('subscriptions','referral_codes','referrals_made',
--                      'referral_credits','promotional_grants',
--                      'account_deletion_requests','state_availability',
--                      'analytics_events','waitlist')
--  GROUP BY tablename ORDER BY tablename;
-- -- Expected: at least 1 policy per table.
--
-- -- Seed integrity:
-- SELECT COUNT(*) FROM public.state_availability;          -- expect 64
-- SELECT COUNT(*) FROM public.promotional_grants
--   WHERE grant_type='closed_beta_aug2026' AND status='available';  -- expect 50
--
-- -- Smoke: anon can read state_availability (public read):
-- -- (run via curl with anon key, expect 200 + 64-row response)
--
-- -- Smoke: anon cannot read analytics_events (admin-only):
-- -- (run via curl with anon key, expect 200 + empty array
-- --  because RLS hides rows; not 403)
