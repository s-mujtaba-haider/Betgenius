// snapshot-opp-stats — daily true opponent-allowed RPG/APG snapshot via BDL
// /v1/stats per-game aggregation (May 7, 2026, closes long-standing C26-B).
//
// PROBLEM: cache_opponent_defensive_stats.rpg_allowed and .apg_allowed
// columns are populated by process-games via ESPN team-stats endpoint, but
// ESPN's "rebounds" and "assists" fields return the team's OWN values, not
// opponents-allowed. So the columns have correct NAMES but wrong DATA. C26-A
// fixed this for points (BDL def_rating) and points-derived props (PRA/PA/PR).
// C26-B is the rebounds/assists fix.
//
// SOLUTION: aggregate BDL /v1/stats per-game data for each NBA team's recent
// games, sum opponent rebounds + assists across those games, average. That's
// the true "what opponents scored against this team" RPG/APG.
//
// API budget per snapshot run:
//   30 teams × (1 games-list call + 10 per-game stats calls) = ~330 BDL calls
//   At ALL-STAR ~600 req/min: ~33 sec wall-clock
//
// SCHEMA: writes to new columns rpg_allowed_bdl + apg_allowed_bdl + sets
// opp_stats_source='bdl_aggregated'. Existing rpg_allowed + apg_allowed
// columns untouched (legacy ESPN path stays for transition fallback).
//
// AUTH: service-role gated via BACKFILL_AUTH_TOKEN (or stale SUPABASE_*
// fallbacks). Anonymous calls 401.
//
// SCHEDULE: pg_cron daily at 12:00 UTC (8am ET) — runs before 10am ET
// process-games window so today's slate scores against fresh BDL aggregates.
// Schedule SQL command in /tmp/c26b_summary_may7.md (CEO sets via SQL editor).
//
// IDEMPOTENT: full UPSERT pattern keyed on (team_name, snapshot_date, sport).
// Re-running for the same date overwrites prior values without conflict.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";

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

// Smaller sample (5 games) than initially planned — empirical 429s confirmed
// BDL ALL-STAR tier is 60 req/min, not 600. With 11 calls/team × 30 teams =
// 330 calls hit the limit at team 7. New strategy: 5 games/team + BATCHED
// stats fetching via game_ids[] multi-value query string. Total ~37 calls.
const RECENT_GAMES_PER_TEAM = 5;
const STATS_BATCH_SIZE = 20; // BDL accepts game_ids[] array; per_page max 100
const BDL_API_BASE = "https://api.balldontlie.io/v1";
// Empirical NBA per-game ranges (sanity-clamp aggregated values)
const RPG_MIN = 30, RPG_MAX = 60;
const APG_MIN = 18, APG_MAX = 35;

interface BdlTeam {
  id: number;
  full_name: string;
  abbreviation: string;
}

interface BdlGame {
  id: number;
  date: string;
  status: string;
  home_team: { id: number };
  visitor_team: { id: number };
}

interface BdlStat {
  player: { id: number; first_name: string; last_name: string };
  team: { id: number };
  game: { id: number; home_team_id: number; visitor_team_id: number };
  reb: number | null;
  ast: number | null;
  min: string | null;
}

// Throttling state — empirically confirmed BDL ALL-STAR tier on this
// project's key is 60/min (after ~67 calls in <14s we hit 429s on every
// subsequent call, classic token-bucket exhaustion). Setting 1100ms gap =
// ~55/min sustained, comfortable cushion under the limit. Phase 1 (30
// /games calls) takes ~33s; Phase 2 (~6 batched /stats calls) takes ~7s;
// total ~40s plus DB writes — well inside the 150s edge function ceiling.
let lastBdlCallMs = 0;
const MIN_CALL_GAP_MS = 1100;

async function fetchBdl<T>(path: string, key: string): Promise<{ data: T | null; status: number; bodyHint: string }> {
  // Throttle — sleep until at least MIN_CALL_GAP_MS has passed since previous call
  const now = Date.now();
  const sinceLast = now - lastBdlCallMs;
  if (sinceLast < MIN_CALL_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_CALL_GAP_MS - sinceLast));
  }
  lastBdlCallMs = Date.now();
  try {
    const res = await fetch(`${BDL_API_BASE}${path}`, {
      headers: { Authorization: key },
    });
    const text = await res.text();
    if (!res.ok) {
      return { data: null, status: res.status, bodyHint: text.slice(0, 200) };
    }
    try {
      return { data: JSON.parse(text) as T, status: res.status, bodyHint: "" };
    } catch (_e) {
      return { data: null, status: res.status, bodyHint: "json parse failed" };
    }
  } catch (e) {
    return { data: null, status: 0, bodyHint: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchAllTeams(bdlKey: string): Promise<BdlTeam[]> {
  const r = await fetchBdl<{ data: BdlTeam[] }>("/teams", bdlKey);
  if (!r.data || !Array.isArray(r.data.data)) return [];
  // BDL /v1/teams returns 30 NBA + a few legacy/historic teams. NBA team IDs
  // are 1-30 inclusive; filter to those.
  return r.data.data.filter((t) => t.id >= 1 && t.id <= 30);
}

async function fetchRecentGames(
  bdlKey: string, teamId: number,
): Promise<{ games: BdlGame[]; lastError: string | null }> {
  // Single query — multi-season fallbacks were burning rate-limit budget on
  // 429s without solving anything. The 2025-26 regular season is sufficient
  // for current snapshot (regular season runs October through April; we're
  // still inside the season window or just past it for snapshot purposes).
  const q = `/games?team_ids[]=${teamId}&seasons[]=2025&per_page=${RECENT_GAMES_PER_TEAM * 2}&sort=date&order=desc`;
  const r = await fetchBdl<{ data: BdlGame[] }>(q, bdlKey);
  if (r.status !== 200) {
    return { games: [], lastError: `status=${r.status} hint=${r.bodyHint}` };
  }
  if (!r.data || !Array.isArray(r.data.data)) {
    return { games: [], lastError: "status=200 but no data array" };
  }
  const finals = r.data.data
    .filter((g) => g.status === "Final")
    .slice(0, RECENT_GAMES_PER_TEAM);
  if (finals.length === 0) {
    return { games: [], lastError: `status=200 but 0 Final games (got ${r.data.data.length} total)` };
  }
  return { games: finals, lastError: null };
}

async function fetchGameStats(bdlKey: string, gameId: number): Promise<BdlStat[]> {
  const r = await fetchBdl<{ data: BdlStat[] }>(
    `/stats?game_ids[]=${gameId}&per_page=100`,
    bdlKey,
  );
  if (!r.data || !Array.isArray(r.data.data)) return [];
  return r.data.data;
}

// Batched stats fetcher — pulls stats for up to STATS_BATCH_SIZE games per call.
// Returns map game_id → BdlStat[]. Pagination via cursor handled if needed.
async function fetchStatsBatch(bdlKey: string, gameIds: number[]): Promise<Map<number, BdlStat[]>> {
  const result = new Map<number, BdlStat[]>();
  for (const gid of gameIds) result.set(gid, []);
  if (gameIds.length === 0) return result;
  const ids = gameIds.map((g) => `game_ids[]=${g}`).join("&");
  // per_page=100 + cursor pagination if response indicates more pages
  let cursor = "";
  let safety = 0;
  while (safety++ < 10) {
    const cursorParam = cursor ? `&cursor=${cursor}` : "";
    const r = await fetchBdl<{ data: BdlStat[]; meta?: { next_cursor?: string | null } }>(
      `/stats?${ids}&per_page=100${cursorParam}`,
      bdlKey,
    );
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.data)) break;
    for (const stat of r.data.data) {
      const gid = stat.game?.id;
      if (typeof gid !== "number") continue;
      const arr = result.get(gid);
      if (arr) arr.push(stat);
    }
    const next = r.data.meta?.next_cursor;
    if (!next) break;
    cursor = String(next);
  }
  return result;
}

// (Old per-team-serial aggregator removed in favor of three-phase batched
// approach inline in handler. fetchGameStats single-call helper retained for
// possible future use but unused on the hot path.)
async function _unused_aggregateOpponentAllowed_keptForReference(
  bdlKey: string,
  teamId: number,
): Promise<{
  games_used: number;
  rpg_allowed: number | null;
  apg_allowed: number | null;
  api_calls: number;
  error: string | null;
}> {
  let apiCalls = 0;
  const { games, lastError } = await fetchRecentGames(bdlKey, teamId);
  apiCalls += lastError ? 3 : 1;
  if (games.length === 0) {
    return { games_used: 0, rpg_allowed: null, apg_allowed: null, api_calls: apiCalls, error: lastError };
  }

  let totalRebounds = 0;
  let totalAssists = 0;
  let gamesUsed = 0;

  for (const g of games) {
    const stats = await fetchGameStats(bdlKey, g.id);
    apiCalls++;
    if (stats.length === 0) continue;

    // Filter to OPPONENT players: rows where stat.team.id !== teamId
    const opponentStats = stats.filter((s) => s.team?.id !== teamId);
    if (opponentStats.length === 0) continue;

    const gameRebounds = opponentStats.reduce((sum, s) => sum + (s.reb ?? 0), 0);
    const gameAssists = opponentStats.reduce((sum, s) => sum + (s.ast ?? 0), 0);

    totalRebounds += gameRebounds;
    totalAssists += gameAssists;
    gamesUsed++;
  }

  if (gamesUsed === 0) {
    return { games_used: 0, rpg_allowed: null, apg_allowed: null, api_calls: apiCalls, error: "all stats calls returned empty" };
  }

  const rpg = totalRebounds / gamesUsed;
  const apg = totalAssists / gamesUsed;

  // Sanity clamp — values outside NBA empirical range likely indicate bad data
  const rpgClamped = (rpg >= RPG_MIN && rpg <= RPG_MAX) ? rpg : null;
  const apgClamped = (apg >= APG_MIN && apg <= APG_MAX) ? apg : null;

  return {
    games_used: gamesUsed,
    rpg_allowed: rpgClamped,
    apg_allowed: apgClamped,
    api_calls: apiCalls,
    error: null,
  };
}

async function logRunRow(
  url: string, key: string,
  teamsProcessed: number, apiCalls: number, errors: number, durationMs: number,
  status: string, notes: string,
): Promise<void> {
  try {
    await fetch(`${url}/rest/v1/run_log`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        function_name: "snapshot-opp-stats",
        duration_ms: durationMs,
        games_found: teamsProcessed,
        props_fetched: apiCalls,
        errors_count: errors,
        status,
        notes: notes.slice(0, 1000),
      }),
    });
  } catch (_e) { /* silent */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startMs = Date.now();
  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  // D-378 SHIP 2d — D-365 separation pattern.
  //   supaKey  → outgoing PostgREST apikey; MUST be SERVICE_ROLE_KEY only.
  //   gateAccept[] → tokens accepted on INCOMING gate.
  // Previously supaKey fell back to BACKFILL_AUTH_TOKEN which PostgREST
  // rejects as an apikey when it's a vault UUID.
  const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const backfillToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
  const gateAccept = [backfillToken, supaKey].filter(Boolean);
  const bdlKey = Deno.env.get("BALLDONTLIE_API_KEY") || "";

  if (!supaUrl || !supaKey) {
    return jsonResponse({ success: false, error: "edge function env missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }
  if (!bdlKey) {
    return jsonResponse({ success: false, error: "BALLDONTLIE_API_KEY not set" }, 500);
  }

  // Service-role auth gate
  const auth = req.headers.get("authorization") || "";
  const matches = gateAccept.some((t) => auth.includes(t));
  if (!matches) {
    return jsonResponse({ success: false, error: "service_role key required" }, 401);
  }

  // Snapshot date = today ET. matches process-games convention.
  const easternNow = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const snapshotDate = easternNow.toISOString().slice(0, 10);

  let teams: BdlTeam[] = [];
  try {
    teams = await fetchAllTeams(bdlKey);
  } catch (e) {
    const msg = `fetchAllTeams failed: ${e instanceof Error ? e.message : String(e)}`;
    await logRunRow(supaUrl, supaKey, 0, 0, 1, Date.now() - startMs, "failed", msg);
    return jsonResponse({ success: false, error: msg }, 500);
  }
  if (teams.length === 0) {
    await logRunRow(supaUrl, supaKey, 0, 0, 1, Date.now() - startMs, "failed", "no NBA teams returned from BDL");
    return jsonResponse({ success: false, error: "no NBA teams found" }, 500);
  }

  let totalApiCalls = 1; // /teams call
  let teamsProcessed = 0;
  let teamsFailed = 0;
  let teamsClamped = 0;
  const results: Array<{
    team_id: number; team_name: string; games_used: number;
    rpg_allowed: number | null; apg_allowed: number | null; error?: string;
  }> = [];
  const failureReasons: string[] = [];

  // PHASE 1: per-team /games fetches. 30 teams × 1 call = 30 BDL calls.
  // At MIN_CALL_GAP_MS=250ms throttle: ~7.5s wall clock.
  const teamGames = new Map<number, BdlGame[]>();
  for (const team of teams) {
    const { games, lastError } = await fetchRecentGames(bdlKey, team.id);
    totalApiCalls += lastError ? 3 : 1;
    teamGames.set(team.id, games);
    if (games.length === 0 && lastError) {
      failureReasons.push(`${team.full_name}: ${lastError}`);
    }
  }

  // PHASE 2: collect all unique game IDs, batch-fetch stats.
  // ~75-150 unique game IDs typical (some games shared between teams playing
  // each other recently). At STATS_BATCH_SIZE=20 = ~4-8 batched calls.
  const uniqueGameIds = new Set<number>();
  for (const games of teamGames.values()) {
    for (const g of games) uniqueGameIds.add(g.id);
  }
  const gameIdList = [...uniqueGameIds];
  const allStats = new Map<number, BdlStat[]>();
  for (let i = 0; i < gameIdList.length; i += STATS_BATCH_SIZE) {
    const batch = gameIdList.slice(i, i + STATS_BATCH_SIZE);
    const batchStats = await fetchStatsBatch(bdlKey, batch);
    totalApiCalls += Math.ceil(batch.length / 100) + 1; // rough — could include cursor pages
    for (const [gid, statsArr] of batchStats.entries()) {
      allStats.set(gid, statsArr);
    }
  }

  // PHASE 3: aggregate per-team using collected stats. No more BDL calls.
  for (const team of teams) {
    const games = teamGames.get(team.id) || [];
    if (games.length === 0) {
      teamsFailed++;
      results.push({
        team_id: team.id, team_name: team.full_name, games_used: 0,
        rpg_allowed: null, apg_allowed: null,
        error: failureReasons.find((r) => r.startsWith(team.full_name)) || "no games returned",
      });
      continue;
    }

    let totalRebounds = 0;
    let totalAssists = 0;
    let gamesUsed = 0;
    for (const g of games) {
      const stats = allStats.get(g.id) || [];
      if (stats.length === 0) continue;
      const opponentStats = stats.filter((s) => s.team?.id !== team.id);
      if (opponentStats.length === 0) continue;
      totalRebounds += opponentStats.reduce((sum, s) => sum + (s.reb ?? 0), 0);
      totalAssists += opponentStats.reduce((sum, s) => sum + (s.ast ?? 0), 0);
      gamesUsed++;
    }

    if (gamesUsed === 0) {
      teamsFailed++;
      results.push({
        team_id: team.id, team_name: team.full_name, games_used: 0,
        rpg_allowed: null, apg_allowed: null,
        error: "stats batch returned empty for all games",
      });
      continue;
    }

    const rpg = totalRebounds / gamesUsed;
    const apg = totalAssists / gamesUsed;
    const rpgClamped = (rpg >= RPG_MIN && rpg <= RPG_MAX) ? rpg : null;
    const apgClamped = (apg >= APG_MIN && apg <= APG_MAX) ? apg : null;
    if (rpgClamped === null || apgClamped === null) teamsClamped++;

    const upsertRes = await fetch(
      `${supaUrl}/rest/v1/cache_opponent_defensive_stats?on_conflict=team_name,snapshot_date,sport`,
      {
        method: "POST",
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          team_name: team.full_name,
          snapshot_date: snapshotDate,
          bdl_team_id: team.id,
          rpg_allowed_bdl: rpgClamped,
          apg_allowed_bdl: apgClamped,
          opp_stats_source: "bdl_aggregated",
          sport: "nba",
        }),
      },
    );
    if (upsertRes.ok) {
      teamsProcessed++;
      results.push({
        team_id: team.id, team_name: team.full_name, games_used: gamesUsed,
        rpg_allowed: rpgClamped, apg_allowed: apgClamped,
      });
    } else {
      teamsFailed++;
      results.push({
        team_id: team.id, team_name: team.full_name, games_used: gamesUsed,
        rpg_allowed: rpgClamped, apg_allowed: apgClamped,
        error: `upsert failed status=${upsertRes.status}`,
      });
    }
  }

  const durationMs = Date.now() - startMs;
  const status = teamsFailed === 0 ? "success" : (teamsProcessed > 0 ? "partial" : "failed");
  const notes = `teams=${teamsProcessed} failed=${teamsFailed} clamped=${teamsClamped} api_calls=${totalApiCalls}`;
  await logRunRow(supaUrl, supaKey, teamsProcessed, totalApiCalls, teamsFailed, durationMs, status, notes);

  if (teamsFailed > 5) {
    await notify({
      severity: "warning",
      title: "snapshot-opp-stats elevated failures",
      message: `${teamsFailed}/${teams.length} teams failed; ${teamsProcessed} succeeded`,
      metadata: { teams_failed: teamsFailed, teams_processed: teamsProcessed, api_calls: totalApiCalls },
    });
  }

  return jsonResponse({
    success: status !== "failed",
    snapshot_date: snapshotDate,
    teams_processed: teamsProcessed,
    teams_failed: teamsFailed,
    teams_clamped: teamsClamped,
    total_api_calls: totalApiCalls,
    duration_ms: durationMs,
    status,
    failure_reasons: failureReasons.slice(0, 5),
    sample: results.slice(0, 5),
  });
});
