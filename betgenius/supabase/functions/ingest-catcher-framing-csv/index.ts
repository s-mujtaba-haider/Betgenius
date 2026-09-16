// ingest-catcher-framing-csv — D-282 SHIP 2.
//
// Accepts POST with CSV body OR { csv: "..." } JSON. Parses
// Baseball Savant catcher framing leaderboard CSV format and upserts
// into cache_statcast_catcher_framing.
//
// AUTH: service_role only (CEO triggers manually via upload script).
//
// CSV columns expected (Baseball Savant standard):
//   last_name, first_name, player_id, year, framing_runs,
//   runs_extra_strikes, strike_rate, shadow_zone_pct, ...
//
// Manual playbook: docs/loop/playbooks/catcher_framing_weekly.md

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

const supaHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

function num(s: string | undefined): number | null {
  if (!s || s === "—") return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse({ success: false, error: "missing env" }, 500);

  const auth = req.headers.get("authorization") || "";
  const matches = auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN));
  if (!matches) return jsonResponse({ success: false, error: "unauthorized" }, 401);

  // Accept either raw CSV body or JSON { csv }
  const contentType = req.headers.get("content-type") || "";
  let csv: string;
  try {
    if (contentType.includes("application/json")) {
      const body = await req.json();
      csv = body.csv || "";
    } else {
      csv = await req.text();
    }
  } catch (e) {
    return jsonResponse({ success: false, error: `body parse: ${e instanceof Error ? e.message : String(e)}` }, 400);
  }

  if (!csv || csv.length < 50) {
    return jsonResponse({ success: false, error: "empty or trivially short CSV body" }, 400);
  }

  const { headers, rows } = parseCsv(csv);
  if (headers.length === 0 || rows.length === 0) {
    return jsonResponse({ success: false, error: "no rows parsed from CSV" }, 400);
  }

  const idx = (h: string) => headers.indexOf(h);
  const i_id = idx("player_id");
  if (i_id < 0) return jsonResponse({ success: false, error: "no player_id column in CSV", headers }, 400);

  const easternNow = new Date(Date.now() - 4 * 3600_000);
  const snapshotDate = easternNow.toISOString().slice(0, 10);

  const records = rows.filter((r) => r[i_id]).map((r) => {
    const get = (col: string) => { const i = idx(col); return i >= 0 ? r[i] : undefined; };
    return {
      player_id: parseInt(get("player_id") ?? "0", 10) || null,
      snapshot_date: snapshotDate,
      player_name: `${(get("first_name") ?? "").replace(/\"/g,'').trim()} ${(get("last_name") ?? "").replace(/\"/g,'').trim()}`.trim(),
      team: get("team_name_alt") ?? get("team") ?? null,
      framing_runs: num(get("framing_runs") ?? get("runs_framing") ?? get("framingRuns")),
      runs_extra_strikes: num(get("runs_extra_strikes") ?? get("extra_strikes")),
      strike_rate: num(get("strike_rate") ?? get("called_strike_rate")),
      shadow_zone_pct: num(get("shadow_zone_pct") ?? get("shadow_zone_percent")),
      shadow_strike_pct: num(get("shadow_strike_pct") ?? get("shadow_strike_percent")),
      raw_csv_row: Object.fromEntries(headers.map((h, i) => [h, r[i] ?? null])),
    };
  }).filter((r) => r.player_id);

  // Bulk upsert in chunks of 200
  let upserted = 0; let failed = 0;
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/cache_statcast_catcher_framing?on_conflict=player_id,snapshot_date`, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
      if (r.ok) upserted += chunk.length;
      else { failed += chunk.length; }
    } catch { failed += chunk.length; }
  }

  return jsonResponse({
    success: true, snapshot_date: snapshotDate,
    csv_rows_parsed: rows.length, records_upserted: upserted, records_failed: failed,
    columns_found: headers,
  });
});
