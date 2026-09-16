// fetch-mlb-pitcher-inn1-daily — D-669 SHIP 1.
// Daily writer for cache_mlb_pitcher_inn1. Source: MLB Stats API
// /people/{id}/stats?stats=statSplits&group=pitching&sitCodes=i01
// Pulled per today's + tomorrow's probable SPs (via /schedule?hydrate=probablePitcher).
// Drives score_first_inning_trouble_v2 in scorePitcherOuts (D-668 D7).
//
// Cron: daily 11:30 UTC (after D-664 pitcher-pen-extras 11:00 UTC, before
// pregame 13:00 UTC). Bounded compute: ~60 probable SPs × 1 call.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
const GAP_MS = 350;
let lastMs = 0;

async function mlbFetch<T>(path: string): Promise<T | null> {
  const wait = Math.max(0, GAP_MS - (Date.now() - lastMs));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastMs = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await fetch(`${MLB_API}${path}`, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
  finally { clearTimeout(t); }
}

function parseIp(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw);
  const [whole, third] = s.split(".");
  const w = Number(whole) || 0;
  const t = Number(third) || 0;
  return w + (t === 1 ? 0.333 : t === 2 ? 0.667 : 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

  async function elog(phase: string, errorType: string, message: string, context: Record<string, unknown> = {}) {
    try {
      if (!SUPA_URL || !SUPA_KEY) return;
      await fetch(`${SUPA_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ function_name: "fetch-mlb-pitcher-inn1-daily", phase, error_type: errorType, error_message: message, context }),
      });
    } catch { /* swallow */ }
  }

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPA_KEY)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const t0 = Date.now();
  const today = new Date();
  const eastern = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const season = new Date(eastern + "T12:00:00Z").getFullYear();

  // Get today's + tomorrow's probable SPs via schedule.
  const schedRes = await mlbFetch<{ dates: Array<{ games: Array<{ teams: { home: { probablePitcher?: { id: number } }; away: { probablePitcher?: { id: number } } } }> }> }>(
    `/schedule?sportId=1&startDate=${eastern}&endDate=${tomorrow}&hydrate=probablePitcher`,
  );
  const probableIds = new Set<number>();
  for (const d of schedRes?.dates ?? []) {
    for (const g of d.games ?? []) {
      const h = g.teams?.home?.probablePitcher?.id;
      const a = g.teams?.away?.probablePitcher?.id;
      if (h) probableIds.add(h);
      if (a) probableIds.add(a);
    }
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const pid of probableIds) {
    // D-761 — single API call now requests BOTH i01 (1st-inning trouble per
    // D-669 SHIP 1) AND i06 (3rd-time-through-order, research-validated early-
    // hook trigger for pitcher_outs unders per D-760's structural finding).
    const sp = await mlbFetch<{ stats: Array<{ splits: Array<{ split: { code?: string }; stat: Record<string, unknown> }> }> }>(
      `/people/${pid}/stats?stats=statSplits&group=pitching&sitCodes=i01,i06&season=${season}&sportIds=1`,
    );
    const splits = sp?.stats?.[0]?.splits ?? [];
    const i01 = splits.find((sp_) => sp_?.split?.code === "i01");
    const i06 = splits.find((sp_) => sp_?.split?.code === "i06");
    if (!i01) continue;  // i01 still gates the row write; i06 is optional addition
    const stat = i01.stat ?? {};
    const ip = parseIp(stat.inningsPitched);
    if (ip < 1.0) continue;  // require ≥1 inning before we trust the rate
    let i06Era: number | null = null, i06Ip: number | null = null, i06Bf: number | null = null, i06Ops: number | null = null;
    if (i06) {
      const s6 = i06.stat ?? {};
      const ip6 = parseIp(s6.inningsPitched);
      if (ip6 >= 1.0) {
        i06Era = s6.era !== undefined && s6.era !== null ? Number(s6.era) : null;
        i06Ip = Math.round(ip6 * 10) / 10;
        i06Bf = s6.battersFaced !== undefined && s6.battersFaced !== null ? Number(s6.battersFaced) : null;
        // MLB API returns ops as a string like ".408" — Number(".408") = 0.408
        i06Ops = s6.ops !== undefined && s6.ops !== null ? Number(s6.ops) : null;
      }
    }
    rows.push({
      player_id: pid,
      snapshot_date: eastern,
      inn1_era: stat.era !== undefined && stat.era !== null ? Number(stat.era) : null,
      inn1_ip: Math.round(ip * 10) / 10,
      inn1_bf: stat.battersFaced !== undefined && stat.battersFaced !== null ? Number(stat.battersFaced) : null,
      inn1_runs: stat.runs !== undefined && stat.runs !== null ? Number(stat.runs) : null,
      inn1_walks: stat.baseOnBalls !== undefined && stat.baseOnBalls !== null ? Number(stat.baseOnBalls) : null,
      inn1_hits: stat.hits !== undefined && stat.hits !== null ? Number(stat.hits) : null,
      inn1_pitches: stat.numberOfPitches !== undefined && stat.numberOfPitches !== null ? Number(stat.numberOfPitches) : null,
      // D-761 — 3rd-time-through-order columns
      i06_era: i06Era,
      i06_ip: i06Ip,
      i06_bf: i06Bf,
      i06_ops: i06Ops,
    });
  }

  let upserted = 0;
  if (rows.length > 0) {
    const r = await fetch(`${SUPA_URL}/rest/v1/cache_mlb_pitcher_inn1?on_conflict=player_id,snapshot_date`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (r.ok) upserted = rows.length;
    else {
      const eb = await r.text();
      await elog("upsert", "http_error", `cache_mlb_pitcher_inn1 POST status=${r.status}: ${eb.slice(0, 300)}`, { eastern, rows_attempted: rows.length });
    }
  }

  return jsonResponse({
    success: true,
    snapshot_date: eastern,
    probables_seen: probableIds.size,
    rows_upserted: upserted,
    elapsed_ms: Date.now() - t0,
  });
});
