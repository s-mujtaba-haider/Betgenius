// send-daily-digest — D-223 Task 6.4 + arch §5.1 jobid 16.
//
// Daily 13:00 UTC. Sends daily_digest template to subscribers with
// email_notifications=true. Body includes today's 70+ tier pick count
// + top pick summary + rolling-30d calibration WR.
//
// Auth: service-role.
// Idempotent per-day: subscribers should receive at most one digest
// per day (cron schedule enforces this).

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

function todayYyyymmddEt(): string {
  // ET-anchored YYYYMMDD per Dashboard's etGameDateYmd convention.
  // 13:00 UTC = 9 AM ET — well after the noon-ET process-games run.
  const now = new Date();
  const etStr = now.toLocaleString("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return etStr.replace(/-/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPABASE_KEY)) return jsonResponse({ error: "unauthorized" }, 401);

  const today = todayYyyymmddEt();

  // Today's 70+ tier picks (subscriber-facing — recommendation_shown=true).
  const picksRes = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_history?game_date=eq.${today}&confidence=gte.70&recommendation_shown=eq.true&voided=eq.false&hit=is.null&order=confidence.desc&limit=3&select=player_name,prop_type,line,pick_side,confidence,verdict`,
    { headers: supaHeaders },
  );
  const picks = picksRes.ok ? await picksRes.json() : [];

  // Pick count
  const cntRes = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_history?game_date=eq.${today}&confidence=gte.70&recommendation_shown=eq.true&voided=eq.false&hit=is.null&select=id`,
    { headers: { ...supaHeaders, Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" } },
  );
  const cnt = cntRes.ok ? parseInt((cntRes.headers.get("content-range") ?? "0/0").split("/")[1] ?? "0", 10) : 0;

  // Rolling 30d calibration
  const calibRes = await fetch(`${SUPABASE_URL}/rest/v1/calibration_snapshots?metric_type=eq.rolling_30d_70plus_wr&order=snapshot_date.desc&limit=1&select=wr_pct`, { headers: supaHeaders });
  const calib = calibRes.ok ? await calibRes.json() : null;
  const calibPct = calib?.[0]?.wr_pct ?? null;

  const topPick = picks?.[0];
  const topPickSummary = topPick
    ? `${topPick.player_name} ${topPick.pick_side} ${topPick.line} ${topPick.prop_type} (${topPick.confidence} ${topPick.verdict})`
    : null;

  // Find opted-in subscribers. user_preferences.email_notifications=true.
  // Join to auth.users for email.
  const prefRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?email_notifications=eq.true&select=user_id`,
    { headers: supaHeaders },
  );
  if (!prefRes.ok) return jsonResponse({ error: "prefs_query_failed" }, 500);
  const prefs = await prefRes.json() as Array<{ user_id: string }>;
  if (prefs.length === 0) return jsonResponse({ success: true, recipients: 0, picks_today: cnt });

  let sent = 0, errors = 0;
  for (const p of prefs) {
    try {
      const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.user_id}`, { headers: supaHeaders });
      if (!uRes.ok) { errors++; continue; }
      const u = await uRes.json();
      if (!u?.email) { errors++; continue; }
      const res = await sendEmail(u.email, "daily_digest", {
        email: u.email,
        picks_today: cnt,
        top_pick_summary: topPickSummary ?? undefined,
        calibration_pct: calibPct ?? undefined,
      });
      if (res.ok) sent++; else errors++;
    } catch { errors++; }
  }

  return jsonResponse({ success: true, recipients: prefs.length, sent, errors, picks_today: cnt, top_pick: topPickSummary });
});
