// stripe-webhook — D-220 Task 6.1 + D-222 Task 6.3 + D-223 Task 6.4.
//
// Stripe webhook receiver. verify_jwt = false at deploy (Stripe doesn't
// send a JWT). Verifies signature via stripe.webhooks.constructEvent
// per arch §6.3.
//
// Handled events:
//   checkout.session.completed       → insert subscriptions row,
//                                       redeem promotional_grants slot,
//                                       insert referrals_made row,
//                                       send welcome email
//   invoice.payment_succeeded        → activate / extend period,
//                                       award referral_credits on first paid,
//                                       send payment_succeeded email
//   invoice.payment_failed           → past_due, send payment_failed email
//   customer.subscription.updated    → mirror cancel_at_period_end
//   customer.subscription.deleted    → status='canceled'
//   charge.refunded                  → send refund_processed email,
//                                       clawback referral_credits if any
//
// Failures: log to error_log + return 500 to Stripe (it retries).
// Signature mismatch: 400 + no retry.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { stripe, STRIPE_CONFIGURED } from "../_shared/stripe.ts";
import { sendEmail } from "../_shared/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET =
  Deno.env.get("STRIPE_WEBHOOK_SECRET") ??
  Deno.env.get("STRIPE_WEBHOOK_SECRET_TEST") ??
  "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

const supaHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function logErr(phase: string, errorType: string, msg: string, context: Record<string, unknown> = {}): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
      method: "POST",
      headers: { ...supaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ function_name: "stripe-webhook", phase, error_type: errorType, error_message: msg, context }),
    });
  } catch { /* swallow */ }
}

async function getUserEmail(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: supaHeaders });
    if (!res.ok) return null;
    const u = await res.json();
    return u?.email ?? null;
  } catch { return null; }
}

async function fetchCalibrationPct(): Promise<number | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/calibration_snapshots?metric_type=eq.rolling_30d_70plus_wr&order=snapshot_date.desc&limit=1&select=wr_pct`, { headers: supaHeaders });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0]?.wr_pct ?? null;
  } catch { return null; }
}

// ============================================================
// Per-event handlers
// ============================================================

async function handleCheckoutCompleted(ev: { data: { object: Record<string, unknown> } }): Promise<void> {
  const session = ev.data.object;
  const metadata = (session.metadata ?? {}) as Record<string, string>;
  const userId = metadata.user_id;
  if (!userId) { await logErr("checkout_completed", "missing_user_id", "session.metadata.user_id absent", { session_id: session.id }); return; }

  const customerId = session.customer as string | null;
  const subscriptionId = session.subscription as string | null;
  if (!customerId || !subscriptionId) { await logErr("checkout_completed", "missing_ids", "customer or subscription id missing", { session_id: session.id }); return; }

  // Pull subscription detail from Stripe for trial_end + period bounds.
  let subDetail: { trial_end?: number | null; current_period_start?: number; current_period_end?: number; status?: string } | null = null;
  try {
    if (!stripe) throw new Error("stripe not configured");
    subDetail = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (e) {
    await logErr("checkout_completed", "retrieve_failed", String(e), { subscription_id: subscriptionId });
  }

  const plan = metadata.plan || "pro_beta_49";
  const trialEnd = subDetail?.trial_end ? new Date(subDetail.trial_end * 1000).toISOString() : null;
  const periodStart = subDetail?.current_period_start ? new Date(subDetail.current_period_start * 1000).toISOString() : null;
  const periodEnd = subDetail?.current_period_end ? new Date(subDetail.current_period_end * 1000).toISOString() : null;

  // Insert subscriptions row (UPSERT on user_id UNIQUE).
  const upRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=user_id`, {
    method: "POST",
    headers: { ...supaHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      status: subDetail?.status ?? "trialing",
      plan_id: plan,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      cancel_at_period_end: false,
      trial_end: trialEnd,
    }),
  });
  if (!upRes.ok) {
    await logErr("checkout_completed", "subs_upsert_failed", `${upRes.status} ${(await upRes.text()).slice(0, 200)}`, { user_id: userId });
  }

  // D-222 attribution: redeem promotional_grants slot if invite_code present.
  if (metadata.invite_code) {
    const pgRes = await fetch(`${SUPABASE_URL}/rest/v1/promotional_grants?invite_code=eq.${encodeURIComponent(metadata.invite_code)}&status=eq.available`, {
      method: "PATCH",
      headers: { ...supaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        status: "redeemed",
        granted_at: new Date().toISOString(),
        redeemed: true,
      }),
    });
    if (!pgRes.ok) await logErr("checkout_completed", "promo_redeem_failed", `${pgRes.status}`, { invite_code: metadata.invite_code });
  }

  // D-222 attribution: insert referrals_made if ref_code present.
  if (metadata.ref_code) {
    // Lookup referrer_user_id
    const rcRes = await fetch(`${SUPABASE_URL}/rest/v1/referral_codes?code=eq.${encodeURIComponent(metadata.ref_code)}&is_active=eq.true&select=user_id`, { headers: supaHeaders });
    if (rcRes.ok) {
      const rows = await rcRes.json();
      const referrerId = Array.isArray(rows) && rows.length > 0 ? rows[0].user_id : null;
      if (referrerId && referrerId !== userId) {
        const rmRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals_made`, {
          method: "POST",
          headers: { ...supaHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            referrer_user_id: referrerId,
            referred_user_id: userId,
            referral_code: metadata.ref_code,
            status: "signed_up",
            signed_up_at: new Date().toISOString(),
          }),
        });
        if (!rmRes.ok) await logErr("checkout_completed", "referral_insert_failed", `${rmRes.status}`, { ref_code: metadata.ref_code, referrer_id: referrerId });
      }
    }
  }

  // D-223 welcome email
  const email = await getUserEmail(userId);
  if (email) {
    const calibPct = await fetchCalibrationPct();
    await sendEmail(email, "welcome", {
      email,
      trial_end_date: trialEnd ? trialEnd.slice(0, 10) : undefined,
      calibration_pct: calibPct ?? undefined,
    });
  }
}

async function handleInvoicePaymentSucceeded(ev: { data: { object: Record<string, unknown> } }): Promise<void> {
  const invoice = ev.data.object;
  const subscriptionId = invoice.subscription as string | null;
  const customerId = invoice.customer as string | null;
  const amountPaid = (invoice.amount_paid as number | undefined) ?? 0;
  if (!subscriptionId) return;

  // Pull subscription state from Stripe to keep period_end fresh.
  let subDetail: { current_period_start?: number; current_period_end?: number; status?: string; metadata?: Record<string, string> } | null = null;
  try {
    if (!stripe) throw new Error("stripe not configured");
    subDetail = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (e) { await logErr("invoice_paid", "retrieve_failed", String(e), { subscription_id: subscriptionId }); }

  const periodStart = subDetail?.current_period_start ? new Date(subDetail.current_period_start * 1000).toISOString() : null;
  const periodEnd = subDetail?.current_period_end ? new Date(subDetail.current_period_end * 1000).toISOString() : null;

  // Patch subscriptions.
  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      status: subDetail?.status ?? "active",
      current_period_start: periodStart,
      current_period_end: periodEnd,
    }),
  });
  let userId: string | null = null;
  if (patchRes.ok) {
    const rows = await patchRes.json();
    if (Array.isArray(rows) && rows.length > 0) userId = rows[0].user_id;
  } else {
    await logErr("invoice_paid", "subs_patch_failed", `${patchRes.status}`, { subscription_id: subscriptionId });
  }

  // D-222 affiliate: on first paid invoice (not trial conversion freebie),
  // promote referrals_made to 'paying' + insert $20 referral_credits.
  // Use Stripe's billing_reason = subscription_cycle vs subscription_create.
  const billingReason = invoice.billing_reason as string | undefined;
  if (userId && (billingReason === "subscription_cycle" || billingReason === "subscription_create") && amountPaid > 0) {
    // Check if any pending referrals_made for this user.
    const rmRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals_made?referred_user_id=eq.${userId}&status=eq.signed_up&select=id,referrer_user_id`, { headers: supaHeaders });
    if (rmRes.ok) {
      const rows = await rmRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const ref = rows[0];
        await fetch(`${SUPABASE_URL}/rest/v1/referrals_made?id=eq.${ref.id}`, {
          method: "PATCH",
          headers: { ...supaHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: "paying", paying_since: new Date().toISOString(), credit_dollars_earned: 20 }),
        });
        // §11.2 — $20 credit to referrer.
        await fetch(`${SUPABASE_URL}/rest/v1/referral_credits`, {
          method: "POST",
          headers: { ...supaHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            user_id: ref.referrer_user_id,
            amount: 20,
            kind: "earned",
            referral_id: ref.id,
          }),
        });
      }
    }
  }

  // D-223 payment_succeeded email
  if (userId) {
    const email = await getUserEmail(userId);
    if (email) {
      await sendEmail(email, "payment_succeeded", {
        email,
        payment_amount: `$${(amountPaid / 100).toFixed(2)}`,
        payment_period_end: periodEnd ? periodEnd.slice(0, 10) : undefined,
      });
    }
  }
}

async function handleInvoicePaymentFailed(ev: { data: { object: Record<string, unknown> } }): Promise<void> {
  const invoice = ev.data.object;
  const subscriptionId = invoice.subscription as string | null;
  if (!subscriptionId) return;
  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ status: "past_due" }),
  });
  let userId: string | null = null;
  if (patchRes.ok) {
    const rows = await patchRes.json();
    if (Array.isArray(rows) && rows.length > 0) userId = rows[0].user_id;
  }
  if (userId) {
    const email = await getUserEmail(userId);
    if (email) {
      const failureReason = (invoice.last_payment_error as { message?: string } | undefined)?.message ?? "card declined";
      await sendEmail(email, "payment_failed", { email, failure_reason: failureReason });
    }
  }
}

async function handleSubscriptionUpdated(ev: { data: { object: Record<string, unknown> } }): Promise<void> {
  const sub = ev.data.object;
  const subscriptionId = sub.id as string;
  await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      status: sub.status as string,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      current_period_end: sub.current_period_end ? new Date((sub.current_period_end as number) * 1000).toISOString() : null,
    }),
  });
}

async function handleSubscriptionDeleted(ev: { data: { object: Record<string, unknown> } }): Promise<void> {
  const sub = ev.data.object;
  const subscriptionId = sub.id as string;
  await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?stripe_subscription_id=eq.${subscriptionId}`, {
    method: "PATCH",
    headers: { ...supaHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ status: "canceled" }),
  });
}

async function handleChargeRefunded(ev: { data: { object: Record<string, unknown> } }): Promise<void> {
  const charge = ev.data.object;
  const customerId = charge.customer as string | null;
  const amount = (charge.amount_refunded as number | undefined) ?? 0;
  if (!customerId) return;
  // Resolve user_id via subscriptions.
  const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?stripe_customer_id=eq.${customerId}&select=user_id`, { headers: supaHeaders });
  if (!subRes.ok) return;
  const rows = await subRes.json();
  const userId = Array.isArray(rows) && rows.length > 0 ? rows[0].user_id : null;
  if (!userId) return;

  // D-222 clawback: if any referral_credits earned with this user as
  // referee, insert offsetting kind='expired' row.
  const rmRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals_made?referred_user_id=eq.${userId}&status=eq.paying&select=id,referrer_user_id,credit_dollars_earned`, { headers: supaHeaders });
  if (rmRes.ok) {
    const refs = await rmRes.json();
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (ref.credit_dollars_earned > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/referral_credits`, {
            method: "POST",
            headers: { ...supaHeaders, Prefer: "return=minimal" },
            body: JSON.stringify({
              user_id: ref.referrer_user_id,
              amount: -Number(ref.credit_dollars_earned),
              kind: "expired",
              referral_id: ref.id,
              stripe_credit_id: charge.id as string,
            }),
          });
        }
      }
    }
  }

  const email = await getUserEmail(userId);
  if (email) {
    await sendEmail(email, "refund_processed", {
      email,
      refund_amount: `$${(amount / 100).toFixed(2)}`,
    });
  }
}

// ============================================================
// Main handler
// ============================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return new Response("missing supabase env", { status: 500 });
  if (!STRIPE_CONFIGURED || !stripe) return new Response("stripe_not_configured", { status: 503 });
  if (!WEBHOOK_SECRET) return new Response("webhook_secret_missing", { status: 503 });

  const signature = req.headers.get("Stripe-Signature");
  if (!signature) return new Response("missing_signature", { status: 400 });

  const bodyText = await req.text();
  let event;
  try {
    // Note: stripe-deno requires async constructEventAsync for SubtleCrypto.
    event = await stripe.webhooks.constructEventAsync(bodyText, signature, WEBHOOK_SECRET);
  } catch (e) {
    await logErr("verify", "signature_mismatch", e instanceof Error ? e.message : String(e), {});
    return new Response("bad_signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event); break;
      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(event); break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event); break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event); break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event); break;
      case "charge.refunded":
        await handleChargeRefunded(event); break;
      default:
        // Unhandled event types are 200-OK no-ops so Stripe doesn't retry.
        break;
    }
    return new Response(JSON.stringify({ received: true, type: event.type }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logErr("handler", "exception", msg, { event_type: event.type, event_id: event.id });
    // Return 500 so Stripe retries.
    return new Response(JSON.stringify({ error: "handler_exception", detail: msg.slice(0, 200) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
