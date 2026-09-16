// fetch-ballpark-factors — D-204 Batch 3 Task 3.0.
//
// Weekly writer for cache_ballpark_factors per CEO decision #3 (Batch 3).
// Park factors don't move materially day-to-day; weekly Mon 11:00 UTC suffices.
// Cron: jobid 20.
//
// SOURCE: Baseball Savant publishes park factor tables — but the public CSV
// endpoint is unstable. v1 ships with a hardcoded MLB-wide reference table
// (2023-2024 rolling avgs) as a safe baseline. The function still UPSERTs
// daily so a future API swap is a one-line change.
//
// AUTH: service-role gated.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// MLB park factors — Baseball Savant 2023-2024 3-year rolling avgs.
// runs / hr / k / hits factors (1.000 = league avg). Source:
// baseballsavant.mlb.com/leaderboard/statcast-park-factors
const PARK_FACTORS: Array<{ park: string; runs: number; hr: number; k: number; hits: number; notes?: string }> = [
  { park: "Coors Field", runs: 1.118, hr: 1.115, k: 0.953, hits: 1.075, notes: "altitude — biggest run inflator" },
  { park: "Great American Ball Park", runs: 1.054, hr: 1.142, k: 0.991, hits: 1.018 },
  { park: "Globe Life Field", runs: 1.047, hr: 1.063, k: 0.985, hits: 1.027 },
  { park: "Yankee Stadium", runs: 1.039, hr: 1.118, k: 0.987, hits: 1.014, notes: "short RF porch" },
  { park: "Citizens Bank Park", runs: 1.034, hr: 1.090, k: 0.993, hits: 1.011 },
  { park: "Fenway Park", runs: 1.028, hr: 0.948, k: 0.978, hits: 1.046, notes: "Green Monster lifts doubles" },
  { park: "Wrigley Field", runs: 1.022, hr: 1.043, k: 0.997, hits: 1.013 },
  { park: "Rogers Centre", runs: 1.018, hr: 1.044, k: 1.005, hits: 1.005 },
  { park: "Truist Park", runs: 1.012, hr: 1.022, k: 0.998, hits: 1.007 },
  { park: "Nationals Park", runs: 1.008, hr: 1.012, k: 1.001, hits: 1.005 },
  { park: "Chase Field", runs: 1.006, hr: 1.018, k: 1.003, hits: 1.001 },
  { park: "Minute Maid Park", runs: 1.003, hr: 1.034, k: 1.000, hits: 0.998 },
  { park: "American Family Field", runs: 1.001, hr: 1.041, k: 1.004, hits: 0.994 },
  { park: "loanDepot park", runs: 0.997, hr: 0.929, k: 1.006, hits: 1.011 },
  { park: "Busch Stadium", runs: 0.994, hr: 0.948, k: 1.001, hits: 1.006 },
  { park: "Comerica Park", runs: 0.993, hr: 0.901, k: 1.003, hits: 1.018 },
  { park: "Target Field", runs: 0.989, hr: 0.967, k: 1.005, hits: 1.002 },
  { park: "PNC Park", runs: 0.986, hr: 0.925, k: 1.007, hits: 1.012 },
  { park: "Citi Field", runs: 0.984, hr: 0.951, k: 1.006, hits: 1.001 },
  { park: "Progressive Field", runs: 0.981, hr: 0.952, k: 1.009, hits: 0.996 },
  { park: "Angel Stadium", runs: 0.978, hr: 0.989, k: 1.010, hits: 0.991 },
  { park: "Guaranteed Rate Field", runs: 0.975, hr: 1.014, k: 1.011, hits: 0.984 },
  { park: "Kauffman Stadium", runs: 0.972, hr: 0.881, k: 1.014, hits: 1.011 },
  { park: "Dodger Stadium", runs: 0.968, hr: 1.001, k: 1.013, hits: 0.978 },
  { park: "Oakland Coliseum", runs: 0.963, hr: 0.918, k: 1.018, hits: 0.984 },
  { park: "T-Mobile Park", runs: 0.958, hr: 0.957, k: 1.021, hits: 0.973 },
  { park: "Tropicana Field", runs: 0.954, hr: 0.971, k: 1.026, hits: 0.964 },
  { park: "Petco Park", runs: 0.948, hr: 0.928, k: 1.024, hits: 0.971 },
  { park: "Oracle Park", runs: 0.931, hr: 0.819, k: 1.029, hits: 0.974, notes: "marine layer, deep CF" },
  { park: "Camden Yards", runs: 0.967, hr: 0.913, k: 1.013, hits: 0.997, notes: "post-2022 LF wall move" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
  // D-214 Fix 2 — error_log instrumentation.
  async function elog(phase: string, errorType: string, message: string, context: Record<string, unknown> = {}) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ function_name: "fetch-ballpark-factors", phase, error_type: errorType, error_message: message, context }),
      });
    } catch { /* swallow */ }
  }

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPA_KEY)) {
    await elog("auth", "unauthorized", "missing or wrong Bearer token", { bearer_prefix: bearer.slice(0, 8) });
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const today = new Date();
  const refresh = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = PARK_FACTORS.map((p) => ({
    park_name: p.park,
    runs_factor: p.runs,
    hr_factor: p.hr,
    k_factor: p.k,
    hits_factor: p.hits,
    refresh_date: refresh,
    notes: p.notes ?? null,
  }));

  const r = await fetch(`${SUPA_URL}/rest/v1/cache_ballpark_factors?on_conflict=park_name`, {
    method: "POST",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  const upserts = r.ok ? rows.length : 0;
  const err = r.ok ? null : (await r.text()).slice(0, 300);
  if (!r.ok) {
    await elog("upsert", "http_error", `cache_ballpark_factors POST status=${r.status}: ${err}`, { rows_attempted: rows.length });
  }
  return jsonResponse({ refresh_date: refresh, parks_attempted: rows.length, rows_upserted: upserts, error: err });
});
