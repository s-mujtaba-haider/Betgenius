// fetch-savant-team-chase-weekly — D-669 SHIP 2.
// Weekly writer for cache_savant_team_chase. Source: Baseball Savant
// /leaderboard/custom?selections=oz_swing_percent,z_swing_percent&player_type=batter&csv=true
// + MLB Stats API roster lookup to aggregate to team level.
// Drives score_opp_chase_rate_v2 in scorePitcherOuts (D-668 O5 dequeued).
//
// Cron: weekly Sunday 9 AM UTC. Bounded compute: 1 Savant fetch (~530 players)
// + 30 MLB Stats roster fetches. Throttled 350ms/call.

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

// CSV parser — same as fetch-baseball-savant-weekly.
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return { headers, rows: lines.slice(1).map(parseLine) };
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === null || s === "" || s === "—") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
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
        body: JSON.stringify({ function_name: "fetch-savant-team-chase-weekly", phase, error_type: errorType, error_message: message, context }),
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
  const year = new Date(eastern + "T12:00:00Z").getFullYear();

  // STEP 1 — fetch all player chase rates from Savant.
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&player_type=batter&selections=oz_swing_percent,z_swing_percent&min=50&csv=true`;
  let csvText = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "SharpAI/1.0 (+sharpai.bet)" } });
    if (!res.ok) {
      await elog("savant", "http_error", `Savant chase CSV HTTP ${res.status}`, { url });
      return jsonResponse({ error: "savant fetch failed", http: res.status }, 502);
    }
    csvText = await res.text();
  } catch (e) {
    await elog("savant", "fetch_throw", String(e), { url });
    return jsonResponse({ error: "savant fetch throw" }, 502);
  }
  const { headers, rows } = parseCsv(csvText);
  const ozIdx = headers.indexOf("oz_swing_percent");
  const zIdx = headers.indexOf("z_swing_percent");
  const pidIdx = headers.indexOf("player_id");
  if (pidIdx < 0 || ozIdx < 0) {
    await elog("savant", "schema_mismatch", `headers=${headers.slice(0,8).join(",")}`, { headers });
    return jsonResponse({ error: "Savant CSV missing player_id or oz_swing_percent", headers }, 502);
  }
  const playerChase = new Map<number, { oz: number | null; z: number | null }>();
  for (const r of rows) {
    const pid = Number(r[pidIdx]) || 0;
    if (pid <= 0) continue;
    playerChase.set(pid, { oz: num(r[ozIdx]), z: zIdx >= 0 ? num(r[zIdx]) : null });
  }

  // STEP 2 — fetch all 30 team rosters and aggregate.
  const teamsRes = await mlbFetch<{ teams: Array<{ id: number; name: string }> }>(`/teams?sportId=1`);
  if (!teamsRes?.teams) {
    await elog("teams_list", "http_error", "MLB Stats API /teams?sportId=1 returned no teams", { eastern });
    return jsonResponse({ error: "teams fetch failed" }, 502);
  }
  const teams = teamsRes.teams.filter((t) => t.id < 1000);

  const teamRows: Array<Record<string, unknown>> = [];
  for (const team of teams) {
    const rosterRes = await mlbFetch<{ roster: Array<{ person: { id: number; fullName: string }; position?: { code?: string } }> }>(
      `/teams/${team.id}/roster?rosterType=active`,
    );
    const batters = (rosterRes?.roster ?? []).filter((p) => p.position?.code !== "1");
    let ozSum = 0, ozN = 0, zSum = 0, zN = 0;
    for (const b of batters) {
      const ch = playerChase.get(b.person.id);
      if (!ch) continue;
      if (ch.oz !== null) { ozSum += ch.oz; ozN += 1; }
      if (ch.z !== null) { zSum += ch.z; zN += 1; }
    }
    teamRows.push({
      team_id: team.id,
      team_name: team.name,
      snapshot_date: eastern,
      oz_swing_avg: ozN > 0 ? Math.round((ozSum / ozN) * 100) / 100 : null,
      z_swing_avg: zN > 0 ? Math.round((zSum / zN) * 100) / 100 : null,
      n_players: ozN,
    });
  }

  let upserted = 0;
  if (teamRows.length > 0) {
    const r = await fetch(`${SUPA_URL}/rest/v1/cache_savant_team_chase?on_conflict=team_id,snapshot_date`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(teamRows),
    });
    if (r.ok) upserted = teamRows.length;
    else {
      const eb = await r.text();
      await elog("upsert", "http_error", `cache_savant_team_chase POST status=${r.status}: ${eb.slice(0, 300)}`, { eastern, rows_attempted: teamRows.length });
    }
  }

  return jsonResponse({
    success: true,
    snapshot_date: eastern,
    player_chase_rows: playerChase.size,
    team_rows_upserted: upserted,
    elapsed_ms: Date.now() - t0,
  });
});
