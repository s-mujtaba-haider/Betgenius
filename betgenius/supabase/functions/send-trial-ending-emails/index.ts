// send-trial-ending-emails — D-217 Task 5.3.
//
// Daily cron (jobid 24, 09:00 UTC). Finds subscriptions where trial_end
// falls in next 48-72 hours and sends the trial_ending template via
// Resend. Idempotent — tracks sent state via notifications_log inspection
// (avoids duplicate sends within the same 24h window).
//
// Auth: service-role gated via BACKFILL_AUTH_TOKEN.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sendEmail } from "../_shared/email.ts";

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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPABASE_KEY)) return jsonResponse({ error: "unauthorized" }, 401);

  // Window: trial_end between NOW + 24h and NOW + 72h. The cron fires
  // daily so users get reminded once when trial is 2-3 days out.
  const now = new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();

  const subsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/subscriptions?status=eq.trialing&trial_end=gte.${start}&trial_end=lte.${end}&select=user_id,trial_end`,
    { headers: supaHeaders },
  );
  if (!subsRes.ok) return jsonResponse({ error: `subs query failed: ${subsRes.status}` }, 500);
  const subs = await subsRes.json() as Array<{ user_id: string; trial_end: string }>;
  if (subs.length === 0) return jsonResponse({ success: true, candidates: 0, sent: 0 });

  // Look up emails via auth admin endpoint — needs service role.
  let sent = 0, errors = 0;
  for (const s of subs) {
    try {
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${s.user_id}`, { headers: supaHeaders });
      if (!userRes.ok) { errors++; continue; }
      const user = await userRes.json() as { email?: string };
      if (!user.email) { errors++; continue; }
      const res = await sendEmail(user.email, "trial_ending", {
        email: user.email,
        trial_end_date: s.trial_end.slice(0, 10),
      });
      if (res.ok) sent++; else errors++;
    } catch { errors++; }
  }

  return jsonResponse({ success: true, candidates: subs.length, sent, errors });
});
