// useSubscriptionGate — D-221 Task 6.2.
//
// Architecture §6.4 subscription state machine read-side. Returns
// access_level for the current user; App.tsx routing uses this to
// gate page access per §6.7.
//
// Pre-launch behavior: when a user is in allowed_emails (legacy beta
// allowlist), grant 'full' access regardless of subscriptions row.
// Post-launch: subscriptions row drives access_level.

import { useEffect, useState } from "react";
import { useAuthSession, isEmailAllowed } from "@/lib/auth";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";

export type SubStatus =
  | "incomplete"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete_expired";

export type AccessLevel =
  | "full"
  | "degraded"
  | "subscribe_required"
  | "loading";

export interface SubscriptionGate {
  status: SubStatus | null;
  access_level: AccessLevel;
  days_remaining: number | null;     // days until trial_end or period_end
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  trial_end: string | null;
  plan_id: string | null;
  is_beta_locked: boolean;            // true when plan_id=pro_beta_49
  loading: boolean;
}

const DEFAULT_GATE: SubscriptionGate = {
  status: null,
  access_level: "loading",
  days_remaining: null,
  cancel_at_period_end: false,
  current_period_end: null,
  trial_end: null,
  plan_id: null,
  is_beta_locked: false,
  loading: true,
};

function diffDays(toIso: string | null): number | null {
  if (!toIso) return null;
  const target = new Date(toIso).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.ceil((target - Date.now()) / (1000 * 60 * 60 * 24));
}

export function useSubscriptionGate(): SubscriptionGate {
  const { session, loading: authLoading } = useAuthSession();
  const [gate, setGate] = useState<SubscriptionGate>(DEFAULT_GATE);

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      // Anonymous: gate is "subscribe_required" by default. Landing
      // page is shown by AuthGate before the gate ever fires for an
      // unauthenticated visitor — this branch covers programmatic
      // checks while loading.
      setGate({ ...DEFAULT_GATE, access_level: "subscribe_required", loading: false });
      return;
    }

    let cancelled = false;

    (async () => {
      const email = session.user?.email?.toLowerCase();

      // Pre-launch grace: allowlist members get 'full' regardless of
      // subscriptions row presence. Post-launch this branch becomes a
      // no-op when allowed_emails is empty / deprecated per §2.3.
      let allowlistFull = false;
      if (email) {
        const allowed = await isEmailAllowed(email);
        if (allowed === true) allowlistFull = true;
      }

      const subRes = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${session.user.id}&select=status,trial_end,current_period_end,cancel_at_period_end,plan_id`,
        {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
        },
      );
      if (cancelled) return;

      let row: {
        status: SubStatus;
        trial_end: string | null;
        current_period_end: string | null;
        cancel_at_period_end: boolean;
        plan_id: string | null;
      } | null = null;
      if (subRes.ok) {
        const rows = await subRes.json();
        if (Array.isArray(rows) && rows.length > 0) row = rows[0];
      }

      if (!row) {
        // No subscriptions row.
        if (allowlistFull) {
          setGate({
            ...DEFAULT_GATE,
            status: null,
            access_level: "full",
            loading: false,
          });
        } else {
          setGate({
            ...DEFAULT_GATE,
            status: null,
            access_level: "subscribe_required",
            loading: false,
          });
        }
        return;
      }

      const status = row.status;
      const periodEnd = row.current_period_end;
      const trialEnd = row.trial_end;
      const cancelAtPeriodEnd = !!row.cancel_at_period_end;
      const plan = row.plan_id;

      let access: AccessLevel = "full";

      if (status === "trialing" || status === "active") {
        access = "full";
      } else if (status === "past_due") {
        // First 3 days of past_due = grace (full). After = degraded.
        const periodDays = diffDays(periodEnd);
        if (periodDays !== null && periodDays > -3) access = "full";
        else access = "degraded";
      } else if (status === "canceled" && cancelAtPeriodEnd) {
        // Cancel pending end of period — full access until then.
        const days = diffDays(periodEnd);
        access = days !== null && days > 0 ? "full" : "subscribe_required";
      } else if (status === "canceled") {
        access = "subscribe_required";
      } else if (status === "unpaid" || status === "incomplete_expired") {
        access = "subscribe_required";
      } else if (status === "incomplete") {
        // Checkout started but never completed — push back to /subscribe.
        access = allowlistFull ? "full" : "subscribe_required";
      }

      // Allowlist override during pre-launch period — keep beta users
      // unblocked even if their Stripe row has a weird state.
      if (allowlistFull && access === "subscribe_required") access = "full";

      const trialDays = diffDays(trialEnd);
      const periodDays = diffDays(periodEnd);

      setGate({
        status,
        access_level: access,
        days_remaining: trialDays ?? periodDays,
        cancel_at_period_end: cancelAtPeriodEnd,
        current_period_end: periodEnd,
        trial_end: trialEnd,
        plan_id: plan,
        is_beta_locked: plan === "pro_beta_49",
        loading: false,
      });
    })().catch(() => {
      if (cancelled) return;
      // Failure to load gate → fail-open to 'full' during pre-launch
      // to avoid locking out CEO + beta cohort on network blips.
      // Post-launch this should fail-closed; flip via env or feature
      // flag in Batch 7.
      setGate({ ...DEFAULT_GATE, access_level: "full", loading: false });
    });

    return () => { cancelled = true; };
  }, [session, authLoading]);

  return gate;
}
