// customer-portal-session — D-220 Task 6.1.
//
// Returns a Stripe Customer Portal URL for the authenticated subscriber
// to manage their subscription (update payment, cancel, view invoices).
// Portal config + branding per arch §10.8 (managed in Stripe Dashboard).
//
// Auth: user JWT required.
// Body: empty.
// Returns: { url: string } on success.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { stripe, STRIPE_CONFIGURED } from "../_shared/stripe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "https://betgenius-eight.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function getUserFromBearer(bearer: string): Promise<{ id: string } | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u?.id) return null;
    return { id: u.id };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!bearer) return jsonResponse({ error: "missing_auth" }, 401);
  const user = await getUserFromBearer(bearer);
  if (!user) return jsonResponse({ error: "invalid_session" }, 401);

  if (!STRIPE_CONFIGURED || !stripe) return jsonResponse({ error: "stripe_not_configured" }, 503);

  // Look up customer_id from subscriptions.
  const subRes = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${user.id}&select=stripe_customer_id&limit=1`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    },
  );
  if (!subRes.ok) return jsonResponse({ error: "subs_lookup_failed" }, 500);
  const rows = await subRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return jsonResponse({ error: "no_subscription_found", code: "NO_SUB" }, 404);
  }
  const customerId = rows[0].stripe_customer_id;
  if (!customerId) return jsonResponse({ error: "missing_customer_id" }, 500);

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL}/?settings=subscription`,
    });
    return jsonResponse({ url: portal.url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: "stripe_error", detail: msg.slice(0, 300) }, 502);
  }
});
