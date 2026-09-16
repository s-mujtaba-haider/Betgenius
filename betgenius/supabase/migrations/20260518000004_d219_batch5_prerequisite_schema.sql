-- D-219 — Batch 5 prerequisite schema.
--
-- 9 missing tables from architecture §2.3/§2.4 + §2.8 RLS policy matrix.
-- Single consolidated migration so dependencies (FKs) resolve cleanly.
--
-- Tables:
--   §2.3: subscriptions
--   §2.4: referral_codes, referrals_made, referral_credits,
--         promotional_grants, account_deletion_requests,
--         state_availability, analytics_events
--   (new in D-219): waitlist  (§1.1 landing waitlist CTA — arch
--                   doesn't spec schema; minimal email + ?ref capture)
--
-- §1.17 audit:
--   - All tables are NEW. No existing writers to update.
--   - subscriptions referenced by D-217 stripe-webhook (future), D-217
--     trial-ending email cron (future). Both Batch 5/6 work.
--   - referral_codes referenced by signup-flow (Task 5.2 future).
--   - state_availability referenced by Landing.tsx + signup geo gate
--     (Task 5.4 future).
--   - Per §1.17 protocol: no existing read/write paths touch these
--     tables yet; downstream code in Batch 5 will reference them.
--
-- is_admin() helper from D-029 (migration 20260429000003) used in
-- admin-only policies. Confirmed deployed.

BEGIN;

-- ============================================================
-- 1) subscriptions (§2.3)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id       TEXT NOT NULL,
  stripe_subscription_id   TEXT NOT NULL UNIQUE,
  status                   TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired')),
  plan_id                  TEXT NOT NULL CHECK (plan_id IN ('pro_beta_49','pro_monthly_99','pro_monthly_129','pro_monthly_149')),
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  trial_end                TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subs_user_status ON public.subscriptions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_status_period_end ON public.subscriptions (status, current_period_end) WHERE status IN ('trialing','active');
CREATE INDEX IF NOT EXISTS idx_subs_trial_end ON public.subscriptions (trial_end) WHERE trial_end IS NOT NULL AND status = 'trialing';
COMMENT ON TABLE public.subscriptions IS 'Stripe subscription state mirror. Arch §2.3. One active sub per user (UNIQUE user_id).';

-- updated_at trigger (arch §2.9)
CREATE OR REPLACE FUNCTION public.set_subscriptions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_subscriptions_updated_at();

-- ============================================================
-- 2) referral_codes (§2.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.referral_codes (
  code        TEXT PRIMARY KEY CHECK (code ~ '^SHARP-[A-Z0-9]{4,8}$'),
  user_id     UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON public.referral_codes (user_id);
COMMENT ON TABLE public.referral_codes IS 'Per-subscriber unique referral code (SHARP-XXXX format). Arch §2.4.';

-- ============================================================
-- 3) referrals_made (§2.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.referrals_made (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referred_user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  referral_code            TEXT NOT NULL REFERENCES public.referral_codes(code),
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed_up','paying','churned')),
  signed_up_at             TIMESTAMPTZ,
  paying_since             TIMESTAMPTZ,
  credit_dollars_earned    NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referrals_made_referrer_status ON public.referrals_made (referrer_user_id, status);
CREATE INDEX IF NOT EXISTS idx_referrals_made_referred ON public.referrals_made (referred_user_id) WHERE referred_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrals_made_code ON public.referrals_made (referral_code);
COMMENT ON TABLE public.referrals_made IS 'Tracks subscriber→friend conversions. Arch §2.4.';

-- ============================================================
-- 4) referral_credits (§2.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.referral_credits (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount              NUMERIC(10,2) NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('earned','applied','expired')),
  referral_id         UUID REFERENCES public.referrals_made(id) ON DELETE SET NULL,
  stripe_credit_id    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_referral_credits_user ON public.referral_credits (user_id, created_at DESC);
COMMENT ON TABLE public.referral_credits IS 'Subscriber earned-credit ledger. Arch §2.4.';

-- ============================================================
-- 5) promotional_grants (§2.4 + D-196 §14 Q7)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.promotional_grants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  grant_type    TEXT NOT NULL CHECK (grant_type IN ('closed_beta_aug2026','first_100_free_week','launch_promo','friend_invite')),
  granted_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  redeemed      BOOLEAN NOT NULL DEFAULT FALSE,
  invite_code   TEXT UNIQUE,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','granted','redeemed','expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_promo_grants_user ON public.promotional_grants (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_promo_grants_type_status ON public.promotional_grants (grant_type, status);
CREATE INDEX IF NOT EXISTS idx_promo_grants_invite_code ON public.promotional_grants (invite_code) WHERE invite_code IS NOT NULL;
COMMENT ON TABLE public.promotional_grants IS 'Promo + closed-beta invite tracking. Arch §2.4 + D-196 §14 Q7. status=available means slot unfilled.';

-- ============================================================
-- 6) account_deletion_requests (§2.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  user_id        UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_for  TIMESTAMPTZ NOT NULL,
  canceled       BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at    TIMESTAMPTZ,
  executed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_acct_del_scheduled ON public.account_deletion_requests (scheduled_for) WHERE canceled = FALSE AND executed_at IS NULL;
COMMENT ON TABLE public.account_deletion_requests IS 'Soft-delete with 30-day grace. Arch §2.4 + §2.9 trigger.';

-- process_deletion_on_signup_cancel trigger per §2.9 — placeholder
-- function that flips canceled=TRUE re-activates the sub if the user
-- comes back. Concrete subscription re-activation logic ships with
-- Batch 6 stripe-webhook work; v1 logs the event + clears canceled_at.
CREATE OR REPLACE FUNCTION public.process_deletion_on_signup_cancel()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- When canceled flips TRUE, stamp canceled_at + clear executed_at.
  IF NEW.canceled = TRUE AND (OLD.canceled IS DISTINCT FROM TRUE) THEN
    NEW.canceled_at = COALESCE(NEW.canceled_at, NOW());
    NEW.executed_at = NULL;
    -- D-219 placeholder: Batch 6 stripe-webhook integration will
    -- add subscription re-activation here. For now: log via
    -- notifications_log (table exists per §2.6).
    INSERT INTO public.notifications_log(severity, metadata, sent_to)
    VALUES (
      'info',
      jsonb_build_object('event','deletion_canceled','user_id',NEW.user_id,'requested_at',NEW.requested_at),
      'system'
    );
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS process_deletion_on_signup_cancel ON public.account_deletion_requests;
CREATE TRIGGER process_deletion_on_signup_cancel
  BEFORE UPDATE ON public.account_deletion_requests
  FOR EACH ROW EXECUTE FUNCTION public.process_deletion_on_signup_cancel();

-- ============================================================
-- 7) state_availability (§2.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.state_availability (
  state_code             TEXT PRIMARY KEY CHECK (state_code ~ '^[A-Z]{2,3}$'),
  status                 TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','waitlist','blocked')),
  legal_review_status    TEXT,
  enabled_at             TIMESTAMPTZ,
  monitored              BOOLEAN NOT NULL DEFAULT FALSE,
  notes                  TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE public.state_availability IS 'Geo-gate for US states + CA provinces. Arch §2.4 + §9.3 broad-state launch.';

-- ============================================================
-- 8) analytics_events (§2.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id  TEXT,
  event       TEXT NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_analytics_event_created ON public.analytics_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_user ON public.analytics_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_analytics_session ON public.analytics_events (session_id, created_at DESC) WHERE session_id IS NOT NULL;
COMMENT ON TABLE public.analytics_events IS 'Funnel + retention tracking. Arch §2.4. Anonymous events allowed (user_id NULL).';

-- ============================================================
-- 9) waitlist (NEW — arch §1.1 landing waitlist CTA)
-- ============================================================
-- Architecture §1.1 specifies a waitlist CTA but doesn't spec the
-- table schema. Minimal schema for the pre-launch + closed-beta-with-
-- invalid-invite paths.
CREATE TABLE IF NOT EXISTS public.waitlist (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE CHECK (email = LOWER(email) AND email ~ '^[^@]+@[^@]+\.[^@]+$'),
  referral_code   TEXT,
  state_residence TEXT,
  source          TEXT NOT NULL DEFAULT 'landing' CHECK (source IN ('landing','beta_access_invalid_invite','closed_beta_phase')),
  notified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_waitlist_created ON public.waitlist (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waitlist_notified ON public.waitlist (notified_at) WHERE notified_at IS NULL;
COMMENT ON TABLE public.waitlist IS 'Email capture from /landing pre-launch + invalid-invite paths. D-219 schema (arch §1.1 referenced but not speced).';

-- ============================================================
-- RLS — enable + policies per §2.8 policy matrix
-- ============================================================

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subs_select_own ON public.subscriptions;
CREATE POLICY subs_select_own ON public.subscriptions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- Writes: service-role only (Stripe webhook). No INSERT/UPDATE/DELETE
-- policies for authenticated → blocked by default.

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rc_select_own_or_active ON public.referral_codes;
-- Read: own row OR by-code lookup (active code only — for landing-page
-- attribution where the visitor only knows the code, not the user_id).
CREATE POLICY rc_select_own_or_active ON public.referral_codes
  FOR SELECT TO anon, authenticated
  USING (
    (user_id = auth.uid())
    OR (is_active = TRUE)
  );
-- Writes: service-role only.

ALTER TABLE public.referrals_made ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rm_select_referrer ON public.referrals_made;
CREATE POLICY rm_select_referrer ON public.referrals_made
  FOR SELECT TO authenticated
  USING (referrer_user_id = auth.uid());

ALTER TABLE public.referral_credits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rcred_select_own ON public.referral_credits;
CREATE POLICY rcred_select_own ON public.referral_credits
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

ALTER TABLE public.promotional_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pg_select_own ON public.promotional_grants;
CREATE POLICY pg_select_own ON public.promotional_grants
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- Anon read by invite_code (for /beta-access?invite= validation
-- before signup) — by-code-only, no user_id needed.
DROP POLICY IF EXISTS pg_select_by_invite_code ON public.promotional_grants;
CREATE POLICY pg_select_by_invite_code ON public.promotional_grants
  FOR SELECT TO anon
  USING (invite_code IS NOT NULL AND status IN ('available','reserved'));

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adr_select_own ON public.account_deletion_requests;
CREATE POLICY adr_select_own ON public.account_deletion_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS adr_insert_own ON public.account_deletion_requests;
CREATE POLICY adr_insert_own ON public.account_deletion_requests
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS adr_update_own ON public.account_deletion_requests;
CREATE POLICY adr_update_own ON public.account_deletion_requests
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

ALTER TABLE public.state_availability ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sa_select_public ON public.state_availability;
CREATE POLICY sa_select_public ON public.state_availability
  FOR SELECT TO anon, authenticated
  USING (true);
DROP POLICY IF EXISTS sa_admin_write ON public.state_availability;
CREATE POLICY sa_admin_write ON public.state_availability
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ae_select_admin ON public.analytics_events;
CREATE POLICY ae_select_admin ON public.analytics_events
  FOR SELECT TO authenticated
  USING (public.is_admin());

ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wl_insert_public ON public.waitlist;
CREATE POLICY wl_insert_public ON public.waitlist
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);
DROP POLICY IF EXISTS wl_select_admin ON public.waitlist;
CREATE POLICY wl_select_admin ON public.waitlist
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ============================================================
-- Verification — all 9 tables created + RLS enabled
-- ============================================================
DO $$
DECLARE
  expected TEXT[] := ARRAY['subscriptions','referral_codes','referrals_made','referral_credits','promotional_grants','account_deletion_requests','state_availability','analytics_events','waitlist'];
  tbl_count INT;
  rls_count INT;
  pol_count INT;
BEGIN
  SELECT COUNT(*) INTO tbl_count FROM pg_tables
    WHERE schemaname='public' AND tablename = ANY(expected);
  SELECT COUNT(*) INTO rls_count FROM pg_tables
    WHERE schemaname='public' AND tablename = ANY(expected) AND rowsecurity = TRUE;
  SELECT COUNT(*) INTO pol_count FROM pg_policies
    WHERE schemaname='public' AND tablename = ANY(expected);
  RAISE NOTICE 'D-219 VERIFY: % of 9 tables created, % with RLS enabled, % policies total', tbl_count, rls_count, pol_count;
  IF tbl_count <> 9 OR rls_count <> 9 THEN
    RAISE EXCEPTION 'D-219 VERIFY FAIL: expected 9 tables with RLS, got % tables / % RLS', tbl_count, rls_count;
  END IF;
  IF pol_count < 9 THEN
    RAISE EXCEPTION 'D-219 VERIFY FAIL: expected ≥9 policies, got %', pol_count;
  END IF;
END $$;

-- ============================================================
-- Seed: state_availability (per §9.3 broad-state launch)
-- ============================================================
-- All 50 US states + DC available at launch. Washington (WA) + Hawaii (HI)
-- flagged for legal monitoring per CEO counsel discussion (architecture
-- §9.3). All other states default to available with no monitoring.

INSERT INTO public.state_availability (state_code, status, monitored, legal_review_status, enabled_at, notes) VALUES
  ('AL','available',FALSE,'cleared',NOW(),NULL),
  ('AK','available',FALSE,'cleared',NOW(),NULL),
  ('AZ','available',FALSE,'cleared',NOW(),NULL),
  ('AR','available',FALSE,'cleared',NOW(),NULL),
  ('CA','available',FALSE,'cleared',NOW(),NULL),
  ('CO','available',FALSE,'cleared',NOW(),NULL),
  ('CT','available',FALSE,'cleared',NOW(),NULL),
  ('DE','available',FALSE,'cleared',NOW(),NULL),
  ('FL','available',FALSE,'cleared',NOW(),NULL),
  ('GA','available',FALSE,'cleared',NOW(),NULL),
  ('HI','available',TRUE,'monitor','2026-05-18'::TIMESTAMPTZ,'§9.3 counsel-flagged for monitoring'),
  ('ID','available',FALSE,'cleared',NOW(),NULL),
  ('IL','available',FALSE,'cleared',NOW(),NULL),
  ('IN','available',FALSE,'cleared',NOW(),NULL),
  ('IA','available',FALSE,'cleared',NOW(),NULL),
  ('KS','available',FALSE,'cleared',NOW(),NULL),
  ('KY','available',FALSE,'cleared',NOW(),NULL),
  ('LA','available',FALSE,'cleared',NOW(),NULL),
  ('ME','available',FALSE,'cleared',NOW(),NULL),
  ('MD','available',FALSE,'cleared',NOW(),NULL),
  ('MA','available',FALSE,'cleared',NOW(),NULL),
  ('MI','available',FALSE,'cleared',NOW(),NULL),
  ('MN','available',FALSE,'cleared',NOW(),NULL),
  ('MS','available',FALSE,'cleared',NOW(),NULL),
  ('MO','available',FALSE,'cleared',NOW(),NULL),
  ('MT','available',FALSE,'cleared',NOW(),NULL),
  ('NE','available',FALSE,'cleared',NOW(),NULL),
  ('NV','available',FALSE,'cleared',NOW(),NULL),
  ('NH','available',FALSE,'cleared',NOW(),NULL),
  ('NJ','available',FALSE,'cleared',NOW(),NULL),
  ('NM','available',FALSE,'cleared',NOW(),NULL),
  ('NY','available',FALSE,'cleared',NOW(),NULL),
  ('NC','available',FALSE,'cleared',NOW(),NULL),
  ('ND','available',FALSE,'cleared',NOW(),NULL),
  ('OH','available',FALSE,'cleared',NOW(),NULL),
  ('OK','available',FALSE,'cleared',NOW(),NULL),
  ('OR','available',FALSE,'cleared',NOW(),NULL),
  ('PA','available',FALSE,'cleared',NOW(),NULL),
  ('RI','available',FALSE,'cleared',NOW(),NULL),
  ('SC','available',FALSE,'cleared',NOW(),NULL),
  ('SD','available',FALSE,'cleared',NOW(),NULL),
  ('TN','available',FALSE,'cleared',NOW(),NULL),
  ('TX','available',FALSE,'cleared',NOW(),NULL),
  ('UT','available',FALSE,'cleared',NOW(),NULL),
  ('VT','available',FALSE,'cleared',NOW(),NULL),
  ('VA','available',FALSE,'cleared',NOW(),NULL),
  ('WA','available',TRUE,'monitor','2026-05-18'::TIMESTAMPTZ,'§9.3 counsel-flagged for monitoring'),
  ('WV','available',FALSE,'cleared',NOW(),NULL),
  ('WI','available',FALSE,'cleared',NOW(),NULL),
  ('WY','available',FALSE,'cleared',NOW(),NULL),
  ('DC','available',FALSE,'cleared',NOW(),NULL),
  -- Canadian provinces + territories
  ('AB','available',FALSE,'cleared',NOW(),'Alberta'),
  ('BC','available',FALSE,'cleared',NOW(),'British Columbia'),
  ('MB','available',FALSE,'cleared',NOW(),'Manitoba'),
  ('NB','available',FALSE,'cleared',NOW(),'New Brunswick'),
  ('NL','available',FALSE,'cleared',NOW(),'Newfoundland and Labrador'),
  ('NS','available',FALSE,'cleared',NOW(),'Nova Scotia'),
  ('ON','available',FALSE,'cleared',NOW(),'Ontario'),
  ('PE','available',FALSE,'cleared',NOW(),'Prince Edward Island'),
  ('QC','available',FALSE,'cleared',NOW(),'Quebec'),
  ('SK','available',FALSE,'cleared',NOW(),'Saskatchewan'),
  ('NT','available',FALSE,'cleared',NOW(),'Northwest Territories'),
  ('NU','available',FALSE,'cleared',NOW(),'Nunavut'),
  ('YT','available',FALSE,'cleared',NOW(),'Yukon')
ON CONFLICT (state_code) DO NOTHING;

-- ============================================================
-- Seed: promotional_grants — 50 closed-beta invite slots
-- ============================================================
-- expires_at per D-196: closed beta launches Aug 1 2026; 7-day trial +
-- grandfather window through Apr 1 2027 at $49 lock. expires_at on
-- each grant = the moment the slot becomes invalid for fresh redemption
-- if not already granted (slot reclamation date).
INSERT INTO public.promotional_grants (grant_type, invite_code, expires_at, status)
SELECT
  'closed_beta_aug2026',
  'BETA-' || LPAD(s::TEXT, 3, '0') || '-' || SUBSTRING(MD5(s::TEXT || 'd219salt') FROM 1 FOR 6),
  '2026-10-01'::TIMESTAMPTZ,  -- public launch date — unredeemed slots reclaim
  'available'
FROM generate_series(1, 50) AS s
ON CONFLICT (invite_code) DO NOTHING;

DO $$
DECLARE
  state_count INT;
  promo_count INT;
BEGIN
  SELECT COUNT(*) INTO state_count FROM public.state_availability;
  SELECT COUNT(*) INTO promo_count FROM public.promotional_grants WHERE grant_type='closed_beta_aug2026' AND status='available';
  RAISE NOTICE 'D-219 SEED: state_availability=%, closed_beta_aug2026 available=%', state_count, promo_count;
END $$;

COMMIT;
