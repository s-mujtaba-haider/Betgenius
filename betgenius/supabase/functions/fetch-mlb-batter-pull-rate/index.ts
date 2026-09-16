// fetch-mlb-batter-pull-rate — D-816 PART 1.
//
// Pulls Baseball Savant batted-ball direction leaderboard CSV and upserts
// into cache_statcast_batters_pull_rate. Source for D-816 score_batter_pull_rate
// HR factor (pull-air rate is the strongest HR-prediction signal among
// directional metrics).
//
// Endpoint: /leaderboard/batted-ball?year=YYYY&type=batter&min=100&csv=true
// Columns: id, name, year, bbe, gb_rate, air_rate, fb_rate, ld_rate, pu_rate,
//          pull_rate, straight_rate, oppo_rate, pull_gb_rate, straight_gb_rate,
//          oppo_gb_rate, pull_air_rate, straight_air_rate, oppo_air_rate
//
// AUTH: service-role via BACKFILL_AUTH_TOKEN. Manually triggerable.

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

  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (BACKFILL_TOKEN && token !== BACKFILL_TOKEN) {
    return jsonResponse({ success: false, error: "unauthorized" }, 401);
  }

  const year = new Date().getUTCFullYear();
  const snapshotDate = new Date().toISOString().slice(0, 10);

  const url = `https://baseballsavant.mlb.com/leaderboard/batted-ball?year=${year}&type=batter&csv=true&min=100`;
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

  const idxPid = headers.indexOf("id");
  const idxName = headers.indexOf("name");
  const idxBbe = headers.indexOf("bbe");
  const idxPull = headers.indexOf("pull_rate");
  const idxPullAir = headers.indexOf("pull_air_rate");
  const idxOppo = headers.indexOf("oppo_rate");
  const idxStraight = headers.indexOf("straight_rate");
  const idxFb = headers.indexOf("fb_rate");
  const idxGb = headers.indexOf("gb_rate");
  const idxLd = headers.indexOf("ld_rate");

  if (idxPid < 0 || idxPull < 0) {
    return jsonResponse({ success: false, error: "missing id or pull_rate column", headers }, 500);
  }

  type Row = {
    player_id: number;
    player_name: string | null;
    year: number;
    bbe: number | null;
    pull_rate: number;
    pull_air_rate: number | null;
    oppo_rate: number | null;
    straight_rate: number | null;
    fb_rate: number | null;
    gb_rate: number | null;
    ld_rate: number | null;
    snapshot_date: string;
  };

  const upserts: Row[] = [];
  for (const r of rows) {
    const pid = Number(r[idxPid]);
    const pull = Number(r[idxPull]);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(pull)) continue;
    upserts.push({
      player_id: pid,
      player_name: idxName >= 0 ? (r[idxName] || null) : null,
      year,
      bbe: idxBbe >= 0 && r[idxBbe] ? Number(r[idxBbe]) : null,
      pull_rate: pull,
      pull_air_rate: idxPullAir >= 0 && r[idxPullAir] ? Number(r[idxPullAir]) : null,
      oppo_rate: idxOppo >= 0 && r[idxOppo] ? Number(r[idxOppo]) : null,
      straight_rate: idxStraight >= 0 && r[idxStraight] ? Number(r[idxStraight]) : null,
      fb_rate: idxFb >= 0 && r[idxFb] ? Number(r[idxFb]) : null,
      gb_rate: idxGb >= 0 && r[idxGb] ? Number(r[idxGb]) : null,
      ld_rate: idxLd >= 0 && r[idxLd] ? Number(r[idxLd]) : null,
      snapshot_date: snapshotDate,
    });
  }

  if (upserts.length === 0) {
    return jsonResponse({ success: true, rows_parsed: 0, rows_upserted: 0, year, snapshot_date: snapshotDate });
  }

  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const slice = upserts.slice(i, i + CHUNK);
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/cache_statcast_batters_pull_rate?on_conflict=player_id,snapshot_date`,
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
