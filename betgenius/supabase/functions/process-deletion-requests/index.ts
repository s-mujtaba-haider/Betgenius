// process-deletion-requests — D-223 Task 6.4 + arch §6.6.
//
// Daily cron — finds account_deletion_requests rows where
// scheduled_for <= NOW() AND canceled = FALSE AND executed_at IS NULL.
// For each:
//   1. Cancel the user's Stripe subscription (if any) immediately
//      (no period-end wait — they requested deletion).
//   2. Delete the auth.users row (cascades to subscriptions,
//      user_preferences, etc per FKs).
//   3. Stamp executed_at on the deletion request.
//   4. Send account_deleted email.
//
// Auth: service-role.
// Idempotent: skips rows already executed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sendEmail } from "../_shared/email.ts";
import { stripe, STRIPE_CONFIGURED } from "../_shared/stripe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  const startMs = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPABASE_KEY)) return jsonResponse({ error: "unauthorized" }, 401);

  // D-262 dry-run gate: parse body.dry_run. When true: identify due
  // deletions (read-only query) but SKIP every mutating call —
  //   - Stripe subscription.cancel (external mutating API)
  //   - auth.users DELETE (irreversible)
  //   - account_deletion_requests PATCH (executed_at)
  //   - sendEmail (Resend external API)
  let dryRun = false;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body?.dry_run === true) dryRun = true;
    } catch { /* empty body ok */ }
  }

  // Find due deletions.
  const nowIso = new Date().toISOString();
  const dueRes = await fetch(
    `${SUPABASE_URL}/rest/v1/account_deletion_requests?canceled=eq.false&executed_at=is.null&scheduled_for=lte.${nowIso}&select=user_id,requested_at,scheduled_for`,
    { headers: supaHeaders },
  );
  if (!dueRes.ok) return jsonResponse({ error: "due_query_failed", status: dueRes.status }, 500);
  const due = await dueRes.json() as Array<{ user_id: string; requested_at: string; scheduled_for: string }>;
  if (due.length === 0) {
    if (dryRun) {
      return jsonResponse({
        dry_run: true,
        due_count: 0,
        would_write: {
          "auth.users": 0,
          account_deletion_requests: 0,
          stripe_subscriptions_cancel: 0,
          emails_sent: 0,
        },
        elapsed_ms: Date.now() - startMs,
      });
    }
    return jsonResponse({ success: true, processed: 0, message: "no due deletions" });
  }

  if (dryRun) {
    // Count what WOULD be done per due row without mutating anything.
    let wouldStripeCancel = 0;
    let wouldEmail = 0;
    for (const row of due) {
      // Read subscriptions (this is a SELECT, not a write — safe to do).
      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${row.user_id}&select=stripe_subscription_id`, { headers: supaHeaders });
      if (subRes.ok && STRIPE_CONFIGURED && stripe) {
        const subRows = await subRes.json();
        for (const s of subRows ?? []) {
          if (s.stripe_subscription_id) wouldStripeCancel++;
        }
      }
      // Read user email (SELECT, safe).
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${row.user_id}`, { headers: supaHeaders });
      const email = userRes.ok ? (await userRes.json())?.email ?? null : null;
      if (email) wouldEmail++;
    }
    return jsonResponse({
      dry_run: true,
      due_count: due.length,
      would_write: {
        "auth.users": due.length,  // each due row triggers an auth.users DELETE
        account_deletion_requests: due.length,  // each row stamps executed_at
        stripe_subscriptions_cancel: wouldStripeCancel,
        emails_sent: wouldEmail,
      },
      elapsed_ms: Date.now() - startMs,
    });
  }

  let processed = 0;
  let errors = 0;
  for (const row of due) {
    try {
      // 1. Look up email + subscription before deletion (deletion cascades).
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${row.user_id}`, { headers: supaHeaders });
      const email = userRes.ok ? (await userRes.json())?.email ?? null : null;

      // 2. Cancel Stripe subscription (best-effort).
      const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${row.user_id}&select=stripe_subscription_id`, { headers: supaHeaders });
      if (subRes.ok && STRIPE_CONFIGURED && stripe) {
        const subRows = await subRes.json();
        for (const s of subRows ?? []) {
          if (s.stripe_subscription_id) {
            try { await stripe.subscriptions.cancel(s.stripe_subscription_id); } catch { /* non-fatal */ }
          }
        }
      }

      // 3. Delete auth.users row (cascade removes subscriptions, prefs, etc).
      const delRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${row.user_id}`, {
        method: "DELETE",
        headers: supaHeaders,
      });
      if (!delRes.ok) { errors++; continue; }

      // 4. Stamp executed_at.
      await fetch(`${SUPABASE_URL}/rest/v1/account_deletion_requests?user_id=eq.${row.user_id}`, {
        method: "PATCH",
        headers: { ...supaHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ executed_at: new Date().toISOString() }),
      });

      // 5. Email confirmation (if we still have the address).
      if (email) {
        await sendEmail(email, "account_deleted", {
          email,
          account_deleted_date: new Date().toISOString().slice(0, 10),
        });
      }

      processed++;
    } catch {
      errors++;
    }
  }

  return jsonResponse({ success: true, due_count: due.length, processed, errors });
});
