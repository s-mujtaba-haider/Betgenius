// fetch-mlb-pitcher-splits — D-349.
//
// Pulls MLB pitcher BAA/OPS splits vs LHB / RHB and upserts into
// cache_mlb_pitcher_splits. Mirrors D-282 fetch-mlb-batter-splits.
//
// Targets pitcher pool from TWO sources:
//   1. Today's props_cache pitcher_strikeouts player names (lookup via /people/search)
//   2. Today's MLB schedule probable pitchers (direct MLBAMID, no lookup risk)
// Bounds API calls to ~30-60 pitchers per cron run.
//
// AUTH: service-role via BACKFILL_AUTH_TOKEN. Cron triggers via vault (D-313).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

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

async function quietFetch(url: string, timeoutMs = 12000): Promise<{ ok: boolean; status: number; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) { return { ok: false, status: 0, text: String(e) }; }
  finally { clearTimeout(t); }
}

interface PlayerSearchHit { id: number; fullName: string; }

async function lookupPlayerId(name: string): Promise<number | null> {
  const q = encodeURIComponent(name);
  const r = await quietFetch(`${MLB_STATS_BASE}/people/search?names=${q}&sportIds=1`);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.text);
    const people: PlayerSearchHit[] = j?.people ?? [];
    if (people.length === 0) return null;
    const exact = people.find(p => p.fullName.toLowerCase() === name.toLowerCase());
    return (exact ?? people[0]).id;
  } catch { return null; }
}

interface SplitsRow {
  player_id: number;
  snapshot_date: string;
  player_name: string;
  baa_vs_lhb: number | null;
  obp_vs_lhb: number | null;
  slg_vs_lhb: number | null;
  ops_vs_lhb: number | null;
  pa_vs_lhb: number | null;
  baa_vs_rhb: number | null;
  obp_vs_rhb: number | null;
  slg_vs_rhb: number | null;
  ops_vs_rhb: number | null;
  pa_vs_rhb: number | null;
}

function num(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const n = parseFloat(String(s));
  return Number.isFinite(n) ? n : null;
}
function int(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const n = parseInt(String(s), 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchSplits(playerId: number, playerName: string, snapshotDate: string): Promise<SplitsRow | null> {
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=statSplits&sitCodes=vl,vr&group=pitching&season=2026`;
  const r = await quietFetch(url);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.text);
    const splits = j?.stats?.[0]?.splits ?? [];
    const row: SplitsRow = {
      player_id: playerId, snapshot_date: snapshotDate, player_name: playerName,
      baa_vs_lhb: null, obp_vs_lhb: null, slg_vs_lhb: null, ops_vs_lhb: null, pa_vs_lhb: null,
      baa_vs_rhb: null, obp_vs_rhb: null, slg_vs_rhb: null, ops_vs_rhb: null, pa_vs_rhb: null,
    };
    for (const s of splits) {
      const code = s?.split?.code ?? "";
      const stat = s?.stat ?? {};
      const prefix = code === "vl" ? "lhb" : code === "vr" ? "rhb" : null;
      if (!prefix) continue;
      // MLB Stats API "avg" for pitcher splits = opponents' BAA against this pitcher
      (row as any)[`baa_vs_${prefix}`] = num(stat.avg);
      (row as any)[`obp_vs_${prefix}`] = num(stat.obp);
      (row as any)[`slg_vs_${prefix}`] = num(stat.slg);
      (row as any)[`ops_vs_${prefix}`] = num(stat.ops);
      // For pitchers, "battersFaced" is the right PA-like count
      (row as any)[`pa_vs_${prefix}`] = int(stat.battersFaced);
    }
    return row;
  } catch { return null; }
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

  // Source 1: today's pitcher_strikeouts pool from props_cache (via name lookup)
  const dateNoHyphen = snapshotDate.replace(/-/g, "");
  const propsUrl = `${SUPABASE_URL}/rest/v1/props_cache?sport=eq.mlb&or=(game_date.eq.${snapshotDate},game_date.eq.${dateNoHyphen})&prop_type=eq.pitcher_strikeouts&select=player_name`;
  let names: string[] = [];
  try {
    const r = await fetch(propsUrl, { headers: supaHeaders() });
    if (r.ok) {
      const rows = await r.json() as Array<{ player_name: string }>;
      names = Array.from(new Set(rows.map(r => r.player_name).filter(Boolean)));
    }
  } catch { /* swallow */ }

  const pidByName = new Map<string, number>();
  await Promise.all(names.map(async (n) => {
    const pid = await lookupPlayerId(n);
    if (pid) pidByName.set(n, pid);
  }));

  // Source 2: today's probable pitchers from MLB schedule (direct MLBAMID)
  const scheduleUrl = `${MLB_STATS_BASE}/schedule?sportId=1&date=${snapshotDate}&hydrate=probablePitcher`;
  const probablePids = new Map<number, string>();
  try {
    const r = await quietFetch(scheduleUrl);
    if (r.ok) {
      const j = JSON.parse(r.text);
      for (const dt of j?.dates ?? []) {
        for (const g of dt?.games ?? []) {
          for (const side of ["home", "away"] as const) {
            const pp = g?.teams?.[side]?.probablePitcher;
            if (pp?.id && pp?.fullName) probablePids.set(pp.id, pp.fullName);
          }
        }
      }
    }
  } catch { /* swallow */ }

  const targets = new Map<number, string>();
  for (const [name, pid] of pidByName.entries()) targets.set(pid, name);
  for (const [pid, name] of probablePids.entries()) {
    if (!targets.has(pid)) targets.set(pid, name);
  }

  if (targets.size === 0) {
    await writeHeartbeat({ jobName: "fetch-mlb-pitcher-splits", status: "partial", durationMs: Date.now() - start, error: "no pitchers found" });
    return jsonResponse({ success: true, snapshot_date: snapshotDate, pitchers_found: 0 });
  }

  let resolved = 0, failed = 0, upserted = 0;
  const rows: SplitsRow[] = [];
  for (const [pid, name] of targets.entries()) {
    const row = await fetchSplits(pid, name, snapshotDate);
    if (!row) { failed++; continue; }
    if (row.pa_vs_lhb || row.pa_vs_rhb) {
      rows.push(row);
      resolved++;
    }
  }

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_pitcher_splits?on_conflict=player_id,snapshot_date`, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
      if (r.ok) upserted += chunk.length;
    } catch { /* swallow */ }
  }

  const durationMs = Date.now() - start;
  await writeHeartbeat({ jobName: "fetch-mlb-pitcher-splits", status: failed === 0 ? "success" : (upserted > 0 ? "partial" : "error"), durationMs });

  return jsonResponse({
    success: true, snapshot_date: snapshotDate,
    prop_names_queried: names.length,
    probable_pids_added: probablePids.size,
    targets_total: targets.size,
    splits_resolved: resolved, upserted, failed,
    duration_ms: durationMs,
  });
});
