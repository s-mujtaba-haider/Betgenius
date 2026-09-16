// fetch-mlb-batter-sprint-speed — D-808 PART 2.
//
// Pulls Baseball Savant sprint speed leaderboard CSV and upserts into
// cache_statcast_batters_sprint_speed. Source for D-808 score_batter_sprint_speed
// factor on runs_scored picks.
//
// Endpoint: /leaderboard/sprint_speed?year=YYYY&min=10&csv=true
// Columns: "last_name, first_name", player_id, team_id, team, position, age,
//          competitive_runs, bolts, hp_to_1b, sprint_speed
//
// AUTH: service_role via BACKFILL_AUTH_TOKEN. Manually triggerable; weekly
// cron schedule deferred to D-811 (along with other Statcast weekly fetches).

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
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  };
  return { headers: parseLine(lines[0]), rows: lines.slice(1).map(parseLine) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // AUTH gate via header token. CRON injects BACKFILL_AUTH_TOKEN.
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (BACKFILL_TOKEN && token !== BACKFILL_TOKEN) {
    return jsonResponse({ success: false, error: "unauthorized" }, 401);
  }

  const year = new Date().getUTCFullYear();
  const snapshotDate = new Date().toISOString().slice(0, 10);

  // Baseball Savant sprint speed leaderboard CSV.
  const url = `https://baseballsavant.mlb.com/leaderboard/sprint_speed?year=${year}&position=&team=&min=10&csv=true`;
  let csvText = "";
  try {
    const r = await fetch(url);
    if (!r.ok) return jsonResponse({ success: false, error: `savant ${r.status}` }, 500);
    csvText = await r.text();
  } catch (e) {
    return jsonResponse({ success: false, error: `savant fetch failed: ${String(e)}` }, 500);
  }

  const { headers, rows } = parseCsv(csvText);
  if (headers.length === 0 || rows.length === 0) {
    return jsonResponse({ success: false, error: "empty csv" }, 500);
  }

  const idxPid = headers.indexOf("player_id");
  const idxName = headers.findIndex((h) => h.toLowerCase().includes("name"));
  const idxTeam = headers.indexOf("team");
  const idxPos = headers.indexOf("position");
  const idxCompRuns = headers.indexOf("competitive_runs");
  const idxBolts = headers.indexOf("bolts");
  const idxHp1b = headers.indexOf("hp_to_1b");
  const idxSpeed = headers.indexOf("sprint_speed");

  if (idxPid < 0 || idxSpeed < 0) {
    return jsonResponse({ success: false, error: "missing player_id or sprint_speed column", headers }, 500);
  }

  type Row = {
    player_id: number;
    player_name: string | null;
    team: string | null;
    position: string | null;
    sprint_speed: number;
    bolts: number | null;
    hp_to_1b: number | null;
    competitive_runs: number | null;
    snapshot_date: string;
  };

  const upserts: Row[] = [];
  for (const r of rows) {
    const pid = Number(r[idxPid]);
    const spd = Number(r[idxSpeed]);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(spd) || spd <= 0) continue;
    upserts.push({
      player_id: pid,
      player_name: idxName >= 0 ? (r[idxName] || null) : null,
      team: idxTeam >= 0 ? (r[idxTeam] || null) : null,
      position: idxPos >= 0 ? (r[idxPos] || null) : null,
      sprint_speed: spd,
      bolts: idxBolts >= 0 && r[idxBolts] ? Number(r[idxBolts]) : null,
      hp_to_1b: idxHp1b >= 0 && r[idxHp1b] ? Number(r[idxHp1b]) : null,
      competitive_runs: idxCompRuns >= 0 && r[idxCompRuns] ? Number(r[idxCompRuns]) : null,
      snapshot_date: snapshotDate,
    });
  }

  if (upserts.length === 0) {
    return jsonResponse({ success: true, rows_parsed: 0, rows_upserted: 0, year, snapshot_date: snapshotDate });
  }

  // Chunked upsert (Supabase REST max ~1000 rows per call; sprint speed
  // leaderboard has ~500 rows so a single chunk is fine but keep generic).
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const slice = upserts.slice(i, i + CHUNK);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/cache_statcast_batters_sprint_speed?on_conflict=player_id,snapshot_date`,
      {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(slice),
      },
    );
    if (!r.ok) {
      const t = await r.text();
      return jsonResponse({ success: false, rows_parsed: upserts.length, rows_written: written, error: `upsert ${r.status}: ${t}` }, 500);
    }
    written += slice.length;
  }

  return jsonResponse({
    success: true,
    year,
    snapshot_date: snapshotDate,
    rows_parsed: upserts.length,
    rows_upserted: written,
  });
});
