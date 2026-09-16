// D-289 PHASE 4 — historical MLB outcomes backfill (FREE).
//
// For each event in cache_mlb_historical_events with
// outcomes_backfill_status='pending', resolve gamePk via MLB Stats
// API schedule lookup, then pull boxscore and extract per-player
// stats. Upserts into cache_mlb_historical_outcomes.
//
// Cost: $0 (MLB Stats API is free).
// Chunkable via body.max_events.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { tryAcquireLock, releaseLock } from "../_shared/function_lock.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const supaHeaders = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

const MLB = "https://statsapi.mlb.com/api/v1";

function normalizeTeam(name: string): string {
  // MLB Stats API and Odds API use slightly different naming. Normalize for matching.
  return name.toLowerCase().replace(/^the /, "").replace(/[^a-z0-9 ]/g, "").trim();
}

async function findGamePk(commenceTime: string, homeTeam: string, awayTeam: string): Promise<number | null> {
  // Use date portion of commence_time
  const date = commenceTime.slice(0, 10);
  const url = `${MLB}/schedule?sportId=1&date=${date}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json() as { dates?: Array<{ games?: Array<{ gamePk?: number; teams?: { home?: { team?: { name?: string } }; away?: { team?: { name?: string } } } }> }> };
    const home = normalizeTeam(homeTeam);
    const away = normalizeTeam(awayTeam);
    for (const dt of d.dates ?? []) {
      for (const g of dt.games ?? []) {
        const h = normalizeTeam(g.teams?.home?.team?.name ?? "");
        const a = normalizeTeam(g.teams?.away?.team?.name ?? "");
        if (h === home && a === away) return g.gamePk ?? null;
      }
    }
    return null;
  } catch { return null; }
}

interface BoxscoreStat { atBats?: number; plateAppearances?: number; hits?: number; doubles?: number; triples?: number; homeRuns?: number; rbi?: number; baseOnBalls?: number; totalBases?: number; strikeOuts?: number }
interface BoxscorePitchStat { inningsPitched?: string | number; hits?: number; runs?: number; earnedRuns?: number; baseOnBalls?: number; strikeOuts?: number; battersFaced?: number; homeRuns?: number }
interface BoxscorePlayer { person?: { fullName?: string }; stats?: { batting?: BoxscoreStat; pitching?: BoxscorePitchStat } }

async function fetchBoxscore(gamePk: number): Promise<{
  home_score: number | null; away_score: number | null; completed: boolean;
  resolution_data: Record<string, { hits?: number; total_bases?: number; home_runs?: number; rbi?: number; at_bats?: number; pa?: number; strikeouts?: number; innings_pitched?: number }>;
} | null> {
  try {
    const r = await fetch(`${MLB}/game/${gamePk}/boxscore`);
    if (!r.ok) return null;
    const d = await r.json() as { teams?: { home?: { teamStats?: { batting?: { runs?: number } }; players?: Record<string, BoxscorePlayer> }; away?: { teamStats?: { batting?: { runs?: number } }; players?: Record<string, BoxscorePlayer> } } };
    const homeScore = d.teams?.home?.teamStats?.batting?.runs ?? null;
    const awayScore = d.teams?.away?.teamStats?.batting?.runs ?? null;
    const completed = homeScore !== null && awayScore !== null;
    const resolution_data: Record<string, { hits?: number; total_bases?: number; home_runs?: number; rbi?: number; at_bats?: number; pa?: number; strikeouts?: number; innings_pitched?: number }> = {};
    for (const side of ["home", "away"] as const) {
      const players = d.teams?.[side]?.players ?? {};
      for (const p of Object.values(players)) {
        const name = p?.person?.fullName;
        if (!name) continue;
        const bat = p?.stats?.batting;
        const pit = p?.stats?.pitching;
        const entry: { hits?: number; total_bases?: number; home_runs?: number; rbi?: number; at_bats?: number; pa?: number; strikeouts?: number; innings_pitched?: number } = {};
        if (bat) {
          if (bat.atBats !== undefined) entry.at_bats = bat.atBats;
          if (bat.plateAppearances !== undefined) entry.pa = bat.plateAppearances;
          if (bat.hits !== undefined) entry.hits = bat.hits;
          if (bat.totalBases !== undefined) entry.total_bases = bat.totalBases;
          if (bat.homeRuns !== undefined) entry.home_runs = bat.homeRuns;
          if (bat.rbi !== undefined) entry.rbi = bat.rbi;
        }
        if (pit) {
          if (pit.strikeOuts !== undefined) entry.strikeouts = pit.strikeOuts;
          if (pit.inningsPitched !== undefined) {
            const ipStr = String(pit.inningsPitched);
            const dot = ipStr.indexOf(".");
            entry.innings_pitched = dot < 0 ? Number(ipStr) : Number(ipStr.slice(0, dot)) + Number(ipStr.slice(dot + 1)) / 3;
          }
        }
        if (Object.keys(entry).length > 0) {
          resolution_data[name] = entry;
        }
      }
    }
    return { home_score: homeScore, away_score: awayScore, completed, resolution_data };
  } catch { return null; }
}

async function concurrentMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i]); } catch { /* swallow */ }
    }
  });
  await Promise.all(workers);
  return results;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return j({ error: "missing env" }, 500);
  const auth = req.headers.get("authorization") || "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  // D-291 SHIP 1 — mutex
  const LOCK_KEY = "fetch-historical-outcomes-mlb";
  const lock = await tryAcquireLock(LOCK_KEY, 900, `${Date.now()}`);
  if (!lock.acquired) {
    return j({ blocked: true, reason: "concurrent_instance_already_running", lock_state: lock });
  }

  let body: { max_events?: number } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const maxEvents = Math.min(body.max_events ?? 200, 500);

  const start = Date.now();
  try {
  const eventsUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?outcomes_backfill_status=eq.pending&order=commence_time.asc&limit=${maxEvents}&select=event_id,commence_time,home_team,away_team`;
  const er = await fetch(eventsUrl, { headers: supaHeaders() });
  if (!er.ok) { await releaseLock(LOCK_KEY); return j({ error: `events fetch ${er.status}` }, 500); }
  const events = await er.json() as Array<{ event_id: string; commence_time: string; home_team: string; away_team: string }>;

  let outcomesUpserted = 0;
  let gamesNotFound = 0;
  let boxscoreFailed = 0;
  const errors: string[] = [];

  await concurrentMap(events, async (ev) => {
    if (Date.now() - start > 130_000) return;
    try {
      const gamePk = await findGamePk(ev.commence_time, ev.home_team, ev.away_team);
      if (!gamePk) {
        gamesNotFound++;
        // mark as 'no_match' so we don't retry on next loop
        await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?event_id=eq.${ev.event_id}`, {
          method: "PATCH",
          headers: { ...supaHeaders(), Prefer: "return=minimal" },
          body: JSON.stringify({ outcomes_backfill_status: "no_match" }),
        });
        return;
      }
      const bx = await fetchBoxscore(gamePk);
      if (!bx) { boxscoreFailed++; return; }
      const row = {
        event_id: ev.event_id, commence_time: ev.commence_time,
        home_team: ev.home_team, away_team: ev.away_team,
        home_score: bx.home_score, away_score: bx.away_score,
        game_completed: bx.completed, game_pk: gamePk,
        resolution_data: bx.resolution_data,
      };
      const up = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?on_conflict=event_id`, {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(row),
      });
      if (up.ok) {
        outcomesUpserted++;
        // Checkpoint
        await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?event_id=eq.${ev.event_id}`, {
          method: "PATCH",
          headers: { ...supaHeaders(), Prefer: "return=minimal" },
          body: JSON.stringify({ outcomes_backfill_status: "complete", outcomes_backfill_at: new Date().toISOString(), game_pk: gamePk }),
        });
      } else {
        errors.push(`${ev.event_id} upsert: ${up.status}`);
      }
    } catch (e) {
      errors.push(`${ev.event_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 8);

  return j({
    success: true,
    events_requested: events.length,
    outcomes_upserted: outcomesUpserted,
    games_not_found: gamesNotFound,
    boxscore_failed: boxscoreFailed,
    errors_sample: errors.slice(0, 10),
    duration_ms: Date.now() - start,
    lock_acquired: true,
  });
  } finally {
    await releaseLock(LOCK_KEY);
  }
});
