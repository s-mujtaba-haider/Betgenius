// fetch-mlb-bullpen-stats — D-283 SHIP 4.
//
// Pulls per-team relief-pitcher aggregates from MLB Stats API:
//   GET /teams/{teamId}/stats?stats=statSplits&group=pitching
//       &season={year}&sitCodes=rp
//
// Returns one split with description="Reliever" containing
// bullpen-only ERA / WHIP / IP / K9 / BB9 / BAA. Used by
// w_mlb_bullpen_quality factor.
//
// Iterates all 30 MLB teams. Daily cron 5 AM ET.

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

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// Fetch teams list (all 30 MLB) once per run.
async function fetchAllTeams(): Promise<Array<{ id: number; abbreviation: string; name: string }>> {
  const url = `${MLB_STATS_BASE}/teams?sportId=1&activeStatus=Yes`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const d = await res.json() as { teams?: Array<{ id?: number; abbreviation?: string; name?: string }> };
  return (d.teams ?? [])
    .filter((t) => t.id !== undefined)
    .map((t) => ({ id: t.id!, abbreviation: t.abbreviation ?? "", name: t.name ?? "" }));
}

interface TeamResult {
  team_id: number;
  team_abbrev: string;
  team_name: string;
  status: "success" | "no_data" | "error";
  bullpen_era?: number | null;
  bullpen_ip?: number | null;
  error?: string;
}

async function fetchTeamBullpen(teamId: number, year: number): Promise<{ era: number | null; whip: number | null; ip: number | null; k9: number | null; bb9: number | null; baa: number | null }> {
  const url = `${MLB_STATS_BASE}/teams/${teamId}/stats?stats=statSplits&group=pitching&season=${year}&sitCodes=rp`;
  const res = await fetch(url);
  if (!res.ok) return { era: null, whip: null, ip: null, k9: null, bb9: null, baa: null };
  const d = await res.json() as { stats?: Array<{ splits?: Array<{ stat?: Record<string, unknown>; split?: { code?: string } }> }> };
  const splits = d.stats?.[0]?.splits ?? [];
  const rp = splits.find((sp) => sp.split?.code === "rp");
  if (!rp || !rp.stat) return { era: null, whip: null, ip: null, k9: null, bb9: null, baa: null };
  const s = rp.stat;
  return {
    era: num(s.era),
    whip: num(s.whip),
    ip: num(s.inningsPitched),
    k9: num(s.strikeoutsPer9Inn),
    bb9: num(s.walksPer9Inn),
    baa: num(s.avg),
  };
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

  const teams = await fetchAllTeams();
  if (teams.length === 0) {
    await writeHeartbeat({ jobName: "fetch-mlb-bullpen-stats", status: "error", durationMs: Date.now() - start, error: "no teams returned" });
    return jsonResponse({ success: false, error: "no teams returned" }, 500);
  }

  const results: TeamResult[] = [];
  // Fetch sequentially to avoid hammering MLB API; 30 teams × ~200ms = ~6s
  for (const t of teams) {
    try {
      const b = await fetchTeamBullpen(t.id, year);
      if (b.era === null || b.ip === null) {
        results.push({ team_id: t.id, team_abbrev: t.abbreviation, team_name: t.name, status: "no_data" });
        continue;
      }
      const row = {
        team_id: t.id, team_abbrev: t.abbreviation, team_name: t.name,
        snapshot_date: snapshotDate,
        bullpen_era: b.era, bullpen_whip: b.whip, bullpen_ip: b.ip,
        bullpen_k_per_9: b.k9, bullpen_bb_per_9: b.bb9, bullpen_baa: b.baa,
      };
      const res = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_bullpen_stats?on_conflict=team_id,snapshot_date`, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
      if (res.ok) {
        results.push({ team_id: t.id, team_abbrev: t.abbreviation, team_name: t.name, status: "success", bullpen_era: b.era, bullpen_ip: b.ip });
      } else {
        results.push({ team_id: t.id, team_abbrev: t.abbreviation, team_name: t.name, status: "error", error: `upsert ${res.status}` });
      }
    } catch (e) {
      results.push({ team_id: t.id, team_abbrev: t.abbreviation, team_name: t.name, status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }

  const upserted = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;
  const noData = results.filter((r) => r.status === "no_data").length;

  await writeHeartbeat({
    jobName: "fetch-mlb-bullpen-stats",
    status: failed === 0 ? "success" : (upserted > 0 ? "partial" : "error"),
    durationMs: Date.now() - start,
    error: failed > 0 ? results.filter((r) => r.status === "error").map((r) => `${r.team_abbrev}:${r.error}`).join("; ") : null,
  });

  return jsonResponse({
    success: true,
    snapshot_date: snapshotDate,
    duration_ms: Date.now() - start,
    teams_processed: teams.length,
    upserted, failed, no_data: noData,
    results: results.slice(0, 10),  // sample
  });
});
