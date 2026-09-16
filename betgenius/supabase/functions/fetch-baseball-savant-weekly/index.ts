// fetch-baseball-savant-weekly — D-282 SHIP 2.
//
// Pulls 4 Baseball Savant framing leaderboards weekly (Sunday 4 AM ET)
// and upserts into cache_statcast_framing. Replaces D-282 SHIP 2 v1
// manual CSV upload workflow.
//
// Endpoints (verified D-282 SHIP 2 URL probe):
//   /leaderboard/catcher-framing?year=YYYY&type={Cat|Tm|Pit|Bat}&csv=true
//
// All 4 variants return the same column schema (id, name, pitches,
// rv_tot, pct_tot, zone-level rv_11..19 + pct_11..19); `id` semantics
// differ — player_id for Cat/Pit/Bat, team_id for Tm.
//
// AUTH: service_role via BACKFILL_AUTH_TOKEN. Cron triggers via vault.

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

const supaHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

// CSV parser identical to fetch-statcast-snapshot (D-274). Skips
// BOM, handles quoted fields with internal commas.
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

// D-282 SHIP 2 (2026-05-21) finding: Baseball Savant returns sanitized
// data (empty id + name fields) when `type=` param is set. Only the
// default URL (no type param) returns real catcher-keyed data with IDs.
// So this batch ships catcher-only (Cat variant via default URL).
// Tm/Pit/Bat variants filed for D-283 — likely require authenticated
// session cookies or different access path.
const VARIANTS: Array<"Cat"> = ["Cat"];

interface IngestResult {
  entity_type: string;
  url: string;
  http_status: number;
  rows_fetched: number;
  rows_upserted: number;
  rows_failed: number;
  body_bytes?: number;
  body_first_120?: string;
  parsed_headers_count?: number;
  parsed_lines?: number;
  error?: string;
}

async function ingestVariant(variant: "Cat" | "Tm" | "Pit" | "Bat", year: number, snapshotDate: string): Promise<IngestResult> {
  // Cat variant uses default URL (no type param) — only form that returns
  // real per-catcher data with IDs. Tm/Pit/Bat type-param variants return
  // sanitized data (empty id/name); deferred to D-283.
  const url = variant === "Cat"
    ? `https://baseballsavant.mlb.com/leaderboard/catcher-framing?year=${year}&csv=true`
    : `https://baseballsavant.mlb.com/leaderboard/catcher-framing?year=${year}&type=${variant}&csv=true`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "SharpAI/1.0 (+sharpai.bet)" } });
    if (!res.ok) {
      const t = await res.text();
      return { entity_type: variant, url, http_status: res.status, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, error: t.slice(0, 200) };
    }
    const text = await res.text();
    const body_bytes = text.length;
    const body_first_120 = text.slice(0, 120);
    const { headers, rows } = parseCsv(text);
    const idx = (h: string) => headers.indexOf(h);
    const i_id = idx("id");
    if (i_id < 0) return { entity_type: variant, url, http_status: res.status, rows_fetched: rows.length, rows_upserted: 0, rows_failed: rows.length, body_bytes, body_first_120, parsed_headers_count: headers.length, parsed_lines: rows.length, error: "no id column" };

    const records = rows.filter((r) => r[i_id]).map((r) => ({
      entity_id: int(r[i_id]),
      entity_type: variant,
      snapshot_date: snapshotDate,
      entity_name: (r[idx("name")] ?? "").replace(/^\"|\"$/g, ""),
      pitches: int(r[idx("pitches")]),
      rv_tot: num(r[idx("rv_tot")]),
      pct_tot: num(r[idx("pct_tot")]),
      rv_11: num(r[idx("rv_11")]), pct_11: num(r[idx("pct_11")]),
      rv_12: num(r[idx("rv_12")]), pct_12: num(r[idx("pct_12")]),
      rv_13: num(r[idx("rv_13")]), pct_13: num(r[idx("pct_13")]),
      rv_14: num(r[idx("rv_14")]), pct_14: num(r[idx("pct_14")]),
      rv_16: num(r[idx("rv_16")]), pct_16: num(r[idx("pct_16")]),
      rv_17: num(r[idx("rv_17")]), pct_17: num(r[idx("pct_17")]),
      rv_18: num(r[idx("rv_18")]), pct_18: num(r[idx("pct_18")]),
      rv_19: num(r[idx("rv_19")]), pct_19: num(r[idx("pct_19")]),
    })).filter((r) => r.entity_id !== null);

    // Chunked upsert
    let upserted = 0; let failed = 0;
    for (let i = 0; i < records.length; i += 200) {
      const chunk = records.slice(i, i + 200);
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/cache_statcast_framing?on_conflict=entity_id,entity_type,snapshot_date`, {
          method: "POST",
          headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(chunk),
        });
        if (r.ok) upserted += chunk.length; else failed += chunk.length;
      } catch { failed += chunk.length; }
    }
    return { entity_type: variant, url, http_status: res.status, rows_fetched: records.length, rows_upserted: upserted, rows_failed: failed, body_bytes, parsed_headers_count: headers.length };
  } catch (e) {
    return { entity_type: variant, url, http_status: 0, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// D-286 SHIP 2 — pitch arsenal ingest. Pulls pitch-arsenal-stats CSV
// (one row per pitcher × pitch_type), aggregates per pitcher with
// derived breaking_ball_pct (SL+CU+FC+ST+SV) + offspeed_pct (CH+FS).
async function ingestPitcherArsenal(year: number, snapshotDate: string): Promise<IngestResult> {
  // D-646 SHIP 2 — added min=50 (50 IP cutoff, matches D-630 pitcher
  // statcast endpoint). Pre-D-646 the URL had no `min` param → Savant
  // defaulted to "qualified" (~1 IP per team game) and 85.5% of cache
  // rows had NULL expected_whiff_pct / expected_k_pct / expected_put_away
  // because their CSV rows came back blank on those signal columns.
  // RS scorer's score_opp_pitcher_pitchtype_quality fired on only 18.8%
  // of picks per D-645 audit. min=50 captures any projectable pitcher
  // (mid-season relievers + spot starters), same threshold D-630 used
  // for /leaderboard/expected_statistics?type=pitcher.
  // D-666 SHIP 2a — drop min from 50 → 10. Probe (2026-06-21):
  //   min=50 → 555 CSV rows (~185 distinct pids per 3 pitches each)
  //   min=10 → 1980 CSV rows (~660 distinct pids) → ~3.5× coverage gain
  // pitcher_strikeouts scorer's whiff/K%/put-away gated factors are
  // currently starved at 313 distinct PA-populated pids (~13% of 2,431
  // MLB pitchers). Widening surfaces openers / bullpen spot starters
  // that didn't qualify at 50 IP.
  const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?year=${year}&min=10&csv=true`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "SharpAI/1.0 (+sharpai.bet)" } });
    if (!res.ok) {
      const t = await res.text();
      return { entity_type: "PitcherArsenal", url, http_status: res.status, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, error: t.slice(0, 200) };
    }
    const text = await res.text();
    const body_bytes = text.length;
    const { headers, rows } = parseCsv(text);
    const idx = (h: string) => headers.indexOf(h);
    const i_id = idx("player_id");
    const i_name = idx("last_name,_first_name");  // CSV header has comma flattened by parser
    const i_type = idx("pitch_type");
    const i_usage = idx("pitch_usage");
    const i_pitches = idx("pitches");
    // D-596 — per-pitch-type residual signals for the pitcher_k matchup factor.
    // These columns exist on the Savant CSV but were unparsed pre-D-596.
    const i_whiff = idx("whiff_percent");
    const i_kpct = idx("k_percent");
    const i_putaway = idx("put_away");
    if (i_id < 0 || i_type < 0 || i_usage < 0) {
      return { entity_type: "PitcherArsenal", url, http_status: res.status, rows_fetched: rows.length, rows_upserted: 0, rows_failed: rows.length, body_bytes, parsed_headers_count: headers.length, error: `missing required cols: id=${i_id} type=${i_type} usage=${i_usage}` };
    }
    // Aggregate per pitcher. D-596 adds usage-weighted whiff/k_pct/put_away
    // accumulators alongside the existing per-pitch usage capture.
    interface Agg {
      name: string; total: number;
      ff: number; si: number; fc: number; sl: number; ch: number;
      cu: number; fs: number; st: number; sv: number; kn: number;
      // D-596 accumulators
      // D-646 SHIP 2 — per-signal denominators. Pre-D-646 a single
      // `usage_sum` was conditioned on whiff !== null (line below at
      // legacy ~229). If a pitcher's CSV had blank whiff but populated
      // put_away or k_pct, the shared denom stayed 0 → all three
      // expected_* fields divided by null → all three null. Live cache
      // showed 100%-correlated nullness (299/2068 = 14.5% on all three),
      // confirming the shared-denom bug. Split into 3 independent
      // denominators so a missing signal kills only its own aggregate.
      usage_sum_whiff: number;
      usage_sum_kpct: number;
      usage_sum_putaway: number;
      weighted_whiff: number;
      weighted_kpct: number;
      weighted_putaway: number;
    }
    const byPid = new Map<number, Agg>();
    for (const r of rows) {
      const pid = int(r[i_id]);
      if (pid === null) continue;
      const pt = (r[i_type] ?? "").trim().toUpperCase();
      const usage = num(r[i_usage]);
      const pitches = i_pitches >= 0 ? (int(r[i_pitches]) ?? 0) : 0;
      const name = i_name >= 0 ? (r[i_name] ?? "").replace(/^\"|\"$/g, "") : "";
      if (usage === null) continue;
      let a = byPid.get(pid);
      if (!a) {
        a = {
          name, total: 0,
          ff: 0, si: 0, fc: 0, sl: 0, ch: 0, cu: 0, fs: 0, st: 0, sv: 0, kn: 0,
          // D-646 SHIP 2 — three independent usage_sum denominators.
          usage_sum_whiff: 0, usage_sum_kpct: 0, usage_sum_putaway: 0,
          weighted_whiff: 0, weighted_kpct: 0, weighted_putaway: 0,
        };
        byPid.set(pid, a);
      }
      a.total += pitches;
      if (pt === "FF") a.ff = usage;
      else if (pt === "SI") a.si = usage;
      else if (pt === "FC") a.fc = usage;
      else if (pt === "SL") a.sl = usage;
      else if (pt === "CH") a.ch = usage;
      else if (pt === "CU") a.cu = usage;
      else if (pt === "FS") a.fs = usage;
      else if (pt === "ST") a.st = usage;
      else if (pt === "SV") a.sv = usage;
      else if (pt === "KN") a.kn = usage;
      // D-596 — accumulate usage-weighted per-pitch-type signals.
      // D-646 SHIP 2 — each signal now has its own usage_sum denominator
      // (pre-D-646 the shared `usage_sum` was conditioned on whiff
      // !== null, so missing whiff zeroed k_pct + put_away too).
      if (i_whiff >= 0) {
        const whiff = num(r[i_whiff]);
        if (whiff !== null) {
          a.weighted_whiff += usage * whiff;
          a.usage_sum_whiff += usage;
        }
      }
      if (i_kpct >= 0) {
        const kpct = num(r[i_kpct]);
        if (kpct !== null) {
          a.weighted_kpct += usage * kpct;
          a.usage_sum_kpct += usage;
        }
      }
      if (i_putaway >= 0) {
        const pa = num(r[i_putaway]);
        if (pa !== null) {
          a.weighted_putaway += usage * pa;
          a.usage_sum_putaway += usage;
        }
      }
    }
    const records = [...byPid.entries()].map(([pid, a]) => {
      // D-596 — finalize per-pitcher usage-weighted aggregates.
      // D-646 SHIP 2 — each signal divides by its own usage_sum so one
      // missing CSV column doesn't kill the others.
      const denomW  = a.usage_sum_whiff   > 0 ? a.usage_sum_whiff   : null;
      const denomK  = a.usage_sum_kpct    > 0 ? a.usage_sum_kpct    : null;
      const denomPA = a.usage_sum_putaway > 0 ? a.usage_sum_putaway : null;
      const expectedWhiff = denomW  ? Math.round((a.weighted_whiff   / denomW)  * 100) / 100 : null;
      const expectedKpct  = denomK  ? Math.round((a.weighted_kpct    / denomK)  * 100) / 100 : null;
      const expectedPA    = denomPA ? Math.round((a.weighted_putaway / denomPA) * 100) / 100 : null;
      return {
        player_id: pid,
        snapshot_date: snapshotDate,
        player_name: a.name,
        total_pitches: a.total,
        ff_pct: a.ff, si_pct: a.si, fc_pct: a.fc, sl_pct: a.sl, ch_pct: a.ch,
        cu_pct: a.cu, fs_pct: a.fs, st_pct: a.st, sv_pct: a.sv, kn_pct: a.kn,
        breaking_ball_pct: Math.round((a.sl + a.cu + a.fc + a.st + a.sv) * 100) / 100,
        offspeed_pct: Math.round((a.ch + a.fs) * 100) / 100,
        // D-596 — new columns
        expected_whiff_pct: expectedWhiff,
        expected_k_pct: expectedKpct,
        expected_put_away: expectedPA,
      };
    });
    // Chunked upsert
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
    return { entity_type: "PitcherArsenal", url, http_status: res.status, rows_fetched: records.length, rows_upserted: upserted, rows_failed: failed, body_bytes, parsed_headers_count: headers.length };
  } catch (e) {
    return { entity_type: "PitcherArsenal", url, http_status: 0, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// D-349 — pitch arsenal AVG VELOCITY per pitch-type. Endpoint pitch-arsenals
// (plural) is separate from D-286's pitch-arsenal-stats (which has usage %).
// CSV header: "last_name, first_name","pitcher","ff_avg_speed","si_avg_speed",
// "fc_avg_speed","sl_avg_speed","ch_avg_speed","cu_avg_speed","fs_avg_speed",
// "kn_avg_speed","st_avg_speed","sv_avg_speed". Upserts into the same
// cache_statcast_pitcher_arsenal row (merge-duplicates) — velocity columns
// were added in migration 20260527000010.
async function ingestPitcherArsenalVelocities(year: number, snapshotDate: string): Promise<IngestResult> {
  const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenals?team=&min=q&hand=&year=${year}&csv=true`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "SharpAI/1.0 (+sharpai.bet)" } });
    if (!res.ok) {
      const t = await res.text();
      return { entity_type: "PitcherArsenalVelocity", url, http_status: res.status, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, error: t.slice(0, 200) };
    }
    const text = await res.text();
    const body_bytes = text.length;
    const { headers, rows } = parseCsv(text);
    const idx = (h: string) => headers.indexOf(h);
    // Header uses "pitcher" as the player_id column (verified live).
    const i_id = idx("pitcher");
    const i_name = idx("last_name,_first_name");
    const i_ff = idx("ff_avg_speed");
    const i_si = idx("si_avg_speed");
    const i_sl = idx("sl_avg_speed");
    const i_ch = idx("ch_avg_speed");
    const i_cu = idx("cu_avg_speed");
    const i_fc = idx("fc_avg_speed");
    const i_fs = idx("fs_avg_speed");
    const i_st = idx("st_avg_speed");
    const i_sv = idx("sv_avg_speed");
    const i_kn = idx("kn_avg_speed");
    if (i_id < 0) {
      return { entity_type: "PitcherArsenalVelocity", url, http_status: res.status, rows_fetched: rows.length, rows_upserted: 0, rows_failed: rows.length, body_bytes, parsed_headers_count: headers.length, error: `missing player_id col (header was "pitcher")` };
    }
    const records: Record<string, unknown>[] = [];
    for (const r of rows) {
      const pid = int(r[i_id]);
      if (pid === null) continue;
      const name = i_name >= 0 ? (r[i_name] ?? "").replace(/^\"|\"$/g, "") : "";
      records.push({
        player_id: pid,
        snapshot_date: snapshotDate,
        player_name: name,
        ff_avg_speed: i_ff >= 0 ? num(r[i_ff]) : null,
        si_avg_speed: i_si >= 0 ? num(r[i_si]) : null,
        sl_avg_speed: i_sl >= 0 ? num(r[i_sl]) : null,
        ch_avg_speed: i_ch >= 0 ? num(r[i_ch]) : null,
        cu_avg_speed: i_cu >= 0 ? num(r[i_cu]) : null,
        fc_avg_speed: i_fc >= 0 ? num(r[i_fc]) : null,
        fs_avg_speed: i_fs >= 0 ? num(r[i_fs]) : null,
        st_avg_speed: i_st >= 0 ? num(r[i_st]) : null,
        sv_avg_speed: i_sv >= 0 ? num(r[i_sv]) : null,
        kn_avg_speed: i_kn >= 0 ? num(r[i_kn]) : null,
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
    return { entity_type: "PitcherArsenalVelocity", url, http_status: res.status, rows_fetched: records.length, rows_upserted: upserted, rows_failed: failed, body_bytes, parsed_headers_count: headers.length };
  } catch (e) {
    return { entity_type: "PitcherArsenalVelocity", url, http_status: 0, rows_fetched: 0, rows_upserted: 0, rows_failed: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse({ success: false, error: "missing env" }, 500);

  const auth = req.headers.get("authorization") || "";
  const matches = auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN));
  if (!matches) return jsonResponse({ success: false, error: "unauthorized" }, 401);

  const start = Date.now();
  const easternNow = new Date(Date.now() - 4 * 3600_000);
  const snapshotDate = easternNow.toISOString().slice(0, 10);
  const year = easternNow.getUTCFullYear();

  // Run all variants + arsenal usage + arsenal velocities in parallel
  const results = await Promise.all([
    ...VARIANTS.map((v) => ingestVariant(v, year, snapshotDate)),
    ingestPitcherArsenal(year, snapshotDate),           // D-286 SHIP 2 — usage %
    ingestPitcherArsenalVelocities(year, snapshotDate), // D-349 — avg velocity per pitch-type
  ]);

  const totalUpserted = results.reduce((a, r) => a + r.rows_upserted, 0);
  const totalFailed = results.reduce((a, r) => a + r.rows_failed, 0);
  const allOk = results.every((r) => r.http_status === 200) && totalFailed === 0;

  await writeHeartbeat({
    jobName: "fetch-baseball-savant-weekly",
    status: allOk ? "success" : (totalUpserted > 0 ? "partial" : "error"),
    durationMs: Date.now() - start,
    error: allOk ? null : results.filter((r) => r.http_status !== 200 || r.error).map((r) => `${r.entity_type}:${r.error ?? r.http_status}`).join("; "),
  });

  return jsonResponse({
    success: true,
    snapshot_date: snapshotDate,
    duration_ms: Date.now() - start,
    total_upserted: totalUpserted,
    total_failed: totalFailed,
    results,
  });
});
