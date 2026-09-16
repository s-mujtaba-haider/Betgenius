// fetch-statcast-snapshot — D-274 Phase 1.
//
// Daily 4 AM ET (8 AM UTC) cron pulls 4 Baseball Savant CSV
// leaderboards (batter xstats, batter exit velo, pitcher xstats,
// pitcher exit velo) and upserts into cache_statcast_* tables.
//
// Baseball Savant CSV endpoints are public — no auth header
// required. Real limitation: leaderboards are season-to-date as-of-
// today; no point-in-time historical parameter. The append-daily
// PRIMARY KEY (player_id, snapshot_date) pattern means re-running
// the cron the same day overwrites that day's snapshot rather than
// duplicating rows.
//
// AUTH: service-role gated via BACKFILL_AUTH_TOKEN (or service-role
// key) for pg_cron-triggered calls.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";

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

// Parse a Baseball Savant CSV. First line is BOM-prefixed headers;
// values may be quoted with internal commas (none observed in
// surveyed endpoints). Use a simple state-machine parser.
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  // Strip BOM
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;
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
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "" || v === "—") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

const supaHeaders = (): Record<string, string> => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

// Upsert in chunks of 200 rows to keep request size reasonable.
async function upsertBatch(table: string, rows: Record<string, unknown>[]): Promise<{ ok: number; failed: number; errors: string[] }> {
  let ok = 0, failed = 0;
  const errors: string[] = [];
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=player_id,snapshot_date`, {
        method: "POST",
        headers: {
          ...supaHeaders(),
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(slice),
      });
      if (res.ok) {
        ok += slice.length;
      } else {
        const body = await res.text();
        failed += slice.length;
        if (errors.length < 3) errors.push(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (e) {
      failed += slice.length;
      if (errors.length < 3) errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { ok, failed, errors };
}

async function fetchCsv(url: string): Promise<{ ok: boolean; headers: string[]; rows: string[][]; status: number; bodyHint: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "SharpAI/1.0 (+sharpai.bet)" } });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, headers: [], rows: [], status: res.status, bodyHint: t.slice(0, 200) };
    }
    const text = await res.text();
    const { headers, rows } = parseCsv(text);
    return { ok: true, headers, rows, status: res.status, bodyHint: "" };
  } catch (e) {
    return { ok: false, headers: [], rows: [], status: 0, bodyHint: e instanceof Error ? e.message : String(e) };
  }
}

interface IngestResult {
  table: string;
  url: string;
  http_status: number;
  rows_fetched: number;
  rows_upserted: number;
  rows_failed: number;
  body_hint?: string;
  errors?: string[];
}

async function ingestBatterXstats(snapshotDate: string): Promise<IngestResult> {
  // D-630 — was `min=q` (qualified batter = 3.1 PA × games_played). Mid-season
  // only ~150-200 batters qualify, so most non-qualifiers (rookies, call-ups,
  // platoon hitters) were absent from the cache → score_batter_xba /
  // xslg_regression returned 0 for ~28.6% of TB picks per D-629 audit.
  // `min=100` captures ~400-500 batters with a still-meaningful sample —
  // 100 PA gives reasonable xBA stability while including the players actually
  // in pick_history. Matches the `min=10` permissiveness pattern used by the
  // exit_velo endpoint below (where exit-velo data stabilizes faster).
  const url = "https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=2026&position=&team=&min=100&csv=true";
  const r = await fetchCsv(url);
  if (!r.ok) return { table: "cache_statcast_batters_xstats", url, http_status: r.status, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, body_hint: r.bodyHint };
  const idx = (h: string) => r.headers.indexOf(h);
  const i_id = idx("player_id");
  const rows = r.rows.filter((row) => row[i_id]).map((row) => ({
    player_id: int(row[i_id]),
    snapshot_date: snapshotDate,
    player_name: row[idx('"last_name')] ? row[idx('"last_name')] : (row[0] ?? null),
    pa: int(row[idx("pa")]),
    bip: int(row[idx("bip")]),
    ba: num(row[idx("ba")]),
    est_ba: num(row[idx("est_ba")]),
    est_ba_minus_ba_diff: num(row[idx("est_ba_minus_ba_diff")]),
    slg: num(row[idx("slg")]),
    est_slg: num(row[idx("est_slg")]),
    est_slg_minus_slg_diff: num(row[idx("est_slg_minus_slg_diff")]),
    woba: num(row[idx("woba")]),
    est_woba: num(row[idx("est_woba")]),
    est_woba_minus_woba_diff: num(row[idx("est_woba_minus_woba_diff")]),
  })).filter((r) => r.player_id !== null);
  const up = await upsertBatch("cache_statcast_batters_xstats", rows);
  return { table: "cache_statcast_batters_xstats", url, http_status: r.status, rows_fetched: rows.length, rows_upserted: up.ok, rows_failed: up.failed, errors: up.errors };
}

async function ingestBatterExitVelo(snapshotDate: string): Promise<IngestResult> {
  const url = "https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=2026&position=&team=&min=10&csv=true";
  const r = await fetchCsv(url);
  if (!r.ok) return { table: "cache_statcast_batters_exit_velo", url, http_status: r.status, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, body_hint: r.bodyHint };
  const idx = (h: string) => r.headers.indexOf(h);
  const i_id = idx("player_id");
  const rows = r.rows.filter((row) => row[i_id]).map((row) => ({
    player_id: int(row[i_id]),
    snapshot_date: snapshotDate,
    player_name: row[0] ?? null,
    attempts: int(row[idx("attempts")]),
    avg_hit_angle: num(row[idx("avg_hit_angle")]),
    anglesweetspotpercent: num(row[idx("anglesweetspotpercent")]),
    max_hit_speed: num(row[idx("max_hit_speed")]),
    avg_hit_speed: num(row[idx("avg_hit_speed")]),
    ev95plus: int(row[idx("ev95plus")]),
    ev95percent: num(row[idx("ev95percent")]),
    barrels: int(row[idx("barrels")]),
    brl_percent: num(row[idx("brl_percent")]),
    brl_pa: num(row[idx("brl_pa")]),
  })).filter((r) => r.player_id !== null);
  const up = await upsertBatch("cache_statcast_batters_exit_velo", rows);
  return { table: "cache_statcast_batters_exit_velo", url, http_status: r.status, rows_fetched: rows.length, rows_upserted: up.ok, rows_failed: up.failed, errors: up.errors };
}

async function ingestPitcherXstats(snapshotDate: string): Promise<IngestResult> {
  // D-630 — was `min=q` (~1 IP per team game = ~80 IP qualifier).
  // Sibling fix to ingestBatterXstats — pitcher cache missed setup men,
  // long relievers, and starters yet to reach the IP qualifier. Most opposing
  // pitchers in pick_history would be SP starters who qualify, so impact
  // is smaller than for batters, but the same pattern applies.
  // `min=50` (50 IP) covers any reasonably-projectable pitcher.
  const url = "https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2026&position=&team=&min=50&csv=true";
  const r = await fetchCsv(url);
  if (!r.ok) return { table: "cache_statcast_pitchers_xstats", url, http_status: r.status, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, body_hint: r.bodyHint };
  const idx = (h: string) => r.headers.indexOf(h);
  const i_id = idx("player_id");
  const rows = r.rows.filter((row) => row[i_id]).map((row) => ({
    player_id: int(row[i_id]),
    snapshot_date: snapshotDate,
    player_name: row[0] ?? null,
    pa: int(row[idx("pa")]),
    bip: int(row[idx("bip")]),
    ba: num(row[idx("ba")]),
    est_ba: num(row[idx("est_ba")]),
    est_ba_minus_ba_diff: num(row[idx("est_ba_minus_ba_diff")]),
    slg: num(row[idx("slg")]),
    est_slg: num(row[idx("est_slg")]),
    est_slg_minus_slg_diff: num(row[idx("est_slg_minus_slg_diff")]),
    woba: num(row[idx("woba")]),
    est_woba: num(row[idx("est_woba")]),
    est_woba_minus_woba_diff: num(row[idx("est_woba_minus_woba_diff")]),
    era: num(row[idx("era")]),
    xera: num(row[idx("xera")]),
    era_minus_xera_diff: num(row[idx("era_minus_xera_diff")]),
  })).filter((r) => r.player_id !== null);
  const up = await upsertBatch("cache_statcast_pitchers_xstats", rows);
  return { table: "cache_statcast_pitchers_xstats", url, http_status: r.status, rows_fetched: rows.length, rows_upserted: up.ok, rows_failed: up.failed, errors: up.errors };
}

async function ingestPitcherExitVelo(snapshotDate: string): Promise<IngestResult> {
  const url = "https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&year=2026&position=&team=&min=10&csv=true";
  const r = await fetchCsv(url);
  if (!r.ok) return { table: "cache_statcast_pitchers_exit_velo", url, http_status: r.status, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, body_hint: r.bodyHint };
  const idx = (h: string) => r.headers.indexOf(h);
  const i_id = idx("player_id");
  const rows = r.rows.filter((row) => row[i_id]).map((row) => ({
    player_id: int(row[i_id]),
    snapshot_date: snapshotDate,
    player_name: row[0] ?? null,
    attempts: int(row[idx("attempts")]),
    avg_hit_angle: num(row[idx("avg_hit_angle")]),
    anglesweetspotpercent: num(row[idx("anglesweetspotpercent")]),
    max_hit_speed: num(row[idx("max_hit_speed")]),
    avg_hit_speed: num(row[idx("avg_hit_speed")]),
    ev95plus: int(row[idx("ev95plus")]),
    ev95percent: num(row[idx("ev95percent")]),
    barrels: int(row[idx("barrels")]),
    brl_percent: num(row[idx("brl_percent")]),
    brl_pa: num(row[idx("brl_pa")]),
  })).filter((r) => r.player_id !== null);
  const up = await upsertBatch("cache_statcast_pitchers_exit_velo", rows);
  return { table: "cache_statcast_pitchers_exit_velo", url, http_status: r.status, rows_fetched: rows.length, rows_upserted: up.ok, rows_failed: up.failed, errors: up.errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse({ success: false, error: "missing supabase env" }, 500);

  // Auth gate
  const auth = req.headers.get("authorization") || "";
  const matches = (auth.includes(SUPABASE_KEY)) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN));
  if (!matches) return jsonResponse({ success: false, error: "service_role key required" }, 401);

  const start = Date.now();
  // Use ET-of-now snapshot_date convention (matches snapshot-opp-stats).
  const easternNow = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const snapshotDate = easternNow.toISOString().slice(0, 10);

  // Run all 4 fetches in parallel. Each is independent.
  const [r1, r2, r3, r4] = await Promise.all([
    ingestBatterXstats(snapshotDate),
    ingestBatterExitVelo(snapshotDate),
    ingestPitcherXstats(snapshotDate),
    ingestPitcherExitVelo(snapshotDate),
  ]);

  const durationMs = Date.now() - start;
  const totalUpserted = r1.rows_upserted + r2.rows_upserted + r3.rows_upserted + r4.rows_upserted;
  const totalFailed = r1.rows_failed + r2.rows_failed + r3.rows_failed + r4.rows_failed;
  const allOk = totalFailed === 0 && [r1, r2, r3, r4].every((r) => r.http_status === 200);

  await writeHeartbeat({
    jobName: "fetch-statcast-snapshot",
    status: allOk ? "success" : (totalUpserted > 0 ? "partial" : "error"),
    durationMs,
    error: allOk ? null : `failed=${totalFailed}; ` + [r1, r2, r3, r4].filter((r) => r.http_status !== 200).map((r) => `${r.table}:HTTP${r.http_status}`).join(", "),
  });

  return jsonResponse({
    success: true,
    snapshot_date: snapshotDate,
    duration_ms: durationMs,
    total_upserted: totalUpserted,
    total_failed: totalFailed,
    results: [r1, r2, r3, r4],
  });
});
