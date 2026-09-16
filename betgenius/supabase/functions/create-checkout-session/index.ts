// create-checkout-session — D-220 Task 6.1.
//
// Subscriber-initiated Stripe Checkout session creator. JWT verified
// (verify_jwt = true at deploy). Reads user from session, validates
// requested plan, calls Stripe checkout.sessions.create, returns
// checkout URL.
//
// Auth: user JWT — subscriber must be authenticated.
// Body: { plan: PlanName, attribution?: { ref_code?: string, invite_code?: string, referrer_source?: string } }
// Returns: { url: string } on success | { error: string, code?: string } on failure.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { stripe, STRIPE_CONFIGURED, isValidPlan, resolvePriceId, trialDaysForPlan, type PlanName } from "../_shared/stripe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://betgenius-eight.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function getUserFromBearer(bearer: string): Promise<{ id: string; email: string } | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u?.id || !u?.email) return null;
    return { id: u.id, email: u.email };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth — must be a real user session JWT, not anon, not service-role.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!bearer) return jsonResponse({ error: "missing_auth" }, 401);
  const user = await getUserFromBearer(bearer);
  if (!user) return jsonResponse({ error: "invalid_session" }, 401);

  if (!STRIPE_CONFIGURED || !stripe) {
    return jsonResponse({ error: "stripe_not_configured", code: "STRIPE_NOT_CONFIGURED" }, 503);
  }

  let body: { plan?: string; attribution?: { ref_code?: string; invite_code?: string; referrer_source?: string } } = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const plan = body.plan;
  if (!plan || !isValidPlan(plan)) {
    return jsonResponse({ error: "invalid_plan", code: "INVALID_PLAN" }, 400);
  }
  const priceId = resolvePriceId(plan as PlanName);
  if (!priceId) {
    return jsonResponse({
      error: "price_id_missing",
      code: "PRICE_ID_MISSING",
      detail: `STRIPE_PRICE_ID_${plan.toUpperCase()} not set in Supabase secrets`,
    }, 503);
  }

  const trialDays = trialDaysForPlan(plan as PlanName);
  const attribution = body.attribution ?? {};

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.email,
      automatic_tax: { enabled: true },
      success_url: `${APP_URL}/?welcome=true&checkout=success`,
      cancel_url: `${APP_URL}/?subscribe=true&checkout=canceled`,
      metadata: {
        user_id: user.id,
        plan,
        ref_code: attribution.ref_code ?? "",
        invite_code: attribution.invite_code ?? "",
        referrer_source: attribution.referrer_source ?? "direct",
      },
      // Surface user_id + attribution on the subscription itself too so
      // the webhook doesn't have to dereference session metadata for
      // renewal events. Trial period (when applicable) goes here.
      subscription_data: {
        ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
        metadata: {
          user_id: user.id,
          plan,
          ref_code: attribution.ref_code ?? "",
          invite_code: attribution.invite_code ?? "",
        },
      },
    });

    return jsonResponse({ url: session.url, session_id: session.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: "stripe_error", detail: msg.slice(0, 300) }, 502);
  }
});
