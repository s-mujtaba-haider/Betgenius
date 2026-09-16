// fetch-mlb-team-manager-hook-daily — D-763.
//
// Per-team manager-hook profile from MLB Stats API starter-only team
// aggregate (/teams/{id}/stats?stats=statSplits&sitCodes=sp&group=pitching).
// This is the REAL historical exit data D-761 proved necessary —
// D-668-FOLLOWUP-PULL-FEED is no longer queued.
//
// Source: ONE API call per team (30 total, ~10s with 350ms rate-limit).
// Output: row per (team_id, snapshot_date) into cache_mlb_team_manager_hook.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
const GAP_MS = 350;
let lastMs = 0;

async function mlbFetch<T>(path: string): Promise<T | null> {
  const wait = Math.max(0, GAP_MS - (Date.now() - lastMs));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastMs = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await fetch(`${MLB_API}${path}`, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
  finally { clearTimeout(t); }
}

function parseIp(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw);
  const [whole, third] = s.split(".");
  const w = Number(whole) || 0;
  const t = Number(third) || 0;
  return w + (t === 1 ? 0.333 : t === 2 ? 0.667 : 0);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPA_KEY)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const t0 = Date.now();
  const today = new Date();
  const eastern = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const season = new Date(eastern + "T12:00:00Z").getFullYear();

  // Pull all 30 active MLB teams
  type TeamsResp = { teams: Array<{ id: number; name: string }> };
  const teamsResp = await mlbFetch<TeamsResp>(`/teams?sportId=1&season=${season}&activeStatus=Active`);
  const teams = teamsResp?.teams ?? [];
  if (teams.length === 0) {
    return jsonResponse({ success: false, error: "no_teams" }, 500);
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const t of teams) {
    type SplitsResp = { stats: Array<{ splits: Array<{ split: { code?: string }; stat: Record<string, unknown> }> }> };
    const sp = await mlbFetch<SplitsResp>(
      `/teams/${t.id}/stats?stats=statSplits&group=pitching&season=${season}&sitCodes=sp&sportIds=1`,
    );
    const split = sp?.stats?.[0]?.splits?.find((s) => s?.split?.code === "sp");
    if (!split) continue;
    const stat = split.stat ?? {};
    const gs = stat.gamesStarted !== undefined && stat.gamesStarted !== null ? Number(stat.gamesStarted) : 0;
    if (gs < 1) continue;  // need at least 1 game to compute averages
    const ip = parseIp(stat.inningsPitched);
    const pitches = stat.numberOfPitches !== undefined && stat.numberOfPitches !== null
      ? Number(stat.numberOfPitches) : 0;
    const ppi = stat.pitchesPerInning !== undefined && stat.pitchesPerInning !== null
      ? Number(stat.pitchesPerInning) : null;
    const avgPpStart = pitches > 0 ? Math.round((pitches / gs) * 100) / 100 : null;
    const avgIpStart = ip > 0 ? Math.round((ip / gs) * 100) / 100 : null;
    // Hook index: negative = quick-hook manager (favor UNDER on pitcher_outs)
    // League avg starter pitches/start in 2026 is ~88 (down from 95+ over years).
    const hookIndex = avgPpStart !== null ? Math.round((avgPpStart - 88) * 100) / 100 : null;
    rows.push({
      team_id: t.id,
      team_name: t.name,
      snapshot_date: eastern,
      starter_games_started: gs,
      starter_ip: Math.round(ip * 10) / 10,
      starter_pitches: pitches,
      starter_pitches_per_inning: ppi,
      avg_pitches_per_start: avgPpStart,
      avg_ip_per_start: avgIpStart,
      hook_index: hookIndex,
    });
  }

  let upserted = 0;
  if (rows.length > 0) {
    const r = await fetch(`${SUPA_URL}/rest/v1/cache_mlb_team_manager_hook?on_conflict=team_id,snapshot_date`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (r.ok) upserted = rows.length;
  }

  // League avg + spread for the response (telemetry)
  const valid = rows.filter((r) => r.avg_pitches_per_start !== null);
  const leagueAvg = valid.length > 0
    ? Math.round((valid.reduce((a, r) => a + (r.avg_pitches_per_start as number), 0) / valid.length) * 100) / 100
    : null;
  const quickHooks = valid.filter((r) => (r.hook_index as number) < -3).map((r) => ({ team: r.team_name, hi: r.hook_index }));
  const patients   = valid.filter((r) => (r.hook_index as number) > +3).map((r) => ({ team: r.team_name, hi: r.hook_index }));

  return jsonResponse({
    success: true,
    snapshot_date: eastern,
    teams_seen: teams.length,
    rows_upserted: upserted,
    league_avg_pitches_per_start: leagueAvg,
    quick_hook_managers: quickHooks,
    patient_managers: patients,
    elapsed_ms: Date.now() - t0,
  });
});
