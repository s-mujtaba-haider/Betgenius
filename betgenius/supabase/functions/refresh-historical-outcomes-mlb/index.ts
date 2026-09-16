// D-335 SHIP 0 — daily refresh of cache_mlb_historical_outcomes.
//
// D-334 backfilled 2026-03-20 → 2026-05-26 via one-shot Python script.
// Without ongoing refresh, the L10 cache decays by ~1 game per team per day.
// This function re-ingests the last 3 UTC days from MLB Stats API /schedule
// (free, no Odds API dependency — see D-334 SHIP 1 rationale for Path B).
// Idempotent: doubleheader gamePks are deduped intra-batch per D-334 fix.
//
// Schedule: pg_cron daily at 04:00 UTC (post-game-night, before next-day
// fetch-odds-mlb-30min window opens). Vault-based auth per D-313 pattern.
//
// Manual invoke: POST with optional {"days_back": N} to override default 3.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const supaHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "resolution=merge-duplicates,return=minimal",
});

const MLB = "https://statsapi.mlb.com/api/v1";

interface MlbGame {
  gamePk?: number;
  gameDate?: string;
  status?: { detailedState?: string };
  teams?: {
    home?: { team?: { name?: string }; score?: number };
    away?: { team?: { name?: string }; score?: number };
  };
}

async function fetchSchedule(startDate: string, endDate: string): Promise<MlbGame[]> {
  const url = `${MLB}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`schedule HTTP ${r.status}`);
  const d = await r.json() as { dates?: Array<{ games?: MlbGame[] }> };
  const games: MlbGame[] = [];
  for (const dt of d.dates ?? []) {
    for (const g of dt.games ?? []) games.push(g);
  }
  return games;
}

function dateStrUTC(dt: Date): string {
  return dt.toISOString().slice(0, 10);
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
  const daysBack = Math.max(1, Math.min(body.days_back ?? 3, 14));

  const now = new Date();
  const startDate = new Date(now.getTime() - daysBack * 86400_000);
  const startStr = dateStrUTC(startDate);
  const endStr = dateStrUTC(now);

  const t0 = Date.now();
  let games: MlbGame[] = [];
  try {
    games = await fetchSchedule(startStr, endStr);
  } catch (e) {
    return j({ error: `schedule fetch failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }

  const rowsByEventId = new Map<string, Record<string, unknown>>();
  let completed = 0;
  let skipped = 0;
  for (const g of games) {
    const gamePk = g.gamePk;
    if (!gamePk) { skipped++; continue; }
    const home = g.teams?.home?.team?.name;
    const away = g.teams?.away?.team?.name;
    const commence = g.gameDate;
    if (!home || !away || !commence) { skipped++; continue; }
    const status = g.status?.detailedState ?? "";
    const isCompleted = status === "Final" || status === "Game Over" || status === "Completed Early";
    if (isCompleted) completed++;
    rowsByEventId.set(`mlb_${gamePk}`, {
      event_id: `mlb_${gamePk}`,
      commence_time: commence,
      home_team: home,
      away_team: away,
      home_score: isCompleted ? (g.teams?.home?.score ?? null) : null,
      away_score: isCompleted ? (g.teams?.away?.score ?? null) : null,
      game_completed: isCompleted,
      game_pk: gamePk,
      resolution_data: {},
    });
  }

  const rows = [...rowsByEventId.values()];
  let upserted = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?on_conflict=event_id`, {
      method: "POST",
      headers: supaHeaders(),
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      errors.push(`batch ${i}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } else {
      upserted += batch.length;
    }
  }

  return j({
    success: errors.length === 0,
    date_range: `${startStr} → ${endStr}`,
    days_back: daysBack,
    games_seen: games.length,
    rows_upserted: upserted,
    completed_count: completed,
    skipped: skipped,
    errors_sample: errors.slice(0, 5),
    duration_ms: Date.now() - t0,
  });
});
