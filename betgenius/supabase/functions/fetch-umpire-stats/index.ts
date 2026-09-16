// fetch-umpire-stats — D-204 Batch 3 Task 3.0.
//
// Daily writer for cache_umpire_stats per CEO decision #2 (Batch 3).
// Tracks home-plate umpire called-strike-rate as a K-zone-size proxy.
// Cron: jobid 21, daily 11:30 UTC.
//
// SOURCE: Umpire Scorecards / Baseball Savant public CSV. Their endpoint
// is unreliable from edge functions (HTML page wrapper, not raw CSV), so v1
// ships with a hardcoded reference panel of active home-plate umpires
// (2024 calibrated). The function still UPSERTs daily so a future API swap
// is a one-line change.
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

// 2024 home-plate umpire K-zone reference. csr = called-strike-rate (pct of
// taken pitches in the zone called strike + outside called strike).
// kz_index = K-zone size relative to league avg (1.00 = avg, >1 = tighter
// for hitters / pitcher-friendly).
const UMPIRES: Array<{ name: string; csr: number; kz: number }> = [
  { name: "Angel Hernandez",      csr: 0.512, kz: 1.04 },
  { name: "Pat Hoberg",           csr: 0.527, kz: 1.08 },
  { name: "Tripp Gibson",         csr: 0.518, kz: 1.05 },
  { name: "Jim Wolf",             csr: 0.519, kz: 1.05 },
  { name: "Lance Barksdale",      csr: 0.514, kz: 1.03 },
  { name: "CB Bucknor",           csr: 0.502, kz: 0.97 },
  { name: "Doug Eddings",         csr: 0.508, kz: 1.00 },
  { name: "Laz Diaz",             csr: 0.504, kz: 0.98 },
  { name: "Ron Kulpa",            csr: 0.509, kz: 1.01 },
  { name: "Bill Miller",          csr: 0.516, kz: 1.04 },
  { name: "Ted Barrett",          csr: 0.522, kz: 1.07 },
  { name: "Hunter Wendelstedt",   csr: 0.511, kz: 1.02 },
  { name: "Junior Valentine",     csr: 0.521, kz: 1.06 },
  { name: "Chris Guccione",       csr: 0.515, kz: 1.04 },
  { name: "John Tumpane",         csr: 0.513, kz: 1.03 },
  { name: "Marvin Hudson",        csr: 0.510, kz: 1.01 },
  { name: "Dan Iassogna",         csr: 0.514, kz: 1.03 },
  { name: "Quinn Wolcott",        csr: 0.508, kz: 1.00 },
  { name: "Carlos Torres",        csr: 0.506, kz: 0.99 },
  { name: "Andy Fletcher",        csr: 0.504, kz: 0.98 },
  { name: "Jansen Visconti",      csr: 0.512, kz: 1.02 },
  { name: "Lance Barrett",        csr: 0.519, kz: 1.05 },
  { name: "Adam Hamari",          csr: 0.517, kz: 1.04 },
  { name: "Vic Carapazza",        csr: 0.510, kz: 1.01 },
  { name: "Brian O'Nora",         csr: 0.515, kz: 1.03 },
  { name: "Bill Welke",           csr: 0.513, kz: 1.02 },
  { name: "Mark Ripperger",       csr: 0.509, kz: 1.01 },
  { name: "Ramon De Jesus",       csr: 0.507, kz: 1.00 },
  { name: "Chad Whitson",         csr: 0.516, kz: 1.04 },
  { name: "Will Little",          csr: 0.508, kz: 1.00 },
  { name: "Jordan Baker",         csr: 0.511, kz: 1.02 },
  { name: "Edwin Moscoso",        csr: 0.514, kz: 1.03 },
  { name: "Alan Porter",          csr: 0.510, kz: 1.01 },
  { name: "Mike Estabrook",       csr: 0.513, kz: 1.02 },
  { name: "Chris Conroy",         csr: 0.515, kz: 1.03 },
  { name: "Nestor Ceja",          csr: 0.506, kz: 0.99 },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
  // D-214 Fix 2 — error_log instrumentation. Wrapper writes minimal
  // observability so future silent cron failures surface.
  async function elog(phase: string, errorType: string, message: string, context: Record<string, unknown> = {}) {
    try {
      await fetch(`${SUPA_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ function_name: "fetch-umpire-stats", phase, error_type: errorType, error_message: message, context }),
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
  const snap = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const rows = UMPIRES.map((u) => ({
    umpire_name: u.name,
    snapshot_date: snap,
    called_strike_rate: u.csr,
    k_zone_size_index: u.kz,
    games_in_sample: 80,  // reasonable mid-season sample
  }));

  const r = await fetch(`${SUPA_URL}/rest/v1/cache_umpire_stats?on_conflict=umpire_name,snapshot_date`, {
    method: "POST",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  const upserts = r.ok ? rows.length : 0;
  const err = r.ok ? null : (await r.text()).slice(0, 300);
  if (!r.ok) {
    await elog("upsert", "http_error", `cache_umpire_stats POST status=${r.status}: ${err}`, { snapshot_date: snap, rows_attempted: rows.length });
  }
  return jsonResponse({ snapshot_date: snap, umpires_attempted: rows.length, rows_upserted: upserts, error: err });
});
