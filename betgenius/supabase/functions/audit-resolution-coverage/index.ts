// audit-resolution-coverage — D-275-AUDIT-GAP.
//
// Closes the D-265 audit-spec gap that allowed D-274 to surface the
// resolve-picks-MLB silent failure (3,351 unresolved MLB picks).
// Runs daily after final resolve-picks tick. Counts created vs
// resolved picks per sport per day (last 14 days). Alerts via
// notifications_log if any sport has >10% unresolved picks older
// than 24 hours.
//
// AUTH: service-role gated.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const supaHeaders = (): Record<string, string> => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

async function countPicks(sport: string, sinceDate: string, resolvedFilter: "all" | "resolved" | "unresolved", upToDate?: string): Promise<number> {
  let filter = "";
  if (resolvedFilter === "resolved") filter = "&hit=not.is.null";
  if (resolvedFilter === "unresolved") filter = "&hit=is.null&voided=neq.true";
  // D-276-AUDIT-THRESHOLD (2026-05-20): caller can pass upToDate to
  // exclude future-dated picks from the denominator. The pre-D-276
  // version included future games in `total`, making coverage_pct
  // misleading (MLB showed 16.1% mostly because the slate-day batch
  // hadn't completed yet).
  const upToFilter = upToDate ? `&game_date=lte.${upToDate}` : "";
  const url = `${SUPABASE_URL}/rest/v1/pick_history?sport=eq.${sport}&game_date=gte.${sinceDate}${upToFilter}${filter}&select=count`;
  try {
    const res = await fetch(url, { headers: { ...supaHeaders(), Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" } });
    const cr = res.headers.get("content-range") || "0/0";
    const total = cr.split("/")[1];
    return parseInt(total) || 0;
  } catch (_e) { return 0; }
}

// Older than 24h means picks whose game_date is yesterday or earlier
// (today's picks are expected to be unresolved until games finish).
async function countStaleUnresolved(sport: string, sinceDate: string, yesterday: string): Promise<number> {
  const url = `${SUPABASE_URL}/rest/v1/pick_history?sport=eq.${sport}&game_date=gte.${sinceDate}&game_date=lte.${yesterday}&hit=is.null&voided=neq.true&select=count`;
  try {
    const res = await fetch(url, { headers: { ...supaHeaders(), Prefer: "count=exact", "Range-Unit": "items", Range: "0-0" } });
    const cr = res.headers.get("content-range") || "0/0";
    return parseInt(cr.split("/")[1]) || 0;
  } catch (_e) { return 0; }
}

async function logToNotifications(severity: string, title: string, message: string, metadata: Record<string, unknown>): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/notifications_log`, {
      method: "POST",
      headers: { ...supaHeaders(), Prefer: "return=minimal" },
      body: JSON.stringify({
        severity,
        title,
        message,
        metadata,
        delivered_via: "log",
      }),
    });
  } catch { /* swallow */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse({ success: false, error: "missing env" }, 500);

  const auth = req.headers.get("authorization") || "";
  const matches = auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN));
  if (!matches) return jsonResponse({ success: false, error: "unauthorized" }, 401);

  const start = Date.now();

  // 14-day lookback window
  const now = new Date();
  const sinceDate = new Date(now.getTime() - 14 * 86400_000).toISOString().slice(0, 10);
  const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const today = easternNow.toISOString().slice(0, 10);
  const yesterday = new Date(easternNow.getTime() - 86400_000).toISOString().slice(0, 10);

  const sports = ["nba", "mlb"];
  const perSport: Record<string, { total: number; total_eligible: number; resolved: number; unresolved: number; stale_unresolved: number; coverage_pct: number; coverage_pct_eligible: number; stale_pct: number; alert: boolean }> = {};
  const alerts: string[] = [];

  for (const sport of sports) {
    // D-276-AUDIT-THRESHOLD: split metric into (a) total picks in 14d
    // window vs (b) eligible-for-resolution picks (game_date <=
    // yesterday). Coverage % computed against eligible — that's the
    // honest "is the resolver keeping up with completed games" stat.
    // total stays as a denominator for visibility.
    const [total, totalEligible, resolved, unresolved, stale] = await Promise.all([
      countPicks(sport, sinceDate, "all"),                          // entire 14d window
      countPicks(sport, sinceDate, "all", yesterday),               // 14d window cap at yesterday
      countPicks(sport, sinceDate, "resolved", yesterday),          // resolved within eligible window
      countPicks(sport, sinceDate, "unresolved", yesterday),        // unresolved within eligible window
      countStaleUnresolved(sport, sinceDate, yesterday),
    ]);
    const coverage = total > 0 ? Math.round((resolved / total) * 1000) / 10 : 0;
    const coverageEligible = totalEligible > 0 ? Math.round((resolved / totalEligible) * 1000) / 10 : 0;
    const stalePctNum = totalEligible > 0 ? (stale / totalEligible) * 100 : 0;
    const stalePct = Math.round(stalePctNum * 10) / 10;
    const alertOnSport = stalePctNum > 10 && stale >= 20; // alert against ELIGIBLE denominator
    perSport[sport] = { total, total_eligible: totalEligible, resolved, unresolved, stale_unresolved: stale, coverage_pct: coverage, coverage_pct_eligible: coverageEligible, stale_pct: stalePct, alert: alertOnSport };
    if (alertOnSport) {
      const msg = `${sport.toUpperCase()} resolution coverage gap: ${stale} stale unresolved picks (${stalePct}% of 14d window). Investigate resolve-picks for sport=${sport}.`;
      alerts.push(msg);
      await logToNotifications("critical", `resolve-picks coverage gap on ${sport}`, msg, { sport, stale, total, since: sinceDate });
    }
  }

  const durationMs = Date.now() - start;
  await writeHeartbeat({ jobName: "audit-resolution-coverage", status: alerts.length > 0 ? "partial" : "success", durationMs, error: alerts.length > 0 ? alerts.join(" | ") : null });

  return jsonResponse({
    success: true,
    audit_window_days: 14,
    since_date: sinceDate,
    today, yesterday,
    per_sport: perSport,
    alerts,
    duration_ms: durationMs,
  });
});
