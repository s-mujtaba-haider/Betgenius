import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface CheckResult {
  name: string;
  status: "pass" | "fail";
  latency_ms: number;
  details?: string;
}

async function logApiUsage(endpoint: string, httpStatus: number, headers: Headers | null, context: Record<string, unknown> = {}, eventCount: number | null = null): Promise<void> {
  try {
    const used = parseInt(headers?.get("x-requests-used") || "0", 10);
    const remaining = parseInt(headers?.get("x-requests-remaining") || "0", 10);
    const last = parseInt(headers?.get("x-requests-last") || "0", 10);
    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !key) return;
    await fetch(url + "/rest/v1/api_usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key, "Prefer": "return=minimal" },
      body: JSON.stringify({
        function_name: "health-check",
        endpoint, http_status: httpStatus,
        requests_used: isNaN(used) ? null : used,
        requests_remaining: isNaN(remaining) ? null : remaining,
        requests_last: isNaN(last) ? null : last,
        event_count: eventCount, context,
      }),
    });
  } catch (_err) { /* non-fatal */ }
}

async function checkESPN(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();
    const events = (data as { events?: unknown[] }).events?.length ?? 0;
    return { name: "ESPN Scoreboard", status: res.ok ? "pass" : "fail", latency_ms: Date.now() - start, details: `${events} games found` };
  } catch (err) {
    return { name: "ESPN Scoreboard", status: "fail", latency_ms: Date.now() - start, details: err instanceof Error ? err.message : String(err) };
  }
}

async function checkESPNTeamStats(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/statistics",
      { signal: AbortSignal.timeout(5000) }
    );
    const text = await res.text();
    return { name: "ESPN Team Stats (oppStats)", status: res.ok && text.length > 100 ? "pass" : "fail", latency_ms: Date.now() - start, details: `Status: ${res.status}, size: ${text.length} bytes` };
  } catch (err) {
    return { name: "ESPN Team Stats (oppStats)", status: "fail", latency_ms: Date.now() - start, details: err instanceof Error ? err.message : String(err) };
  }
}

async function checkOddsAPI(): Promise<CheckResult> {
  const start = Date.now();
  const apiKey = Deno.env.get("THE_ODDS_API_KEY");
  if (!apiKey) return { name: "Odds API", status: "fail", latency_ms: 0, details: "No API key set" };
  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${apiKey}&regions=us&markets=player_points&oddsFormat=american&bookmakers=hard_rock_bet`,
      { signal: AbortSignal.timeout(5000) }
    );
    await logApiUsage("odds_player_points", res.status, res.headers, { source: "health-check" });
    const remaining = res.headers.get("x-requests-remaining");
    return { name: "Odds API", status: res.ok ? "pass" : "fail", latency_ms: Date.now() - start, details: `Status: ${res.status}, requests remaining: ${remaining}` };
  } catch (err) {
    await logApiUsage("odds_player_points", 0, null, { source: "health-check", error: err instanceof Error ? err.message : String(err) });
    return { name: "Odds API", status: "fail", latency_ms: Date.now() - start, details: err instanceof Error ? err.message : String(err) };
  }
}

async function checkGemini(): Promise<CheckResult> {
  const start = Date.now();
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return { name: "Gemini AI", status: "fail", latency_ms: 0, details: "No API key set" };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with only the word OK" }] }] }),
        signal: AbortSignal.timeout(10000),
      }
    );
    return { name: "Gemini AI", status: res.ok ? "pass" : "fail", latency_ms: Date.now() - start, details: `Status: ${res.status}` };
  } catch (err) {
    return { name: "Gemini AI", status: "fail", latency_ms: Date.now() - start, details: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSupabase(): Promise<CheckResult> {
  const start = Date.now();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { name: "Supabase DB", status: "fail", latency_ms: 0, details: "Missing env vars" };
  try {
    const res = await fetch(`${url}/rest/v1/pick_history?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    return { name: "Supabase DB", status: res.ok ? "pass" : "fail", latency_ms: Date.now() - start, details: `Status: ${res.status}` };
  } catch (err) {
    return { name: "Supabase DB", status: "fail", latency_ms: Date.now() - start, details: err instanceof Error ? err.message : String(err) };
  }
}

async function checkRecentRuns(): Promise<CheckResult> {
  const start = Date.now();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { name: "Recent Runs", status: "fail", latency_ms: 0, details: "Missing env vars" };
  try {
    const res = await fetch(
      `${url}/rest/v1/run_log?select=created_at,status,recommendations,errors_count&order=created_at.desc&limit=3`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { name: "Recent Runs", status: "fail", latency_ms: Date.now() - start, details: "Table may not exist yet" };
    const runs = await res.json() as Array<{status: string; recommendations: number; errors_count: number}>;
    return {
      name: "Recent Runs",
      status: runs.length > 0 ? "pass" : "fail",
      latency_ms: Date.now() - start,
      details: runs.length > 0 ? `Last: ${runs[0].status}, ${runs[0].recommendations} picks, ${runs[0].errors_count} errors` : "No runs logged yet",
    };
  } catch (err) {
    return { name: "Recent Runs", status: "fail", latency_ms: Date.now() - start, details: err instanceof Error ? err.message : String(err) };
  }
}

async function checkUnresolvedErrors(): Promise<CheckResult> {
  const start = Date.now();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { name: "Unresolved Errors", status: "fail", latency_ms: 0, details: "Missing env vars" };
  try {
    const res = await fetch(
      `${url}/rest/v1/error_log?select=id&resolved=eq.false`,
      { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" }, signal: AbortSignal.timeout(5000) }
    );
    const count = parseInt(res.headers.get("content-range")?.split("/")[1] ?? "0", 10);
    return { name: "Unresolved Errors", status: count === 0 ? "pass" : "fail", latency_ms: Date.now() - start, details: `${count} unresolved errors` };
  } catch (err) {
    return { name: "Unresolved Errors", status: "fail", latency_ms: Date.now() - start, details: err instanceof Error ? err.message : String(err) };
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const checks = await Promise.all([
    checkESPN(), checkESPNTeamStats(), checkOddsAPI(), checkGemini(), checkSupabase(), checkRecentRuns(), checkUnresolvedErrors(),
  ]);

  const passed = checks.filter(c => c.status === "pass").length;
  const failed = checks.filter(c => c.status === "fail").length;
  const overall = failed === 0 ? "HEALTHY" : failed <= 2 ? "DEGRADED" : "UNHEALTHY";

  return new Response(JSON.stringify({ status: overall, timestamp: new Date().toISOString(), summary: `${passed}/${checks.length} passed`, checks }, null, 2), {
    status: overall === "UNHEALTHY" ? 503 : 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
