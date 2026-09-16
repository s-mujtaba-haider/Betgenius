// D-338 SHIP 3 — sweep stuck status='live' rows in cache_mlb_game_scoreboard.
//
// Root cause (D-324 side-bug surfaced in D-325): fetch-weather-4h writes rows
// only for today's ET game_date. West Coast late games end after midnight UTC
// in "In Progress" / "live" state at the 03:00 UTC tick. The next 03:00 UTC
// fire writes rows for a NEW game_date — yesterday's late-night games are
// never updated. Result: 29 rows stuck at status='live' spanning ~8 days.
//
// Fix: dedicated daily sweep that queries MLB Stats API per gamePk for the
// final status. Idempotent — re-running is safe.
//
// Schedule: pg_cron daily 06:00 UTC (after all late games end at 04-05 UTC).
//
// Manual mode: POST {"days_back": N} to sweep last N days (default 14).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const supaHeadersRO = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });
const supaHeadersRW = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=minimal",
});

const MLB = "https://statsapi.mlb.com/api/v1";

interface ScoreboardRow {
  game_id: number;
  game_date: string;
  status: string;
}

async function fetchStuckLiveRows(daysBack: number): Promise<ScoreboardRow[]> {
  const cutoff = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/cache_mlb_game_scoreboard?status=eq.live&game_date=gte.${cutoff}&game_date=lt.${today}&select=game_id,game_date,status&order=game_date.asc&limit=200`;
  const r = await fetch(url, { headers: supaHeadersRO() });
  if (!r.ok) return [];
  return await r.json();
}

interface MlbGameStatus {
  detailedState?: string;
  abstractGameState?: string;
}

async function fetchGameStatus(gamePk: number): Promise<{ status: string | null; homeScore: number | null; awayScore: number | null }> {
  try {
    const r = await fetch(`${MLB}/schedule?sportId=1&gamePk=${gamePk}`);
    if (!r.ok) return { status: null, homeScore: null, awayScore: null };
    const d = await r.json() as {
      dates?: Array<{
        games?: Array<{
          status?: MlbGameStatus;
          teams?: { home?: { score?: number }; away?: { score?: number } };
        }>;
      }>;
    };
    const game = d.dates?.[0]?.games?.[0];
    if (!game) return { status: null, homeScore: null, awayScore: null };
    const detailed = game.status?.detailedState ?? "";
    const abstract = game.status?.abstractGameState ?? "";
    const normalized = detailed.toLowerCase() === "postponed"
      ? "postponed"
      : detailed.toLowerCase() === "suspended"
        ? "suspended"
        : abstract.toLowerCase();
    return {
      status: normalized || null,
      homeScore: game.teams?.home?.score ?? null,
      awayScore: game.teams?.away?.score ?? null,
    };
  } catch {
    return { status: null, homeScore: null, awayScore: null };
  }
}

async function updateRow(gameId: number, gameDate: string, status: string, homeScore: number | null, awayScore: number | null): Promise<boolean> {
  const url = `${SUPABASE_URL}/rest/v1/cache_mlb_game_scoreboard?game_id=eq.${gameId}&game_date=eq.${gameDate}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: supaHeadersRW(),
    body: JSON.stringify({
      status,
      home_score: homeScore,
      away_score: awayScore,
      fetched_at: new Date().toISOString(),
    }),
  });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return j({ error: "missing env" }, 500);
  const auth = req.headers.get("authorization") || "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) {
    return j({ error: "unauthorized" }, 401);
  }

  let body: { days_back?: number } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const daysBack = Math.max(1, Math.min(body.days_back ?? 14, 60));

  const t0 = Date.now();
  const stuck = await fetchStuckLiveRows(daysBack);
  if (stuck.length === 0) {
    return j({ success: true, stuck_rows: 0, updated: 0, message: "no stuck rows", duration_ms: Date.now() - t0 });
  }

  let updated = 0;
  let still_live = 0;
  let fetch_fails = 0;
  const transitions: Record<string, number> = {};
  const errors: string[] = [];

  for (const row of stuck) {
    if (Date.now() - t0 > 130_000) break;
    const result = await fetchGameStatus(row.game_id);
    if (!result.status) {
      fetch_fails++;
      continue;
    }
    if (result.status === "live") {
      // Still actually live per MLB — leave alone. Rare but possible
      // for a suspended-game finish-the-next-day case.
      still_live++;
      continue;
    }
    const ok = await updateRow(row.game_id, row.game_date, result.status, result.homeScore, result.awayScore);
    if (ok) {
      updated++;
      transitions[result.status] = (transitions[result.status] ?? 0) + 1;
    } else {
      errors.push(`game ${row.game_id} (${row.game_date}) PATCH failed`);
    }
  }

  return j({
    success: errors.length === 0,
    days_back: daysBack,
    stuck_rows: stuck.length,
    updated,
    still_live,
    fetch_failures: fetch_fails,
    transitions,
    errors_sample: errors.slice(0, 5),
    duration_ms: Date.now() - t0,
  });
});
