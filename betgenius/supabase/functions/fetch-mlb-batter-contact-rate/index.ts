// fetch-mlb-batter-contact-rate — D-824 PART 1.
//
// Pulls Baseball Savant plate-discipline (whiff/contact) leaderboard CSV
// and upserts into cache_statcast_batters_contact_rate. Source for D-824
// score_batter_contact_rate hits factor — the hits-specific discriminator
// flagged in D-822 (high contact + low whiff → more balls in play → more hits).
//
// Endpoint: /leaderboard/custom?...&selections=whiff_percent,contact_percent,...
// snapshot_date is part of PK so the D-825 retune can read leak-safe AS-OF rows.
//
// AUTH: service-role via BACKFILL_AUTH_TOKEN.

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

const numOrNull = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

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

  const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${year}&type=batter&filter=&min=100&selections=whiff_percent,k_percent,bb_percent,swing_percent,oz_swing_percent,z_contact_percent,oz_contact_percent,contact_percent,&sort=4&sortDir=asc&csv=true`;
  let csvText = "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return jsonResponse({ success: false, error: `savant ${r.status}` }, 500);
    csvText = await r.text();
  } catch (e) {
    return jsonResponse({ success: false, error: `savant fetch failed: ${String(e)}` }, 500);
  }

  const { headers, rows } = parseCsv(csvText);
  if (headers.length === 0 || rows.length === 0) {
    return jsonResponse({ success: false, error: "empty csv" }, 500);
  }

  const idxName = headers.indexOf("last_name, first_name");
  const idxPid = headers.indexOf("player_id");
  const idxWhiff = headers.indexOf("whiff_percent");
  const idxContact = headers.indexOf("contact_percent");
  const idxSwing = headers.indexOf("swing_percent");
  const idxOzSwing = headers.indexOf("oz_swing_percent");
  const idxZContact = headers.indexOf("z_contact_percent");
  const idxOzContact = headers.indexOf("oz_contact_percent");
  const idxK = headers.indexOf("k_percent");
  const idxBB = headers.indexOf("bb_percent");

  if (idxPid < 0 || idxWhiff < 0) {
    return jsonResponse({ success: false, error: "missing player_id or whiff_percent column", headers }, 500);
  }

  type Row = {
    player_id: number;
    snapshot_date: string;
    year: number;
    player_name: string | null;
    whiff_percent: number | null;
    contact_percent: number | null;
    swing_percent: number | null;
    oz_swing_percent: number | null;
    z_contact_percent: number | null;
    oz_contact_percent: number | null;
    k_percent: number | null;
    bb_percent: number | null;
  };

  const upserts: Row[] = [];
  for (const r of rows) {
    const pid = Number(r[idxPid]);
    const whiff = numOrNull(r[idxWhiff]);
    if (!Number.isFinite(pid) || pid <= 0 || whiff === null) continue;
    upserts.push({
      player_id: pid,
      snapshot_date: snapshotDate,
      year,
      player_name: idxName >= 0 ? (r[idxName] || null) : null,
      whiff_percent: whiff,
      contact_percent: idxContact >= 0 ? numOrNull(r[idxContact]) : null,
      swing_percent: idxSwing >= 0 ? numOrNull(r[idxSwing]) : null,
      oz_swing_percent: idxOzSwing >= 0 ? numOrNull(r[idxOzSwing]) : null,
      z_contact_percent: idxZContact >= 0 ? numOrNull(r[idxZContact]) : null,
      oz_contact_percent: idxOzContact >= 0 ? numOrNull(r[idxOzContact]) : null,
      k_percent: idxK >= 0 ? numOrNull(r[idxK]) : null,
      bb_percent: idxBB >= 0 ? numOrNull(r[idxBB]) : null,
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
      `${SUPABASE_URL}/rest/v1/cache_statcast_batters_contact_rate?on_conflict=player_id,snapshot_date`,
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
