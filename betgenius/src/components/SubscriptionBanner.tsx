// SubscriptionBanner — D-221 Task 6.2.
//
// Renders contextual banners based on useSubscriptionGate output:
//   - past_due / degraded → "Payment past due — update card" + portal link
//   - cancel_at_period_end + active/trialing → "Cancels {{date}}" + reactivate
//   - trialing with days_remaining ≤ 2 → "Trial ends in N days"
//
// Banner CTAs hit customer-portal-session edge function to redirect
// to Stripe portal.

import { useState } from "react";
import { SUPABASE_URL } from "@/lib/supabase";
import { useAuthSession } from "@/lib/auth";
import { useSubscriptionGate } from "@/hooks/useSubscriptionGate";

export default function SubscriptionBanner() {
  const gate = useSubscriptionGate();
  const { session } = useAuthSession();
  const [opening, setOpening] = useState(false);

  if (gate.loading) return null;
  if (!session?.access_token) return null;

  async function openPortal() {
    if (!session?.access_token || opening) return;
    setOpening(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/customer-portal-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const body = await res.json();
      if (res.ok && body.url) window.location.href = body.url;
    } finally {
      setOpening(false);
    }
  }

  // Past-due grace expired → degraded banner (urgent)
  if (gate.access_level === "degraded") {
    return (
      <div className="bg-red-500/15 border-b border-red-500/40 text-red-200 px-4 py-2 text-xs flex items-center justify-between gap-3">
        <span>
          <strong>Payment past due.</strong> Update your card to keep access. Read-only mode active until resolved.
        </span>
        <button onClick={openPortal} disabled={opening} className="rounded-md bg-red-500/30 hover:bg-red-500/50 px-3 py-1 font-medium text-red-100 disabled:opacity-60">
          {opening ? "Opening…" : "Update payment"}
        </button>
      </div>
    );
  }

  // Cancellation pending — warn but no urgency
  if (gate.cancel_at_period_end && gate.current_period_end) {
    const date = gate.current_period_end.slice(0, 10);
    return (
      <div className="bg-amber-500/10 border-b border-amber-500/30 text-amber-200 px-4 py-2 text-xs flex items-center justify-between gap-3">
        <span>
          Subscription cancels <strong>{date}</strong>. Reactivate anytime to keep access.
        </span>
        <button onClick={openPortal} disabled={opening} className="rounded-md bg-amber-500/20 hover:bg-amber-500/40 px-3 py-1 font-medium text-amber-100 disabled:opacity-60">
          {opening ? "Opening…" : "Manage subscription"}
        </button>
      </div>
    );
  }

  // Trial ending soon
  if (gate.status === "trialing" && gate.days_remaining !== null && gate.days_remaining <= 2) {
    return (
      <div className="bg-emerald-500/10 border-b border-emerald-500/30 text-emerald-200 px-4 py-2 text-xs flex items-center justify-between gap-3">
        <span>
          Trial ends in <strong>{gate.days_remaining} day{gate.days_remaining === 1 ? "" : "s"}</strong>. Billing continues automatically — cancel anytime.
        </span>
        <button onClick={openPortal} disabled={opening} className="rounded-md bg-emerald-500/20 hover:bg-emerald-500/40 px-3 py-1 font-medium text-emerald-100 disabled:opacity-60">
          {opening ? "Opening…" : "Manage"}
        </button>
      </div>
    );
  }

  return null;
}
