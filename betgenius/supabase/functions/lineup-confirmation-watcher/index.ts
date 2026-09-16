// D-637 — Lineup-confirmation watcher (D-620b SHIP 1; D-632 free-path).
// ─────────────────────────────────────────────────────────────────────
// Cron-driven. Every tick:
//   1. List today's MLB games via /schedule + first_pitch.
//   2. For each game in PRE-GAME WINDOW (T-4h → first_pitch), pull the
//      confirmed lineup via the source-abstracted LineupSourceAdapter.
//   3. Hash the lineup. Compare against lineup_confirmation_log:
//        - If hash already logged → skip (idempotent; covers re-pulls
//          AND late-scratch updates).
//        - Otherwise: process the new confirmation.
//   4. Processing one new confirmation:
//      a) SCRATCH AUTO-VOID — find batter picks for players NOT in the
//         confirmed lineup; UPDATE pick_history SET voided=true and
//         DELETE the rows from recommendations_cache so the dashboard
//         stops showing them.
//      b) RE-SCORE — invoke process-single-game-mlb to re-score the
//         game's picks. lineup_spot + handedness_matchup now populate
//         for picks on confirmed starters (was 17.5% null per D-629).
//      c) LOG — INSERT into lineup_confirmation_log so the next tick
//         short-circuits.
//
// SOURCE-AGNOSTIC: reads via LineupSourceAdapter. A future OddsJam swap
// implements the same interface; this watcher code stays unchanged.

import {
  getLineupSourceAdapter, hashConfirmedLineup, normalizeName,
  type ConfirmedLineup,
} from "../_shared/lineup_source.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";

const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

// Pre-game window: poll only between T-4h and first_pitch. Matches
// D-620's pregame window so the watcher and the scorer treat the same
// timeframe as "active." Outside the window: no polls (cost discipline
// per spec ESCALATION #3).
const PREGAME_WINDOW_MS = 4 * 60 * 60 * 1000;

interface ScheduledGame {
  game_pk: number;
  game_time_iso: string;
  home_team: string;
  away_team: string;
}

function todayIsoDateEt(): string {
  return new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function listTodaysGames(isoDate: string): Promise<ScheduledGame[]> {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&date=${isoDate}&hydrate=probablePitcher`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const out: ScheduledGame[] = [];
  try {
    const d = await r.json() as { dates?: Array<{ games?: Array<{
      gamePk?: number;
      gameDate?: string;
      teams?: { home?: { team?: { name?: string } }; away?: { team?: { name?: string } } };
      status?: { abstractGameState?: string };
    }> }> };
    for (const dt of d?.dates ?? []) {
      for (const g of dt?.games ?? []) {
        // Skip live/final — they don't need a lineup confirmation
        // (lineup is fixed once the game starts; voids handled by
        // resolve-picks post-game).
        const state = g?.status?.abstractGameState || "";
        if (state && state !== "Preview") continue;
        if (!g?.gamePk || !g?.gameDate) continue;
        out.push({
          game_pk: g.gamePk,
          game_time_iso: g.gameDate,
          home_team: g.teams?.home?.team?.name || "",
          away_team: g.teams?.away?.team?.name || "",
        });
      }
    }
  } catch { /* swallow; empty array */ }
  return out;
}

// Already-processed lineup hashes for this game (idempotency).
async function fetchProcessedHashes(game_pk: number, game_date: string): Promise<Set<string>> {
  const url = `${SUPA_URL}/rest/v1/lineup_confirmation_log?game_pk=eq.${game_pk}&game_date=eq.${game_date}&select=lineup_hash`;
  const r = await fetch(url, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!r.ok) return new Set();
  try {
    const rows = await r.json() as Array<{ lineup_hash: string }>;
    return new Set(rows.map((r) => r.lineup_hash));
  } catch { return new Set(); }
}

// Find batter picks in recommendations_cache for this game whose
// normalized player name is NOT in the confirmed lineup. Pitcher
// markets are NOT auto-voided here — pitcher scratches surface via
// MLB Stats probablePitcher → starter swap, not via batting order.
// (Scoped: see d637 doc.)
interface ScratchablePick {
  rec_id: number;
  pick_id: string | null;
  player_name: string;
  prop_type: string;
  pick_side: string;
  line: number | null;
  // For audit: which side the pick was on
  team: string | null;
}

async function findScratchedPicks(
  game_id: string | number,
  confirmedNorm: Set<string>,
): Promise<ScratchablePick[]> {
  // Pull all batter prop rows for this game. Pitcher prop_types
  // (pitcher_k, pitcher_outs) are excluded because pitchers don't have
  // a battingOrder. h2h/spread/game_total are also excluded — these
  // aren't player-keyed.
  const select = "id,player_name,team,prop_type,pick_side,line";
  const url = `${SUPA_URL}/rest/v1/recommendations_cache` +
    `?sport=eq.mlb&game_id=eq.${encodeURIComponent(String(game_id))}` +
    `&prop_type=not.in.(pitcher_k,pitcher_outs,h2h,spread,game_total,spreads,totals)` +
    `&select=${select}`;
  const r = await fetch(url, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!r.ok) return [];
  let rows: Array<{ id: number; player_name: string; team: string | null; prop_type: string; pick_side: string; line: number | null }> = [];
  try { rows = await r.json(); } catch { return []; }
  const out: ScratchablePick[] = [];
  for (const row of rows) {
    if (!row.player_name) continue;
    const norm = normalizeName(row.player_name);
    if (confirmedNorm.has(norm)) continue;  // starter — keep
    out.push({
      rec_id: row.id,
      pick_id: null,        // resolved later via pick_history join
      player_name: row.player_name,
      prop_type: row.prop_type,
      pick_side: row.pick_side,
      line: row.line,
      team: row.team,
    });
  }
  return out;
}

// Void the matching pick_history rows for a (player, prop_type, line,
// pick_side, game_date). Uses the existing voided=true + resolved_at
// pattern identical to resolve-picks:voidPick. Returns the count voided.
async function voidPickHistoryRows(
  game_date: string,
  scratched: ScratchablePick[],
): Promise<number> {
  if (scratched.length === 0) return 0;
  let n = 0;
  for (const s of scratched) {
    // PATCH by composite key. pick_history schema allows multi-book
    // duplicates of the same logical pick, so we void all matches.
    const qs = new URLSearchParams({
      player_name: `eq.${s.player_name}`,
      prop_type: `eq.${s.prop_type}`,
      pick_side: `eq.${s.pick_side}`,
      game_date: `eq.${game_date}`,
      voided: "is.null,not.eq.true",
    });
    if (s.line !== null && s.line !== undefined) qs.set("line", `eq.${s.line}`);
    const url = `${SUPA_URL}/rest/v1/pick_history?${qs.toString()}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        voided: true,
        resolved_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) continue;
    try {
      const updated = await r.json() as unknown[];
      n += updated.length;
    } catch { /* swallow */ }
  }
  return n;
}

// Drop scratched picks from recommendations_cache so the dashboard
// stops showing them. Same pattern as the existing display rules:
// recommendations_cache is the source-of-truth for "today's picks";
// pick_history is the long-term audit log.
async function deleteRecCacheRows(recIds: number[]): Promise<number> {
  if (recIds.length === 0) return 0;
  // DELETE in chunks of 100 to keep URL length bounded.
  let n = 0;
  for (let i = 0; i < recIds.length; i += 100) {
    const chunk = recIds.slice(i, i + 100);
    const inList = chunk.join(",");
    const url = `${SUPA_URL}/rest/v1/recommendations_cache?id=in.(${inList})`;
    const r = await fetch(url, {
      method: "DELETE",
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        Prefer: "return=minimal",
      },
    });
    if (r.ok) n += chunk.length;
  }
  return n;
}

// Invoke process-single-game-mlb. Returns short summary.
async function invokeRescore(game_pk: number): Promise<string> {
  const url = `${SUPA_URL}/functions/v1/process-single-game-mlb`;
  // The function accepts service-role OR BACKFILL_AUTH_TOKEN. We have
  // both; service-role is the safer default (no token-stuffing path).
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      game_id: game_pk,
      touch_label: "d637_lineup_confirm",
    }),
  });
  const status = r.status;
  let text = "";
  try { text = (await r.text()).slice(0, 300); } catch { /* swallow */ }
  return `${status}|${text}`;
}

async function logConfirmation(args: {
  game_pk: number;
  game_date: string;
  source_name: string;
  lineup_hash: string;
  n_starters: number;
  n_scratched_picks: number;
  n_voided_history: number;
  rescore_invoked: boolean;
  rescore_response: string;
}): Promise<void> {
  const url = `${SUPA_URL}/rest/v1/lineup_confirmation_log`;
  await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(args),
  });
}

interface PerGameResult {
  game_pk: number;
  in_window: boolean;
  fetched: boolean;
  confirmed: boolean;
  already_logged: boolean;
  lineup_hash: string;
  n_starters: number;
  n_scratched_picks: number;
  n_voided_history: number;
  rescore_invoked: boolean;
  rescore_response: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth: service role or backfill token. Same pattern as the
  // sibling D-329 / D-634 functions.
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== SUPA_KEY && bearer !== BACKFILL)) {
    return j({ ok: false, error: "unauthorized" }, 401);
  }

  const isoDate = todayIsoDateEt();
  const adapter = getLineupSourceAdapter();
  const games = await listTodaysGames(isoDate);
  const nowMs = Date.now();

  const results: PerGameResult[] = [];
  let n_processed = 0;
  let n_total_scratched = 0;
  let n_total_voided = 0;
  let n_rescore_invoked = 0;

  for (const g of games) {
    const first_pitch_ms = Date.parse(g.game_time_iso);
    const inWindow = Number.isFinite(first_pitch_ms)
      && (first_pitch_ms - nowMs) > 0
      && (first_pitch_ms - nowMs) <= PREGAME_WINDOW_MS;

    if (!inWindow) {
      results.push({
        game_pk: g.game_pk, in_window: false, fetched: false,
        confirmed: false, already_logged: false, lineup_hash: "",
        n_starters: 0, n_scratched_picks: 0, n_voided_history: 0,
        rescore_invoked: false, rescore_response: "",
      });
      continue;
    }

    let lineup: ConfirmedLineup;
    try {
      lineup = await adapter.fetchConfirmedLineup(g.game_pk);
    } catch (_e) {
      results.push({
        game_pk: g.game_pk, in_window: true, fetched: false,
        confirmed: false, already_logged: false, lineup_hash: "",
        n_starters: 0, n_scratched_picks: 0, n_voided_history: 0,
        rescore_invoked: false, rescore_response: "adapter_threw",
      });
      continue;
    }

    if (!lineup.players || lineup.players.length === 0) {
      results.push({
        game_pk: g.game_pk, in_window: true, fetched: true,
        confirmed: false, already_logged: false, lineup_hash: "",
        n_starters: 0, n_scratched_picks: 0, n_voided_history: 0,
        rescore_invoked: false, rescore_response: "lineup_not_posted",
      });
      continue;
    }

    const lineup_hash = await hashConfirmedLineup(lineup);
    const processedHashes = await fetchProcessedHashes(g.game_pk, isoDate);
    if (processedHashes.has(lineup_hash)) {
      results.push({
        game_pk: g.game_pk, in_window: true, fetched: true,
        confirmed: true, already_logged: true, lineup_hash,
        n_starters: lineup.players.length, n_scratched_picks: 0,
        n_voided_history: 0, rescore_invoked: false,
        rescore_response: "already_logged",
      });
      continue;
    }

    // New confirmation. Run scratch-void + re-score.
    const confirmedNorm = new Set(lineup.players.map((p) => p.name_normalized));
    const scratched = await findScratchedPicks(g.game_pk, confirmedNorm);
    const n_voided = await voidPickHistoryRows(isoDate, scratched);
    await deleteRecCacheRows(scratched.map((s) => s.rec_id));
    const rescore = await invokeRescore(g.game_pk);

    await logConfirmation({
      game_pk: g.game_pk,
      game_date: isoDate,
      source_name: lineup.source_name,
      lineup_hash,
      n_starters: lineup.players.length,
      n_scratched_picks: scratched.length,
      n_voided_history: n_voided,
      rescore_invoked: true,
      rescore_response: rescore,
    });

    results.push({
      game_pk: g.game_pk, in_window: true, fetched: true,
      confirmed: true, already_logged: false, lineup_hash,
      n_starters: lineup.players.length,
      n_scratched_picks: scratched.length,
      n_voided_history: n_voided,
      rescore_invoked: true, rescore_response: rescore,
    });
    n_processed++;
    n_total_scratched += scratched.length;
    n_total_voided += n_voided;
    n_rescore_invoked++;
  }

  return j({
    ok: true,
    iso_date: isoDate,
    source: adapter.name,
    n_games: games.length,
    n_processed,
    n_total_scratched,
    n_total_voided,
    n_rescore_invoked,
    pregame_window_hours: PREGAME_WINDOW_MS / 3_600_000,
    results,
  });
});
