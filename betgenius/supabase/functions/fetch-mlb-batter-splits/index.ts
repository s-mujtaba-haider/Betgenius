// fetch-mlb-batter-splits — D-282 SHIP 1.
//
// Pulls MLB batter splits vs LHP / RHP for every batter who has a
// pick today, and upserts into cache_mlb_batter_splits. Manual
// trigger this batch; daily cron schedule deferred to D-283.
//
// Implementation: pull distinct player_id from props_cache for
// today's slate; for each, fetch MLB Stats API
// /people/{id}/stats?stats=statSplits&sitCodes=vl,vr&group=hitting.
// This bounds API calls to ~200 max (size of today's batter prop pool)
// rather than full 750-player active roster.

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
    // Exact-case-insensitive match preferred
    const exact = people.find(p => p.fullName.toLowerCase() === name.toLowerCase());
    return (exact ?? people[0]).id;
  } catch { return null; }
}

interface SplitsRow {
  player_id: number;
  snapshot_date: string;
  player_name: string;
  vs_lhp_pa: number | null; vs_lhp_atbats: number | null; vs_lhp_hits: number | null;
  vs_lhp_avg: number | null; vs_lhp_obp: number | null; vs_lhp_slg: number | null;
  vs_lhp_ops: number | null; vs_lhp_hr: number | null; vs_lhp_tb: number | null; vs_lhp_rbi: number | null;
  vs_rhp_pa: number | null; vs_rhp_atbats: number | null; vs_rhp_hits: number | null;
  vs_rhp_avg: number | null; vs_rhp_obp: number | null; vs_rhp_slg: number | null;
  vs_rhp_ops: number | null; vs_rhp_hr: number | null; vs_rhp_tb: number | null; vs_rhp_rbi: number | null;
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
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=statSplits&sitCodes=vl,vr&group=hitting&season=2026`;
  const r = await quietFetch(url);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.text);
    const splits = j?.stats?.[0]?.splits ?? [];
    // Splits have a `split` object indicating which situation. vl = vs LHP, vr = vs RHP
    const row: SplitsRow = {
      player_id: playerId, snapshot_date: snapshotDate, player_name: playerName,
      vs_lhp_pa: null, vs_lhp_atbats: null, vs_lhp_hits: null, vs_lhp_avg: null, vs_lhp_obp: null,
      vs_lhp_slg: null, vs_lhp_ops: null, vs_lhp_hr: null, vs_lhp_tb: null, vs_lhp_rbi: null,
      vs_rhp_pa: null, vs_rhp_atbats: null, vs_rhp_hits: null, vs_rhp_avg: null, vs_rhp_obp: null,
      vs_rhp_slg: null, vs_rhp_ops: null, vs_rhp_hr: null, vs_rhp_tb: null, vs_rhp_rbi: null,
    };
    for (const s of splits) {
      const code = s?.split?.code ?? "";
      const stat = s?.stat ?? {};
      const prefix = code === "vl" ? "vs_lhp" : code === "vr" ? "vs_rhp" : null;
      if (!prefix) continue;
      (row as any)[`${prefix}_pa`] = int(stat.plateAppearances);
      (row as any)[`${prefix}_atbats`] = int(stat.atBats);
      (row as any)[`${prefix}_hits`] = int(stat.hits);
      (row as any)[`${prefix}_avg`] = num(stat.avg);
      (row as any)[`${prefix}_obp`] = num(stat.obp);
      (row as any)[`${prefix}_slg`] = num(stat.slg);
      (row as any)[`${prefix}_ops`] = num(stat.ops);
      (row as any)[`${prefix}_hr`] = int(stat.homeRuns);
      (row as any)[`${prefix}_tb`] = int(stat.totalBases);
      (row as any)[`${prefix}_rbi`] = int(stat.rbi);
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

  // D-286 SHIP 1 RETRY — gather batter IDs from TWO sources:
  //   1. Today's props_cache (existing path — name lookup via /people/search)
  //   2. Today's MLB schedule boxscore lineups (NEW — direct MLBAMID per
  //      starting batter, no name-lookup risk). This captures the 30-40%
  //      lineup batters that lacked offered props → were missing from cache.
  const dateNoHyphen = snapshotDate.replace(/-/g, "");
  const propsUrl = `${SUPABASE_URL}/rest/v1/props_cache?sport=eq.mlb&or=(game_date.eq.${snapshotDate},game_date.eq.${dateNoHyphen})&prop_type=in.(hits,total_bases,rbis,home_runs)&select=player_name`;
  let names: string[] = [];
  try {
    const r = await fetch(propsUrl, { headers: supaHeaders() });
    if (r.ok) {
      const rows = await r.json() as Array<{ player_name: string }>;
      names = Array.from(new Set(rows.map(r => r.player_name).filter(Boolean)));
    }
  } catch { /* swallow */ }

  // Resolve prop names to pids (parallel)
  const pidByName = new Map<string, number>();
  await Promise.all(names.map(async (n) => {
    const pid = await lookupPlayerId(n);
    if (pid) pidByName.set(n, pid);
  }));

  // D-286 — add today's scheduled game lineup batters directly via boxscore.
  // Yields MLBAMIDs without name-lookup risk + fills the splits-coverage gap.
  const scheduleUrl = `${MLB_STATS_BASE}/schedule?sportId=1&date=${snapshotDate}`;
  const lineupPids = new Map<number, string>();  // pid → fullName
  try {
    const r = await quietFetch(scheduleUrl);
    if (r.ok) {
      const j = JSON.parse(r.text);
      const gamePks: number[] = [];
      for (const dt of j?.dates ?? []) for (const g of dt?.games ?? []) if (g?.gamePk) gamePks.push(g.gamePk);
      // Concurrent boxscore fetches (cap concurrency to be polite to MLB API)
      await Promise.all(gamePks.slice(0, 20).map(async (pk) => {
        try {
          const bx = await quietFetch(`${MLB_STATS_BASE}/game/${pk}/boxscore`);
          if (!bx.ok) return;
          const bd = JSON.parse(bx.text) as {
            teams?: {
              home?: { players?: Record<string, { person?: { id?: number; fullName?: string }; battingOrder?: string }> };
              away?: { players?: Record<string, { person?: { id?: number; fullName?: string }; battingOrder?: string }> };
            };
          };
          for (const side of ["home", "away"] as const) {
            const players = bd?.teams?.[side]?.players ?? {};
            for (const p of Object.values(players)) {
              const order = p?.battingOrder ?? "";
              if (order.length === 3 && order.endsWith("00") && p?.person?.id && p?.person?.fullName) {
                lineupPids.set(p.person.id, p.person.fullName);
              }
            }
          }
        } catch { /* swallow per-game */ }
      }));
    }
  } catch { /* swallow */ }

  // Union both sources — keyed by pid to avoid duplicate fetches
  const targets = new Map<number, string>();
  for (const [name, pid] of pidByName.entries()) targets.set(pid, name);
  for (const [pid, name] of lineupPids.entries()) {
    if (!targets.has(pid)) targets.set(pid, name);
  }

  if (targets.size === 0) {
    await writeHeartbeat({ jobName: "fetch-mlb-batter-splits", status: "partial", durationMs: Date.now() - start, error: "no batters found in props_cache or today's lineups" });
    return jsonResponse({ success: true, snapshot_date: snapshotDate, batters_found: 0 });
  }

  // For each target: fetch splits, upsert
  let resolved = 0, failed = 0, upserted = 0;
  const rows: SplitsRow[] = [];
  for (const [pid, name] of targets.entries()) {
    const row = await fetchSplits(pid, name, snapshotDate);
    if (!row) { failed++; continue; }
    // Only persist if at least one split has PAs
    if (row.vs_lhp_pa || row.vs_rhp_pa) {
      rows.push(row);
      resolved++;
    }
  }

  // Bulk upsert in chunks of 100
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_batter_splits?on_conflict=player_id,snapshot_date`, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
      if (r.ok) upserted += chunk.length;
    } catch { /* swallow */ }
  }

  const durationMs = Date.now() - start;
  await writeHeartbeat({ jobName: "fetch-mlb-batter-splits", status: failed === 0 ? "success" : (upserted > 0 ? "partial" : "error"), durationMs });

  return jsonResponse({
    success: true, snapshot_date: snapshotDate,
    prop_names_queried: names.length,
    lineup_pids_added: lineupPids.size,
    targets_total: targets.size,
    splits_resolved: resolved, upserted, failed,
    duration_ms: durationMs,
  });
});
