// fetch-mlb-pitcher-pen-extras-daily — D-664 SHIP 1 (C).
// Daily writer for 3 caches: cache_mlb_pitcher_last3, cache_mlb_pen_rest,
// cache_mlb_bullpen_high_leverage. Source: MLB Stats API.
//
// Cron: daily 11:00 UTC (before 13:00 UTC pregame window). One scheduled
// invocation; bounded compute (30 teams + roster fan-out).
//
// Outputs feed:
//   - score_sp_last3_form_v3  (reader: fetchPitcherSeasonAsOpposing)
//   - score_pen_rest_v3       (reader: readTeamSeasonContext)
//   - score_bob_quality_v3    (reader: readTeamSeasonContext)
//
// Memory: bounded — each fetch JSON parsed + discarded immediately.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
const GAP_MS = 350; // throttle MLB Stats API
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

  async function elog(phase: string, errorType: string, message: string, context: Record<string, unknown> = {}) {
    try {
      if (!SUPA_URL || !SUPA_KEY) return;
      await fetch(`${SUPA_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ function_name: "fetch-mlb-pitcher-pen-extras-daily", phase, error_type: errorType, error_message: message, context }),
      });
    } catch { /* swallow */ }
  }

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPA_KEY)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const t0 = Date.now();
  const today = new Date();
  const eastern = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const season = new Date(eastern + "T12:00:00Z").getFullYear();

  // Get all 30 MLB teams.
  const teamsRes = await mlbFetch<{ teams: Array<{ id: number; name: string }> }>(`/teams?sportId=1`);
  if (!teamsRes?.teams) {
    await elog("teams_list", "http_error", "MLB Stats API /teams?sportId=1 returned no teams", { eastern });
    return jsonResponse({ error: "teams fetch failed" }, 502);
  }
  const teams = teamsRes.teams.filter((t) => t.id < 1000);

  // ============================================================
  // PASS 1 — per-team relief IP last 48h (cache_mlb_pen_rest).
  //          + active roster scan for high-leverage arms.
  // ============================================================
  const penRestRows: Array<Record<string, unknown>> = [];
  const bullpenHlRows: Array<Record<string, unknown>> = [];
  const last3Rows: Array<Record<string, unknown>> = [];

  const startDate = new Date(today.getTime() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endDate = eastern;

  for (const team of teams) {
    // 1a) Relief IP in window — use sitCodes=rp (relief pitching) within date range.
    const penRes = await mlbFetch<{ stats: Array<{ splits: Array<{ stat: Record<string, unknown> }> }> }>(
      `/teams/${team.id}/stats?stats=byDateRange&group=pitching&sitCodes=rp&startDate=${startDate}&endDate=${endDate}&season=${season}`,
    );
    let penIp48h: number | null = null;
    let gamesIn48h: number | null = null;
    const stP = penRes?.stats?.[0]?.splits?.[0]?.stat;
    if (stP) {
      penIp48h = Math.round(parseIp(stP.inningsPitched) * 10) / 10;
      gamesIn48h = Number(stP.gamesPlayed ?? 0);
    }
    penRestRows.push({
      team_id: team.id, team_name: team.name, snapshot_date: eastern,
      pen_ip_48h: penIp48h, games_in_48h: gamesIn48h,
    });

    // 1b) Active roster — pull all pitchers, identify high-leverage arms.
    const rosterRes = await mlbFetch<{ roster: Array<{ person: { id: number; fullName: string }; position?: { code?: string; abbreviation?: string } }> }>(
      `/teams/${team.id}/roster?rosterType=active`,
    );
    const pitchers = (rosterRes?.roster ?? []).filter((p) => p.position?.code === "1" || p.position?.abbreviation === "P");

    let hlEraSum = 0;
    let hlArmCount = 0;
    for (const p of pitchers) {
      const pid = p.person.id;
      // Pull season pitching stats for THIS pitcher.
      const stRes = await mlbFetch<{ stats: Array<{ splits: Array<{ stat: Record<string, unknown> }> }> }>(
        `/people/${pid}/stats?stats=season&season=${season}&group=pitching`,
      );
      const stat = stRes?.stats?.[0]?.splits?.[0]?.stat;
      if (!stat) continue;
      const saveOpps = Number(stat.saveOpportunities ?? 0);
      const holds = Number(stat.holds ?? 0);
      const gamesStarted = Number(stat.gamesStarted ?? 0);
      const era = Number(stat.era ?? 0);
      const ip = parseIp(stat.inningsPitched);
      // High-leverage classifier: closer (saveOpps >= 5) OR setup man (holds >= 10),
      // and predominantly a reliever (gamesStarted == 0) with meaningful IP (>= 15).
      const isHL = (saveOpps >= 5 || holds >= 10) && gamesStarted === 0 && ip >= 15 && era > 0;
      if (isHL) {
        hlEraSum += era;
        hlArmCount += 1;
      }
    }
    bullpenHlRows.push({
      team_id: team.id, team_name: team.name, snapshot_date: eastern,
      hl_arm_count: hlArmCount,
      hl_avg_era: hlArmCount > 0 ? Math.round((hlEraSum / hlArmCount) * 100) / 100 : null,
    });
  }

  // ============================================================
  // PASS 2 — per active starting-pitcher last 3 starts ERA.
  // Targets: today's probable starters via /schedule + tomorrow's
  //          (so picks scored at any tick in next 36h have data).
  // ============================================================
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const schedRes = await mlbFetch<{ dates: Array<{ games: Array<{ teams: { home: { probablePitcher?: { id: number } }; away: { probablePitcher?: { id: number } } } }> }> }>(
    `/schedule?sportId=1&startDate=${eastern}&endDate=${tomorrow}&hydrate=probablePitcher`,
  );
  const probableIds = new Set<number>();
  for (const d of schedRes?.dates ?? []) {
    for (const g of d.games ?? []) {
      const homeId = g.teams?.home?.probablePitcher?.id;
      const awayId = g.teams?.away?.probablePitcher?.id;
      if (homeId) probableIds.add(homeId);
      if (awayId) probableIds.add(awayId);
    }
  }

  for (const pid of probableIds) {
    const logRes = await mlbFetch<{ stats: Array<{ splits: Array<{ stat: Record<string, unknown> }> }> }>(
      `/people/${pid}/stats?stats=gameLog&season=${season}&group=pitching`,
    );
    const splits = logRes?.stats?.[0]?.splits ?? [];
    // Splits are returned oldest-first; take the LAST 3 as the most recent.
    const last3 = splits.slice(-3);
    if (last3.length === 0) continue;
    let erSum = 0, ipSum = 0;
    for (const s of last3) {
      const er = Number(s.stat?.earnedRuns ?? 0);
      const ip = parseIp(s.stat?.inningsPitched);
      erSum += er;
      ipSum += ip;
    }
    const last3Era = ipSum >= 1.0 ? Math.round((erSum * 9 / ipSum) * 100) / 100 : null;
    last3Rows.push({
      player_id: pid, snapshot_date: eastern,
      last3_era: last3Era,
      last3_ip: Math.round(ipSum * 10) / 10,
      last3_starts: last3.length,
    });
  }

  // ============================================================
  // UPSERTS — 3 caches.
  // ============================================================
  async function upsert(table: string, conflictCols: string, rows: Array<Record<string, unknown>>) {
    if (rows.length === 0) return 0;
    const r = await fetch(`${SUPA_URL}/rest/v1/${table}?on_conflict=${conflictCols}`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      const eb = await r.text();
      await elog("upsert", "http_error", `${table} POST status=${r.status}: ${eb.slice(0, 300)}`, { eastern, rows_attempted: rows.length });
      return 0;
    }
    return rows.length;
  }

  const u1 = await upsert("cache_mlb_pen_rest", "team_id,snapshot_date", penRestRows);
  const u2 = await upsert("cache_mlb_bullpen_high_leverage", "team_id,snapshot_date", bullpenHlRows);
  const u3 = await upsert("cache_mlb_pitcher_last3", "player_id,snapshot_date", last3Rows);

  return jsonResponse({
    success: true,
    snapshot_date: eastern,
    pen_rest_rows: u1,
    bullpen_hl_rows: u2,
    pitcher_last3_rows: u3,
    probable_pitchers_seen: probableIds.size,
    teams_seen: teams.length,
    elapsed_ms: Date.now() - t0,
  });
});
