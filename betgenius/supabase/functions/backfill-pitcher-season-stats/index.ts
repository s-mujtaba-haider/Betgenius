// D-740 STEP 1B — Backfill cache_mlb_pitcher_season_stats from MLB Stats API.
//
// Source: same MLB Stats API endpoint process-games-mlb.fetchPitcherSeason consumes.
// `https://statsapi.mlb.com/api/v1/people/{playerId}/stats?stats=season&season=Y&group=pitching`
//
// Input: { player_ids: number[], season: number }
//   OR { season: number } → backfill for all distinct pitcher_ids in pitcher_k pick_history this season.
//
// Output: counts (backfilled, errors, skipped). Per-pitcher results written to cache.
//
// AUTH: service-role OR BACKFILL_AUTH_TOKEN.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
const sH = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

// MLB IP format: 6.1 = 6.333 IP; 6.2 = 6.667 IP
function parseInningsPitched(s: string | number | null | undefined): number {
  if (s === null || s === undefined) return 0;
  const str = String(s);
  if (!str.includes(".")) return Number(str) || 0;
  const [w, frac] = str.split(".");
  const fracVal = frac === "1" ? 1 / 3 : frac === "2" ? 2 / 3 : 0;
  return (Number(w) || 0) + fracVal;
}

interface SeasonResp {
  stats?: Array<{ splits?: Array<{ stat?: Record<string, unknown> }> }>;
}
interface PersonResp {
  people?: Array<{ pitchHand?: { code?: string } }>;
}

async function fetchSeasonStats(
  playerId: number,
  season: number,
): Promise<{
  full_name: string | null;
  throws: string | null;
  games_played: number;
  innings_pitched: number;
  strike_outs: number;
  batters_faced: number;
  k_per_nine: number;
  era: number;
  pitches_per_start: number | null;
  base_on_balls: number;
} | null> {
  // Season aggregate
  const url1 = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=season&season=${season}&group=pitching`;
  let r1: Response;
  try {
    r1 = await fetch(url1);
  } catch {
    return null;
  }
  if (!r1.ok) return null;
  let d1: SeasonResp;
  try {
    d1 = await r1.json() as SeasonResp;
  } catch {
    return null;
  }
  const split = d1.stats?.[0]?.splits?.[0];
  if (!split) return null;
  const s = (split.stat ?? {}) as Record<string, unknown>;
  const ip = parseInningsPitched(s.inningsPitched as string | number);
  const games = Number(s.gamesPlayed) || 0;
  const k = Number(s.strikeOuts) || 0;
  const bf = Number(s.battersFaced) || 0;
  const kPerNine = Number(s.strikeoutsPer9Inn) || 0;
  const era = Number(s.era) || 0;
  const pitches = Number(s.numberOfPitches);
  const pitchesPerStart = (games > 0 && Number.isFinite(pitches) && pitches > 0)
    ? pitches / games
    : null;
  const bb = Number(s.baseOnBalls) || 0;

  // Player hand + name
  let throws: string | null = null;
  let fullName: string | null = null;
  try {
    const url2 = `${MLB_STATS_BASE}/people/${playerId}`;
    const r2 = await fetch(url2);
    if (r2.ok) {
      const d2 = await r2.json() as { people?: Array<{ fullName?: string; pitchHand?: { code?: string } }> };
      const p = d2.people?.[0];
      throws = (p?.pitchHand?.code === "L" || p?.pitchHand?.code === "R") ? p.pitchHand.code : null;
      fullName = p?.fullName ?? null;
    }
  } catch { /* best-effort */ }

  return {
    full_name: fullName, throws,
    games_played: games, innings_pitched: ip,
    strike_outs: k, batters_faced: bf,
    k_per_nine: kPerNine, era, pitches_per_start: pitchesPerStart,
    base_on_balls: bb,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = req.headers.get("Authorization") ?? "";
  const ok = (SUPABASE_KEY && auth.includes(SUPABASE_KEY)) ||
    (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN));
  if (!ok) return j({ success: false, error: "unauthorized" }, 401);

  let body: { player_ids?: number[]; season?: number; limit?: number } = {};
  try { body = await req.json(); } catch { body = {}; }
  const season = body.season ?? 2026;

  // Build pitcher list
  let pids: number[] = [];
  if (body.player_ids && Array.isArray(body.player_ids)) {
    pids = body.player_ids;
  } else {
    // Pull distinct pitcher_id from June resolved pitcher_k picks
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/pick_history?` +
      `select=player_id&sport=eq.mlb&mlb_market_type=eq.pitcher_k&is_synthetic=eq.false` +
      `&hit=not.is.null&player_id=not.is.null` +
      `&and=(game_date.gte.${season}-04-01,game_date.lt.${season}-12-31)&limit=5000`,
      { headers: sH() },
    );
    if (!r.ok) return j({ success: false, error: "failed to pull pitcher list" }, 500);
    const rows = await r.json() as Array<{ player_id: number }>;
    const set = new Set<number>();
    for (const x of rows) if (x.player_id) set.add(x.player_id);
    pids = Array.from(set);
  }
  if (body.limit && body.limit > 0) pids = pids.slice(0, body.limit);

  const counts = { total: pids.length, ok: 0, miss: 0, err: 0 };
  const toUpsert: Array<Record<string, unknown>> = [];

  for (const pid of pids) {
    try {
      const s = await fetchSeasonStats(pid, season);
      if (!s) { counts.miss++; continue; }
      toUpsert.push({
        player_id: pid, season,
        full_name: s.full_name, throws: s.throws,
        games_played: s.games_played, innings_pitched: s.innings_pitched,
        strike_outs: s.strike_outs, batters_faced: s.batters_faced,
        k_per_nine: s.k_per_nine, era: s.era,
        pitches_per_start: s.pitches_per_start, base_on_balls: s.base_on_balls,
      });
      counts.ok++;
    } catch {
      counts.err++;
    }
  }

  // Bulk upsert
  if (toUpsert.length > 0) {
    const upsertUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_pitcher_season_stats?on_conflict=player_id,season`;
    for (let i = 0; i < toUpsert.length; i += 100) {
      const chunk = toUpsert.slice(i, i + 100);
      await fetch(upsertUrl, {
        method: "POST",
        headers: { ...sH(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(chunk),
      });
    }
  }

  return j({ success: true, counts, upserted: toUpsert.length });
});
