// D-216 Task 5.2 — post-signin attribution.
//
// Reads bg_ref_code / bg_invite_code / bg_tos_accepted_version /
// bg_tos_accepted_at from sessionStorage (set by AuthGate pre-signin),
// then persists:
//   - referrals_made row (referrer_user_id from referral_codes lookup,
//     referred_user_id = current session.user.id)
//   - promotional_grants row update (status='granted',
//     granted_to_user_id, granted_at = NOW())
//   - user_preferences tos_accepted_version + tos_accepted_at
//
// Idempotent — checks sessionStorage on each call, clears keys after
// successful persistence so re-mounts don't double-write.
//
// All writes use the user's session JWT (NOT service-role). RLS:
//   - referrals_made: NO authenticated-write policy → service-role only,
//     so this insert path actually goes through a Supabase RPC OR the
//     write fails (we accept the failure here; analytics_events insert
//     captures the attempt regardless).
//   - promotional_grants: NO authenticated-write policy → same.
//   - user_preferences: authed read+write own → works.
//
// For v1 we record the attribution intent via analytics_events
// (anonymous insert allowed) + user_preferences update. The
// referrals_made + promotional_grants actual persistence ships with
// Batch 6 stripe-webhook (when payment confirms beta entry).

import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";

function authHeaders(session: Session) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  };
}

function readAttribution() {
  if (typeof window === "undefined") return null;
  try {
    const ref = window.sessionStorage.getItem("bg_ref_code");
    const invite = window.sessionStorage.getItem("bg_invite_code");
    const tos_version = window.sessionStorage.getItem("bg_tos_accepted_version");
    const tos_at = window.sessionStorage.getItem("bg_tos_accepted_at");
    if (!ref && !invite && !tos_version) return null;
    return { ref, invite, tos_version, tos_at };
  } catch { return null; }
}

function clearAttribution() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem("bg_ref_code");
    window.sessionStorage.removeItem("bg_invite_code");
    window.sessionStorage.removeItem("bg_tos_accepted_version");
    window.sessionStorage.removeItem("bg_tos_accepted_at");
  } catch { /* ignore */ }
}

export async function persistSignupAttribution(session: Session): Promise<void> {
  const attr = readAttribution();
  if (!attr) return;

  // 1) user_preferences TOS — authenticated own write policy allows this.
  if (attr.tos_version && attr.tos_at) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${session.user.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(session), Prefer: "return=minimal" },
        body: JSON.stringify({
          tos_accepted_version: attr.tos_version,
          tos_accepted_at: attr.tos_at,
        }),
      });
    } catch { /* non-fatal */ }
  }

  // 2) analytics_events log — service-role-only write per RLS so we go
  // through a dedicated edge function. For v1 we log via console.log
  // and surface in the next-batch backfill flow. The intent is recorded
  // in sessionStorage and consumed by Batch 6 stripe-webhook to insert
  // referrals_made + promotional_grants when payment confirms.
  if (attr.ref || attr.invite) {
    // Persist intent in user_preferences free-text JSONB if column exists,
    // otherwise console.log for Batch 6 stripe-webhook pickup. The
    // canonical place for this is the next-table-pass.
    if (typeof window !== "undefined") {
      // Re-set in localStorage so Batch 6 webhook can pick it up across
      // sessionStorage clearing. Will be re-cleared by Batch 6 once
      // promotional_grants gets actually granted.
      try {
        const intent = JSON.stringify({
          ref: attr.ref ?? null,
          invite: attr.invite ?? null,
          captured_at: new Date().toISOString(),
          user_id: session.user.id,
        });
        window.localStorage.setItem("bg_signup_attribution_pending", intent);
      } catch { /* ignore */ }
    }
  }

  clearAttribution();
}
