// fetch-pitcher-csw — D-749.
//
// Pulls per-pitcher CSW% (Called Strike + Whiff %) from Baseball Savant's
// custom leaderboard CSV and upserts into cache_statcast_pitcher_arsenal.
//
// CSW% = (called_strike + swinging_strike) / total_pitches. The single most
// predictive K metric per public research; league avg ~30%, elite 35%+.
// Distinct from D-666's score_pitcher_whiff_skill_v2 (which reads
// expected_whiff_pct, currently NULL across the cache → factor fires 0%).
//
// Endpoint (verified D-749 probe):
//   /leaderboard/custom?year=YYYY&type=pitcher&min=q
//     &selections=p_total_pitches,p_called_strike,p_swinging_strike&csv=true
//
// AUTH: service_role via BACKFILL_AUTH_TOKEN.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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

const supaHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

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
function int(s: string | undefined): number | null {
  if (s === undefined || s === null || s === "") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

async function ingest(year: number): Promise<unknown> {
  // min=10 mirrors D-666 SHIP 2a's coverage widening (10+ pitches threshold
  // includes openers / spot starters). Same as fetch-baseball-savant-weekly.
  const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=pitcher&min=10&filter=&sort=8,1&sortDir=desc&selections=p_total_pitches,p_called_strike,p_swinging_strike&csv=true`;
  const res = await fetch(url, { headers: { "User-Agent": "SharpAI/1.0 (+sharpai.bet)" } });
  if (!res.ok) {
    const t = await res.text();
    return { url, http_status: res.status, rows_upserted: 0, error: t.slice(0, 200) };
  }
  const text = await res.text();
  const { headers, rows } = parseCsv(text);
  const idx = (h: string) => headers.indexOf(h);
  const i_id = idx("player_id");
  const i_pitches = idx("p_total_pitches");
  const i_called = idx("p_called_strike");
  const i_swing = idx("p_swinging_strike");
  const i_name = idx("last_name,_first_name");
  if (i_id < 0 || i_pitches < 0 || i_called < 0 || i_swing < 0) {
    return { url, http_status: res.status, rows_fetched: rows.length, error: `missing required cols: id=${i_id} pitches=${i_pitches} called=${i_called} swing=${i_swing}`, headers };
  }
  // Today's date as snapshot_date (same convention as Savant weekly).
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const records: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const pid = int(r[i_id]);
    const pitches = int(r[i_pitches]);
    const called = int(r[i_called]);
    const swing = int(r[i_swing]);
    const name = i_name >= 0 ? (r[i_name] ?? "").replace(/^\"|\"$/g, "") : "";
    if (pid === null || pitches === null || pitches < 1 || called === null || swing === null) continue;
    // CSW% = (called_strike + swinging_strike) / total_pitches
    const cswPct = Math.round(((called + swing) / pitches) * 1000) / 10;  // 0-100, 1 dp
    const calledPct = Math.round((called / pitches) * 1000) / 10;
    const swingPct = Math.round((swing / pitches) * 1000) / 10;
    records.push({
      player_id: pid,
      snapshot_date: snapshotDate,
      player_name: name,
      csw_pct: cswPct,
      called_strike_pct: calledPct,
      swinging_strike_pct: swingPct,
      total_pitches_csw: pitches,
    });
  }
  let upserted = 0; let failed = 0;
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/cache_statcast_pitcher_arsenal?on_conflict=player_id,snapshot_date`, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
      if (r.ok) upserted += chunk.length; else failed += chunk.length;
    } catch { failed += chunk.length; }
  }
  // Sample row for visibility
  const sample = records.slice(0, 3).map((r) => ({ pid: r.player_id, name: r.player_name, csw: r.csw_pct, called: r.called_strike_pct, swing: r.swinging_strike_pct, pitches: r.total_pitches_csw }));
  return { url, http_status: res.status, rows_fetched: rows.length, rows_built: records.length, rows_upserted: upserted, rows_failed: failed, snapshot_date: snapshotDate, sample };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") || "";
  if (BACKFILL_TOKEN && !auth.includes(BACKFILL_TOKEN)) return jsonResponse({ error: "unauthorized" }, 401);
  let year = 2026;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.year === "number") year = body.year;
  } catch { /* default */ }
  const result = await ingest(year);
  return jsonResponse({ ok: true, year, result });
});
