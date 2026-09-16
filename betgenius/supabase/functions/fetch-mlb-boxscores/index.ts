// D-335 SHIP 3 — fetch boxscore per-(player, gamePk) stats from MLB Stats API.
//
// Source: /api/v1/game/{gamePk}/boxscore — free, no API key.
// Target: cache_mlb_boxscore_player_stats (D-335 SHIP 1 schema).
//
// Default mode: fetch all completed games from the last `days_back` UTC days
// from cache_mlb_historical_outcomes, then enrich each via boxscore.
//
// Manual mode: pass {"game_pks": [123, 456]} to fetch specific games.
//
// Idempotent on (player_id, game_pk) PK with merge-duplicates. Doubleheader
// gamePks are unique so no intra-batch dedup needed (D-334 lesson didn't
// apply here — that was about event_id PK on outcomes).
//
// Schedule: pg_cron daily 04:30 UTC (30 min after refresh-historical-outcomes-mlb
// completes — that fills the source set this function reads).

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
  Prefer: "resolution=merge-duplicates,return=minimal",
});

const MLB = "https://statsapi.mlb.com/api/v1";

interface BoxscorePlayerRow {
  player_id: number;
  game_pk: number;
  game_date: string;
  team_id: number | null;
  player_name: string | null;
  position_type: string | null;
  is_starter: boolean;
  batting_order_slot: number | null;
  at_bats: number | null;
  hits: number | null;
  home_runs: number | null;
  total_bases: number | null;
  rbi: number | null;
  plate_appearances: number | null;
  innings_pitched: number | null;
  pitches_thrown: number | null;
  strikeouts: number | null;
  walks: number | null;
  batters_faced: number | null;
  pitcher_runs: number | null;
  pitcher_earned_runs: number | null;
  // D-729: closes the schema gaps D-718 SHIP 3 identified.
  runs_scored: number | null;       // bat.runs — batter runs scored
  outs: number | null;              // pit.outs — DIRECT integer; not derived from decimal-thirds innings_pitched (D-716c)
  batter_strikeouts: number | null; // bat.strikeOuts — distinct from `strikeouts` (which is pit.strikeOuts)
  // D-774 — unlocks opp_walk_rate + opp_obp_patience reconstruction.
  batter_walks: number | null;      // bat.baseOnBalls — distinct from `walks` (pit.baseOnBalls)
  batter_hbp: number | null;        // bat.hitByPitch
  batter_sac_flies: number | null;  // bat.sacFlies
}

function parseBattingOrder(s: unknown): { slot: number | null; isStarter: boolean } {
  if (typeof s !== "string" || s.length !== 3 || !/^\d{3}$/.test(s)) return { slot: null, isStarter: false };
  const slot = parseInt(s[0]!, 10);
  if (slot < 1 || slot > 9) return { slot: null, isStarter: false };
  const isStarter = s.endsWith("00");
  return { slot, isStarter };
}

function parseIp(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!s) return null;
  const dot = s.indexOf(".");
  if (dot < 0) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const whole = Number(s.slice(0, dot));
  const frac = Number(s.slice(dot + 1));
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) return null;
  return whole + frac / 3;
}

function safeInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

interface BoxscorePlayer {
  person?: { id?: number; fullName?: string };
  battingOrder?: string;
  position?: { type?: string };
  stats?: {
    batting?: Record<string, unknown>;
    pitching?: Record<string, unknown>;
  };
}

async function fetchBoxscore(gamePk: number, gameDate: string): Promise<BoxscorePlayerRow[]> {
  const url = `${MLB}/game/${gamePk}/boxscore`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json() as {
    teams?: {
      home?: { team?: { id?: number }; players?: Record<string, BoxscorePlayer>; pitchers?: number[] };
      away?: { team?: { id?: number }; players?: Record<string, BoxscorePlayer>; pitchers?: number[] };
    };
  };
  const rows: BoxscorePlayerRow[] = [];
  for (const side of ["home", "away"] as const) {
    const team = d.teams?.[side] ?? {};
    const teamId = team.team?.id ?? null;
    const starterPitcherId = (team.pitchers ?? [])[0] ?? null;
    const players = team.players ?? {};
    for (const p of Object.values(players)) {
      const playerId = p.person?.id;
      if (!playerId) continue;
      const bat = p.stats?.batting ?? {};
      const pit = p.stats?.pitching ?? {};
      const { slot, isStarter: batStart } = parseBattingOrder(p.battingOrder);
      const isPitcherStart = playerId === starterPitcherId;
      const isStarter = batStart || isPitcherStart;
      rows.push({
        player_id: playerId,
        game_pk: gamePk,
        game_date: gameDate,
        team_id: teamId,
        player_name: p.person?.fullName ?? null,
        position_type: p.position?.type ?? null,
        is_starter: isStarter,
        batting_order_slot: batStart ? slot : null,
        at_bats: safeInt(bat.atBats),
        hits: safeInt(bat.hits),
        home_runs: safeInt(bat.homeRuns),
        total_bases: safeInt(bat.totalBases),
        rbi: safeInt(bat.rbi),
        plate_appearances: safeInt(bat.plateAppearances),
        innings_pitched: parseIp(pit.inningsPitched),
        pitches_thrown: safeInt(pit.pitchesThrown ?? pit.numberOfPitches),
        strikeouts: safeInt(pit.strikeOuts),
        walks: safeInt(pit.baseOnBalls),
        batters_faced: safeInt(pit.battersFaced),
        pitcher_runs: safeInt(pit.runs),
        pitcher_earned_runs: safeInt(pit.earnedRuns),
        // D-729 — fill the three D-718-flagged schema gaps.
        runs_scored:       safeInt(bat.runs),
        outs:              safeInt(pit.outs),
        batter_strikeouts: safeInt(bat.strikeOuts),
        // D-774 — unlocks opp_walk_rate + opp_obp_patience reconstruction.
        // D-773 found these factors stayed DARK because batter walks were
        // not captured. Picked up by historical-context router via
        // SUM(batter_walks) / SUM(plate_appearances) on opp team rows.
        batter_walks:       safeInt(bat.baseOnBalls),
        batter_hbp:         safeInt(bat.hitByPitch),
        batter_sac_flies:   safeInt(bat.sacFlies),
      });
    }
  }
  return rows;
}

async function upsertRows(rows: BoxscorePlayerRow[]): Promise<{ ok: boolean; status: number; body: string }> {
  if (rows.length === 0) return { ok: true, status: 200, body: "empty" };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?on_conflict=player_id,game_pk`, {
    method: "POST",
    headers: supaHeadersRW(),
    body: JSON.stringify(rows),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? "" : (await r.text()).slice(0, 200) };
}

async function fetchPendingGames(daysBack: number): Promise<Array<{ game_pk: number; game_date: string }>> {
  const since = new Date(Date.now() - daysBack * 86400_000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?game_completed=eq.true&commence_time=gte.${encodeURIComponent(since)}&select=game_pk,commence_time&order=commence_time.desc&limit=200`;
  const r = await fetch(url, { headers: supaHeadersRO() });
  if (!r.ok) return [];
  const rows = await r.json() as Array<{ game_pk: number | null; commence_time: string }>;
  return rows.filter(r => r.game_pk).map(r => ({
    game_pk: r.game_pk as number,
    game_date: r.commence_time.slice(0, 10),
  }));
}

// D-730b — per-day schedule fetch → game_outcomes rows. Closes the D-730 self-
// maintain gap: every fetch-mlb-boxscores tick now also keeps game_outcomes fresh,
// so the table doesn't go stale 21 days after the D-730 manual backfill.
//
// One MLB schedule call returns ~15 games for the day with home/away scores,
// status, team names — exactly the game_outcomes shape. We dedup by game_pk
// (postponed games can share gamePk across schedule views), then upsert.
interface GameOutcomeRow {
  game_pk: number;
  game_date: string;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  total_runs: number | null;
  winner: "home" | "away" | "tie" | null;
  status: string;
  commence_time: string | null;
}

function mapGameOutcomeStatus(detailedState: string | undefined | null): string {
  const s = (detailedState || "").toLowerCase();
  if (s === "final" || s === "game over" || s === "completed early") return "final";
  if (s.includes("progress")) return "in_progress";
  return s || "scheduled";
}

function computeWinner(home: number | null, away: number | null): "home" | "away" | "tie" | null {
  if (home == null || away == null) return null;
  if (home > away) return "home";
  if (away > home) return "away";
  return "tie";
}

async function fetchGameOutcomesForDate(dateISO: string): Promise<GameOutcomeRow[]> {
  const url = `${MLB}/schedule?sportId=1&date=${dateISO}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json() as {
    dates?: Array<{ games?: Array<{
      gamePk?: number;
      gameDate?: string;
      status?: { detailedState?: string };
      teams?: {
        home?: { team?: { name?: string }; score?: number };
        away?: { team?: { name?: string }; score?: number };
      };
    }> }>;
  };
  const out = new Map<number, GameOutcomeRow>(); // dedup by game_pk
  for (const g of d.dates?.[0]?.games ?? []) {
    if (!g.gamePk || !g.teams?.home?.team?.name || !g.teams?.away?.team?.name) continue;
    const hs = g.teams.home.score ?? null;
    const as_ = g.teams.away.score ?? null;
    out.set(g.gamePk, {
      game_pk: g.gamePk,
      game_date: dateISO,
      home_team: g.teams.home.team.name,
      away_team: g.teams.away.team.name,
      home_score: hs,
      away_score: as_,
      total_runs: (hs != null && as_ != null) ? hs + as_ : null,
      winner: computeWinner(hs, as_),
      status: mapGameOutcomeStatus(g.status?.detailedState),
      commence_time: g.gameDate ?? null,
    });
  }
  return Array.from(out.values());
}

async function upsertGameOutcomes(rows: GameOutcomeRow[]): Promise<{ ok: boolean; status: number; body: string; count: number }> {
  if (rows.length === 0) return { ok: true, status: 200, body: "empty", count: 0 };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/game_outcomes?on_conflict=game_pk`, {
    method: "POST",
    headers: { ...supaHeadersRW(), "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? "" : (await r.text()).slice(0, 200), count: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return j({ error: "missing env" }, 500);
  const auth = req.headers.get("authorization") || "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) {
    return j({ error: "unauthorized" }, 401);
  }

  let body: { days_back?: number; game_pks?: Array<{ game_pk: number; game_date: string }> } = {};
  try { body = await req.json(); } catch { /* defaults */ }

  const t0 = Date.now();
  let pending: Array<{ game_pk: number; game_date: string }>;
  if (Array.isArray(body.game_pks) && body.game_pks.length > 0) {
    pending = body.game_pks;
  } else {
    const daysBack = Math.max(1, Math.min(body.days_back ?? 2, 7));
    pending = await fetchPendingGames(daysBack);
  }

  let totalRows = 0;
  let fetchFails = 0;
  let upsertFails = 0;
  const errors: string[] = [];

  // D-730b — per-tick game_outcomes refresh. One MLB /schedule call per unique
  // date covers ~15 games at once; cheap and idempotent. Runs BEFORE the per-game
  // boxscore loop so any consumer that reads game_outcomes mid-cron sees fresh data.
  // Fail-soft: errors are recorded but don't block the boxscore work.
  const uniqDates = Array.from(new Set(pending.map((g) => g.game_date)));
  let gameOutcomesUpserted = 0;
  let gameOutcomesFetchFails = 0;
  let gameOutcomesUpsertFails = 0;
  for (const dateISO of uniqDates) {
    if (Date.now() - t0 > 20_000) break; // small wall-clock cap so we don't starve the boxscore loop
    try {
      const rows = await fetchGameOutcomesForDate(dateISO);
      if (rows.length === 0) { gameOutcomesFetchFails++; continue; }
      const up = await upsertGameOutcomes(rows);
      if (!up.ok) {
        gameOutcomesUpsertFails++;
        if (errors.length < 5) errors.push(`game_outcomes ${dateISO}: HTTP ${up.status} ${up.body}`);
      } else {
        gameOutcomesUpserted += up.count;
      }
    } catch (e) {
      gameOutcomesFetchFails++;
      if (errors.length < 5) errors.push(`game_outcomes ${dateISO}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Process games sequentially with mild throttle (~50 boxscores/sec is fine for MLB API).
  // Wall-clock budget 130s.
  for (const g of pending) {
    if (Date.now() - t0 > 130_000) break;
    try {
      const rows = await fetchBoxscore(g.game_pk, g.game_date);
      if (rows.length === 0) {
        fetchFails++;
        continue;
      }
      const up = await upsertRows(rows);
      if (!up.ok) {
        upsertFails++;
        if (errors.length < 5) errors.push(`game ${g.game_pk}: HTTP ${up.status} ${up.body}`);
      } else {
        totalRows += rows.length;
      }
    } catch (e) {
      fetchFails++;
      if (errors.length < 5) errors.push(`game ${g.game_pk}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return j({
    success: upsertFails === 0 && fetchFails < pending.length,
    games_requested: pending.length,
    rows_upserted: totalRows,
    fetch_failures: fetchFails,
    upsert_failures: upsertFails,
    // D-730b — game_outcomes self-maintain telemetry
    game_outcomes_upserted: gameOutcomesUpserted,
    game_outcomes_fetch_failures: gameOutcomesFetchFails,
    game_outcomes_upsert_failures: gameOutcomesUpsertFails,
    game_outcomes_dates: uniqDates.length,
    errors_sample: errors,
    duration_ms: Date.now() - t0,
  });
});
