// D-302 SHIP 3 — automated Dashboard health check.
//
// Compares MLB Stats API ground truth to cache_mlb_game_scoreboard
// and reports gaps per /docs/loop/playbooks/dashboard_audit_methodology.md.
// Surfaces postponements + doubleheaders + stale rows + status mismatches.
//
// Writes structured result to dashboard_health_log table; emits an
// error_log entry when verdict != healthy so existing alerting
// pipelines (Sentry / Slack via notifications_log) can pick it up.
//
// Cron: every 2 hours during MLB game window.
// AUTH: service-role or BACKFILL_AUTH_TOKEN.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

interface ApiGame {
  gamePk: number;
  homeTeam: string;
  awayTeam: string;
  abstractGameState: string;
  detailedState: string;
}
interface CacheRow {
  game_id: number;
  home_team: string;
  away_team: string;
  status: string;
  fetched_at: string;
}

interface Gap {
  type: "missing_in_cache" | "phantom_in_cache" | "status_mismatch" | "stale_fetched_at";
  game_pk?: number;
  cache_status?: string;
  detailed_state?: string;
  detail: string;
}

async function pullMlbSchedule(date: string): Promise<ApiGame[]> {
  const r = await fetch(`${MLB_STATS_BASE}/schedule?sportId=1&date=${date}`, {});
  if (!r.ok) return [];
  const d = await r.json() as { dates?: Array<{ games: Array<{ gamePk: number; teams: { home: { team: { name: string } }; away: { team: { name: string } } }; status: { abstractGameState: string; detailedState: string } }> }> };
  const games: ApiGame[] = [];
  for (const dt of (d.dates ?? [])) {
    for (const g of (dt.games ?? [])) {
      games.push({
        gamePk: g.gamePk,
        homeTeam: g.teams.home.team.name,
        awayTeam: g.teams.away.team.name,
        abstractGameState: g.status?.abstractGameState ?? "Preview",
        detailedState: g.status?.detailedState ?? "Scheduled",
      });
    }
  }
  return games;
}

async function pullCache(date: string): Promise<CacheRow[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_game_scoreboard?game_date=eq.${date}&select=game_id,home_team,away_team,status,fetched_at`, { headers: sH() });
  if (!r.ok) return [];
  return await r.json();
}

// Map MLB detailed → expected cache status (post D-300V fetch-weather fix).
function expectedCacheStatus(detailedState: string, abstractState: string): string {
  const d = detailedState.toLowerCase();
  if (d === "postponed") return "postponed";
  if (d === "suspended") return "suspended";
  // "Game Over" / "Final" both map to abstract "Final" — accept either as "final"
  return abstractState.toLowerCase();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  let body: { date?: string } = {};
  try { body = await req.json(); } catch { /* ok */ }
  const today = new Date();
  const eastern = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const date = body.date ?? eastern;

  const [apiGames, cacheRows] = await Promise.all([pullMlbSchedule(date), pullCache(date)]);

  const gaps: Gap[] = [];
  const apiByPk = new Map(apiGames.map(g => [g.gamePk, g]));
  const cacheByPk = new Map(cacheRows.map(r => [r.game_id, r]));

  // Missing in cache (in API but not in cache)
  for (const g of apiGames) {
    if (!cacheByPk.has(g.gamePk)) {
      gaps.push({ type: "missing_in_cache", game_pk: g.gamePk, detail: `${g.awayTeam} @ ${g.homeTeam} (${g.detailedState}) not in scoreboard` });
    }
  }
  // Phantom in cache (in cache but not in API)
  for (const r of cacheRows) {
    if (!apiByPk.has(r.game_id)) {
      gaps.push({ type: "phantom_in_cache", game_pk: r.game_id, cache_status: r.status, detail: `${r.away_team} @ ${r.home_team} in cache but not in MLB API schedule` });
    }
  }
  // Status mismatches (gamePk in both but status differs)
  for (const g of apiGames) {
    const c = cacheByPk.get(g.gamePk);
    if (!c) continue;
    const expected = expectedCacheStatus(g.detailedState, g.abstractGameState);
    if (c.status !== expected) {
      gaps.push({
        type: "status_mismatch",
        game_pk: g.gamePk,
        cache_status: c.status,
        detailed_state: g.detailedState,
        detail: `${g.awayTeam} @ ${g.homeTeam} cache=${c.status} MLB=${g.detailedState} (expected ${expected})`,
      });
    }
  }
  // Stale fetched_at (>12h ago for today's date)
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  for (const r of cacheRows) {
    if (r.fetched_at < twelveHoursAgo) {
      gaps.push({
        type: "stale_fetched_at",
        game_pk: r.game_id,
        cache_status: r.status,
        detail: `${r.away_team} @ ${r.home_team} fetched_at=${r.fetched_at}`,
      });
    }
  }

  const verdict = gaps.length === 0 ? "healthy" : (gaps.some(g => g.type === "missing_in_cache" || g.type === "phantom_in_cache") ? "degraded" : "warning");

  // Write to dashboard_health_log
  await fetch(`${SUPABASE_URL}/rest/v1/dashboard_health_log`, {
    method: "POST",
    headers: { ...sH(), Prefer: "return=minimal" },
    body: JSON.stringify({
      check_date: date,
      verdict,
      api_count: apiGames.length,
      cache_count: cacheRows.length,
      gap_count: gaps.length,
      gaps,
    }),
  });

  // Alert via error_log if not healthy
  if (verdict !== "healthy") {
    await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
      method: "POST",
      headers: { ...sH(), Prefer: "return=minimal" },
      body: JSON.stringify({
        function_name: "dashboard-health-check",
        error_message: `dashboard_health=${verdict} date=${date} gaps=${gaps.length}: ${gaps.slice(0, 3).map(g => g.detail).join(" | ")}`,
      }),
    });
  }

  return j({ success: true, date, verdict, api_count: apiGames.length, cache_count: cacheRows.length, gap_count: gaps.length, gaps });
});
