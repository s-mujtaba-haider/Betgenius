// backfill-bdl-historical — D-180 Phase 1 + D-181 Phase 2 (May 15-16, 2026).
//
// Goal: generate synthetic resolved picks for 2024-25 NBA regular season
// to unblock C8 auto-optimize re-enable (needs ~3000 post-megadeploy
// resolved picks). At current organic rate (50-100/day), reaching that
// threshold via live cron takes until mid-June. Backfilling via BDL
// historical box scores produces 3000-10000 synthetic picks immediately.
//
// Phase 1 (commit 7d5399d):
//   Scaffolded BDL fetch + day-level summary. Verified BDL endpoint
//   works (68 player rows for 2024-10-22 opening night).
//
// Phase 2 (THIS SHIP — D-181):
//   End-to-end pick generation for the requested date range:
//   1. Fetch BDL stats for each target date (player rows + actual stats).
//   2. For each player who played:
//      a. Fetch the player's prior BDL games (up to 30) as the
//         "as-of historical date" rolling baseline.
//      b. Compute L10 average per supported prop type. Generate synthetic
//         lines (round to nearest 0.5).
//      c. Build CachedPlayerData + ExtractedProp + edgeData for
//         scoreOneSide. Helpers return null/false/empty for historical
//         mode (no injuries cache, no game-line cache).
//      d. Call scoreOneSide("over", weights, helpers) per prop type.
//      e. Resolve immediately: actual stat from target_date row vs
//         synthetic line → hit = (actual > line).
//      f. Persist via upsert_pick_history RPC. is_synthetic=TRUE,
//         source='backfill-historical', algorithm_version pinned.
//   3. Cap players per request (max_players, default 15) to stay under
//      the ~150s edge function timeout. Phase 3 will chunk by date for
//      full-season run.
//
// Out of scope (Phase 3+):
//   - Under-side picks (Phase 2 ships OVER only per directive).
//   - Multi-day batch jobs (current cap = max_players within a single date).
//   - cache_opponent_defensive_stats backfill (helpers return null; opp
//     stats factors return 0 in historical mode — graceful degradation).
//
// Spec: /tmp/d180_nba_historical_backfill_spec.md
//
// Auth: deferred to Phase 3 (matches Phase 1 decision). Function is
// write-bearing now via RPC, but RPC itself enforces service-role
// via SECURITY DEFINER. CEO can add an HTTP-level guard in a follow-up.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  loadWeightsFromDB,
  scoreOneSide,
  calculateMinutesTrend,
  type ScoringWeights,
  type ScoreOneSideHelpers,
  type CachedPlayerData,
  type ExtractedProp,
  type GameLogEntry,
  type PropAnalysisResult,
} from "../_shared/scoring.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BDL_API_KEY = Deno.env.get("BALLDONTLIE_API_KEY") ?? "";
const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALGORITHM_VERSION = "2026-05-15-d172a-d177a-d181";

interface BackfillRequest {
  start_date: string;
  end_date: string;
  dry_run?: boolean;
  max_players?: number;
}

interface BdlStatRow {
  id: number;
  player: { id: number; first_name: string; last_name: string; position?: string };
  team: { id: number; full_name: string; abbreviation: string };
  game: {
    id: number; date: string; home_team_id: number; visitor_team_id: number;
    home_team_score: number; visitor_team_score: number; status: string;
  };
  min: string | null;
  pts: number; reb: number; ast: number; stl: number; blk: number;
  turnover: number; fg3m: number;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function eachDate(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const stop = new Date(end + "T00:00:00Z");
  while (cur.getTime() <= stop.getTime()) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// Parse BDL `min` field. Format is "MM" or "MM:SS" or "" or null. Returns 0
// on parse failure / empty (player did not appear).
function parseMin(min: string | null): number {
  if (!min) return 0;
  const colonIdx = min.indexOf(":");
  if (colonIdx < 0) return parseInt(min, 10) || 0;
  return parseInt(min.slice(0, colonIdx), 10) || 0;
}

// D-191 (May 16, 2026): map YYYY-MM-DD → NBA season year for BDL queries.
// BDL uses the year the season STARTED (2024-25 season → season=2024).
// Boundary: NBA seasons start mid-Oct; July 1 is a safe cutover anchor.
function dateToSeason(date: string): number {
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(5, 7), 10);
  // Jan-Jun: still in the prior-year-started season (e.g., 2025-03-15 → 2024-25 → 2024)
  // Jul-Dec: in the year-started season (e.g., 2024-11-15 → 2024-25 → 2024)
  return m <= 6 ? y - 1 : y;
}

// D-191b (May 16, 2026): per-fetch BDL timeout helper. Pre-D-191b every
// `fetch(BDL)` was naked-awaited — a single slow BDL response would hang
// the function until Supabase's 150s isolate ceiling killed it, producing
// the empty FAIL bodies observed in Phase 2 after 15:30 UTC (one 670s
// wall-clock outlier). 30s per-fetch cap means worst-case per-date budget
// is bounded: even with 4-5 slow fetches per date, the date completes or
// fails with logged reasons within the function's 150s ceiling.
//
// Also: AbortController-based timeout is the recommended Deno pattern;
// connecting Connection:close header (D-184) + timeout closes most known
// BDL flake modes (stale-pool empty-200 + silent-slow-response).
async function bdlFetch(url: string, timeoutMs = 30000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: BDL_API_KEY,
        Connection: "close",
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    return res;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      console.log(`[d191b] BDL fetch timeout (${timeoutMs}ms): ${url.slice(0, 120)}`);
    } else {
      console.log(`[d191b] BDL fetch threw: ${e instanceof Error ? e.message : String(e)} url=${url.slice(0, 120)}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBdlStatsForDate(date: string): Promise<BdlStatRow[]> {
  const season = dateToSeason(date);
  const rows: BdlStatRow[] = [];
  let cursor: number | null = null;
  for (let page = 0; page < 5; page++) {
    const url = cursor === null
      ? `https://api.balldontlie.io/v1/stats?dates[]=${date}&seasons[]=${season}&per_page=100`
      : `https://api.balldontlie.io/v1/stats?dates[]=${date}&seasons[]=${season}&per_page=100&cursor=${cursor}`;
    // D-184: Connection:close defeats Deno's outbound pool (stale-conn empty-200 mitigation).
    // D-191b: bdlFetch wraps with 30s AbortController; null return = timed out or threw.
    const res = await bdlFetch(url);
    if (!res) {
      console.log(`[d191b] fetchBdlStatsForDate aborting page loop for ${date} after timeout/error`);
      break;
    }
    if (!res.ok) {
      console.log(`[d184] BDL stats fetch failed for ${date}: HTTP ${res.status}`);
      break;
    }
    const bodyText = await res.text();
    const body = JSON.parse(bodyText) as { data: BdlStatRow[]; meta?: { next_cursor: number | null } };
    if (Array.isArray(body.data)) rows.push(...body.data);
    const next = body.meta?.next_cursor ?? null;
    // D-184 diag: log every fetch so we can correlate empty-200 cases with
    // upstream behavior in the Supabase function-logs panel.
    if (page === 0) {
      console.log(`[d184-diag] ${date} page=0 rows_in_body=${body.data?.length ?? 0} body_size=${bodyText.length} has_next=${next !== null}`);
    }
    if (!next) break;
    cursor = next;
  }
  return rows;
}

// D-181: fetch player's BDL stat rows BEFORE target_date (the "as-of"
// rolling baseline). Limit to ~30 most-recent games.
async function fetchBdlPriorGamesForPlayer(
  playerId: number, beforeDate: string,
): Promise<BdlStatRow[]> {
  // D-183 (May 15-16, 2026): query BOTH the target_date's season AND the
  // prior season so early-season target_dates (when players have <5 games
  // in the current season) still get a 10-game baseline using prior-season
  // carry-over. D-191 (May 16, 2026): season parameter now derived from
  // beforeDate, not hardcoded — supports 2023-24 backfill cohort.
  const currentSeason = dateToSeason(beforeDate);
  const priorSeason = currentSeason - 1;
  const url =
    `https://api.balldontlie.io/v1/stats?player_ids[]=${playerId}` +
    `&seasons[]=${currentSeason}&seasons[]=${priorSeason}&end_date=${beforeDate}&per_page=30`;
  // D-184: Connection:close + D-191b: bdlFetch 30s timeout (see fetchBdlStatsForDate).
  const res = await bdlFetch(url);
  if (!res) {
    console.log(`[d191b] prior-games fetch timeout/error for player ${playerId} at ${beforeDate}`);
    return [];
  }
  if (!res.ok) {
    console.log(`[d181] prior-games fetch failed for player ${playerId}: HTTP ${res.status}`);
    return [];
  }
  const body = await res.json() as { data: BdlStatRow[] };
  const rows = body.data ?? [];
  // Sort by game date descending (most recent first — matches scoring.ts expectation).
  rows.sort((a, b) => (b.game?.date ?? "").localeCompare(a.game?.date ?? ""));
  // Filter to strictly BEFORE target date (BDL end_date is inclusive in some
  // versions; defensive trim).
  return rows.filter((r) => (r.game?.date ?? "") < beforeDate);
}

// D-188 (May 15, 2026): persist BDL prior-games rows to cache_player_game_logs
// so D-186 Phase 4 rescore can rebuild gameLog without re-fetching BDL.
// Idempotent UPSERT by (player_id, game_date, sport). Source marker 'bdl-backfill'.
// Called once per (player, target_date) immediately after fetchBdlPriorGamesForPlayer.
async function persistGameLogsToCache(
  playerId: number, playerName: string,
  rows: BdlStatRow[],
): Promise<{ written: number; error: string | null }> {
  if (!SUPA_URL || !SUPA_KEY || rows.length === 0) return { written: 0, error: null };
  const cacheRows = rows.map((r) => {
    const isHome = r.game?.home_team_id === r.team?.id;
    return {
      player_id: String(playerId),
      player_name: playerName,
      game_date: r.game?.date ?? null,
      opponent: "", // BDL stats endpoint doesn't carry opponent team name; cache_player_game_logs.opponent is nullable
      is_home: isHome,
      minutes: parseMin(r.min),
      points: r.pts ?? 0,
      rebounds: r.reb ?? 0,
      assists: r.ast ?? 0,
      threes: r.fg3m ?? 0,
      steals: r.stl ?? 0,
      blocks: r.blk ?? 0,
      turnovers: r.turnover ?? 0,
      source: "bdl-backfill",
      sport: "nba",
    };
  }).filter((r) => r.game_date); // drop rows missing game_date — would violate PK
  if (cacheRows.length === 0) return { written: 0, error: null };
  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/cache_player_game_logs?on_conflict=player_id,game_date,sport`,
      {
        method: "POST",
        headers: {
          apikey: SUPA_KEY,
          Authorization: `Bearer ${SUPA_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(cacheRows),
      },
    );
    if (!res.ok) {
      const txt = await res.text();
      return { written: 0, error: `${res.status} ${txt.slice(0, 200)}` };
    }
    return { written: cacheRows.length, error: null };
  } catch (e) {
    return { written: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// Transform BDL row → GameLogEntry shape (matches what scoring.ts expects).
// scoring.ts stats keys: MIN, PTS, REB, AST, "3PM", STL, BLK, TO.
function bdlRowToGameLogEntry(row: BdlStatRow, playerTeamId: number): GameLogEntry {
  const isHome = row.game?.home_team_id === row.team?.id;
  const oppTeamName = isHome ? "" : ""; // BDL doesn't include opponent name on this endpoint
  void playerTeamId; // suppress unused
  return {
    date: row.game?.date ?? "",
    opponent: oppTeamName,
    homeAway: isHome ? "home" : "away",
    stats: {
      MIN: parseMin(row.min),
      PTS: row.pts ?? 0,
      REB: row.reb ?? 0,
      AST: row.ast ?? 0,
      "3PM": row.fg3m ?? 0,
      STL: row.stl ?? 0,
      BLK: row.blk ?? 0,
      TO: row.turnover ?? 0,
    },
  };
}

// Round to nearest 0.5.
function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

// Actual stat value for a prop type from a single BDL row.
function actualStatFromRow(row: BdlStatRow, propType: string): number | null {
  switch (propType) {
    case "points": return row.pts ?? null;
    case "rebounds": return row.reb ?? null;
    case "assists": return row.ast ?? null;
    case "threes": return row.fg3m ?? null;
    case "steals": return row.stl ?? null;
    case "blocks": return row.blk ?? null;
  }
  return null;
}

// L10 average of a stat value from gameLog. Returns 0 if no data.
function l10Average(gameLog: GameLogEntry[], statKey: string): number {
  const window = gameLog.slice(0, 10);
  if (window.length === 0) return 0;
  let total = 0; let count = 0;
  for (const g of window) {
    const v = g.stats[statKey];
    if (typeof v === "number") { total += v; count++; }
  }
  return count > 0 ? total / count : 0;
}

const PROP_TYPES_PHASE_2 = ["points", "rebounds", "assists", "threes", "steals", "blocks"];
const STAT_KEY_BY_PROP: Record<string, string> = {
  points: "PTS", rebounds: "REB", assists: "AST",
  threes: "3PM", steals: "STL", blocks: "BLK",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "POST required" }, 405);
  }

  let body: BackfillRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (!body.start_date || !body.end_date || !isValidDate(body.start_date) || !isValidDate(body.end_date)) {
    return jsonResponse({ error: "start_date and end_date required (YYYY-MM-DD)" }, 400);
  }
  if (body.start_date > body.end_date) {
    return jsonResponse({ error: "start_date must be <= end_date" }, 400);
  }
  if (!BDL_API_KEY) {
    return jsonResponse({ error: "BALLDONTLIE_API_KEY not configured" }, 500);
  }
  if (!SUPA_URL || !SUPA_KEY) {
    return jsonResponse({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" }, 500);
  }

  // D-182 Phase 3: default raised from 15→500 for full production runs.
  // D-182 resume (May 15-16, 2026): re-capped default to 80 after adding
  // per-player BDL pacing (300ms/player). 80 × 300ms = 24s pacing budget,
  // plus ~50s scoring/persistence = ~75s per date, well under 150s ceiling.
  // For dates with >80 players, orchestration can chunk by player_id range
  // in a follow-up — not needed for D-182 PoC.
  const maxPlayers = Math.min(body.max_players ?? 80, 200);
  const dryRun = body.dry_run ?? false;
  const dates = eachDate(body.start_date, body.end_date);

  // Load weights once at request start.
  const weights: ScoringWeights = await loadWeightsFromDB();

  // D-181 helpers: historical mode — no injuries, no game-line, no opponent
  // injuries. D-187 (May 15, 2026): asOfDate is set PER DATE inside the loop
  // below, NOT here. Pre-D-187 bug: asOfDate omitted → scoreOneSide computed
  // staleDataPenalty against `new Date()` (today) for every backfill pick →
  // -30 × weight 2.25 = -67.5pt penalty stacked on every pick, locking the
  // entire cohort into Pass tier regardless of any other signal.

  type DateSummary = {
    date: string;
    bdl_player_rows: number;
    players_processed: number;
    picks_attempted: number;
    picks_scored: number;
    picks_persisted: number;
    persist_failures: number;
    rpc_errors: string[];
    // D-188: count of rows persisted to cache_player_game_logs across all
    // players processed for this date. Includes both new INSERTs and merge-
    // duplicate UPSERTs (REST API doesn't distinguish in return=minimal).
    cache_game_log_rows_written: number;
  };
  const summaries: DateSummary[] = [];
  let totalPicksPersisted = 0;

  for (const date of dates) {
    const summary: DateSummary = {
      date,
      bdl_player_rows: 0,
      players_processed: 0,
      picks_attempted: 0,
      picks_scored: 0,
      picks_persisted: 0,
      persist_failures: 0,
      rpc_errors: [],
      cache_game_log_rows_written: 0,
    };

    // D-187 (May 15, 2026): construct helpers PER DATE with asOfDate set to
    // the historical target_date. scoreOneSide.staleDataPenalty uses
    // (asOfDate - gameLog[0].date).days to decide if game logs are stale —
    // for backfill we want the comparison against the date being scored, not
    // today. Date is YYYY-MM-DD; T12:00:00Z anchors it to noon UTC to avoid
    // off-by-one timezone slips on the integer day-diff math downstream.
    const helpers: ScoreOneSideHelpers = {
      getTeamInjuries: () => Promise.resolve([]),
      getGameLine: () => null,
      getPlayerInjury: () => ({ isInjured: false, status: "", penalty: 0 }),
      asOfDate: new Date(`${date}T12:00:00Z`),
    };

    try {
      // D-182 Phase 3: resume-safety pre-query. Fetch existing
      // backfill-historical rows for this date so we can skip duplicates
      // on re-run. Single batched read keyed by (player_name, prop_type,
      // pick_side) tuples held in-memory for the date's pick loop.
      const existingKeys = new Set<string>();
      try {
        const existingUrl = `${SUPA_URL}/rest/v1/pick_history?` +
          `source=eq.backfill-historical&game_date=eq.${date.replace(/-/g, "")}` +
          `&select=player_name,prop_type,pick_side`;
        const existingRes = await fetch(existingUrl, {
          headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            // PostgREST default cap is 1000; raise via Range header for
            // dates with potentially large player coverage.
            Range: "0-9999",
            "Range-Unit": "items",
          },
        });
        if (existingRes.ok) {
          const existingRows = await existingRes.json() as Array<{
            player_name: string; prop_type: string; pick_side: string;
          }>;
          for (const r of existingRows) {
            existingKeys.add(`${r.player_name}|${r.prop_type}|${r.pick_side}`);
          }
          if (existingKeys.size > 0) {
            console.log(`[d182] resume-safety: ${existingKeys.size} existing rows for ${date}`);
          }
        }
      } catch (e) {
        console.log(`[d182] resume-safety pre-query failed (proceeding without skip-set): ${e instanceof Error ? e.message : String(e)}`);
      }

      // Step 1: fetch all stat rows for the target date.
      const targetStats = await fetchBdlStatsForDate(date);
      summary.bdl_player_rows = targetStats.length;

      // Dedupe to unique players (a player typically has 1 row per game).
      const seenPlayers = new Set<number>();
      const playersToProcess: BdlStatRow[] = [];
      for (const r of targetStats) {
        if (!r.player?.id) continue;
        if (parseMin(r.min) < 1) continue; // skip DNPs
        if (seenPlayers.has(r.player.id)) continue;
        seenPlayers.add(r.player.id);
        playersToProcess.push(r);
        if (playersToProcess.length >= maxPlayers) break;
      }

      // Step 2: for each player → fetch prior game log → score per prop type.
      // D-182 resume (May 15-16, 2026): per-player BDL pacing added after
      // empirical evidence that an unpaced loop (225 players × 1 BDL request
      // each in ~29s = ~466 req/min) blew past BDL's per-key rate limit and
      // most prior-game fetches returned empty mid-loop. 300ms pacing keeps
      // sustained rate under 200 req/min — safe on GOAT tier per docs.
      for (let pIdx = 0; pIdx < playersToProcess.length; pIdx++) {
        const targetRow = playersToProcess[pIdx];
        summary.players_processed++;
        const playerId = targetRow.player.id;
        const playerName = `${targetRow.player.first_name ?? ""} ${targetRow.player.last_name ?? ""}`.trim();

        // Skip if no name (data quality)
        if (!playerName) continue;

        // D-182: pace per-player BDL fetches after the first one.
        if (pIdx > 0) await new Promise((r) => setTimeout(r, 300));

        // Build the player's rolling game log.
        const priorRows = await fetchBdlPriorGamesForPlayer(playerId, date);
        if (priorRows.length < 5) {
          console.log(`[d181] skipping ${playerName} — only ${priorRows.length} prior games`);
          continue;
        }
        // D-188: persist the priorRows to cache_player_game_logs (idempotent
        // UPSERT) so D-186 Phase 4 rescore can rebuild gameLog without
        // re-fetching BDL. Non-blocking on failure — backfill continues with
        // in-memory gameLog regardless.
        const cacheWrite = await persistGameLogsToCache(playerId, playerName, priorRows);
        summary.cache_game_log_rows_written += cacheWrite.written;
        if (cacheWrite.error) {
          console.log(`[d188] cache_player_game_logs UPSERT failed for ${playerName}: ${cacheWrite.error}`);
        }
        const gameLog: GameLogEntry[] = priorRows.map((r) => bdlRowToGameLogEntry(r, targetRow.team?.id ?? 0));
        const minutesTrend = calculateMinutesTrend(gameLog);

        const playerData: CachedPlayerData = {
          player: {
            id: String(playerId),
            displayName: playerName,
            team: targetRow.team?.full_name ?? "",
            position: targetRow.player.position ?? "",
          },
          gameLog,
          minutesTrend,
        };

        // Determine target_date home/away context.
        const isHome = targetRow.game?.home_team_id === targetRow.team?.id;
        const homeTeam = isHome ? (targetRow.team?.full_name ?? "") : "";
        const awayTeam = isHome ? "" : (targetRow.team?.full_name ?? "");

        // edgeData: b2b detection from gameLog — was the most recent prior game
        // the day before target_date?
        const priorGameDate = priorRows[0]?.game?.date ?? "";
        const isBackToBack = (() => {
          if (!priorGameDate) return false;
          const target = new Date(date + "T00:00:00Z");
          const prior = new Date(priorGameDate + "T00:00:00Z");
          const daysDiff = Math.round((target.getTime() - prior.getTime()) / 86400000);
          return daysDiff === 1;
        })();
        const restDays = (() => {
          if (!priorGameDate) return 0;
          const target = new Date(date + "T00:00:00Z");
          const prior = new Date(priorGameDate + "T00:00:00Z");
          return Math.max(0, Math.round((target.getTime() - prior.getTime()) / 86400000) - 1);
        })();

        const edgeData = {
          b2b: { isBackToBack, restDays },
          oppStats: null,
        };

        // Step 3: score per prop type.
        for (const propType of PROP_TYPES_PHASE_2) {
          const statKey = STAT_KEY_BY_PROP[propType];
          const l10 = l10Average(gameLog, statKey);
          if (l10 < 0.5) continue; // skip near-zero lines (steals/blocks for low-volume players)
          const line = roundToHalf(l10);
          summary.picks_attempted++;

          const prop: ExtractedProp = {
            playerName,
            propType,
            line,
            odds: -110,
            homeTeam,
            awayTeam,
            gameTime: date,
          };

          let result: PropAnalysisResult | null;
          try {
            result = await scoreOneSide(playerData, prop, edgeData, "over", weights, helpers);
          } catch (e) {
            console.log(`[d181] scoreOneSide threw for ${playerName} ${propType}: ${e instanceof Error ? e.message : String(e)}`);
            continue;
          }
          if (!result) continue; // insufficient data
          summary.picks_scored++;

          // Resolve immediately: actual stat from the target_date row.
          const actual = actualStatFromRow(targetRow, propType);
          if (actual == null) continue;
          const hit = actual > line;

          // D-182 Phase 3: resume-safety check — skip if this pick was
          // already persisted on a prior run.
          const key_d182 = `${playerName}|${propType}|over`;
          if (existingKeys.has(key_d182)) continue;

          if (dryRun) continue;

          // Persist via direct POST (see commit message for rationale).
          const breakdown = result.breakdown ?? {};
          const gameDateYmd = date.replace(/-/g, "");
          const payload = {
            player_name: playerName,
            team: targetRow.team?.full_name ?? "",
            opponent: "",
            game_time: date,
            game_date: gameDateYmd,
            is_home: isHome,
            prop_type: propType,
            line,
            pick_side: "over",
            odds: -110,
            season_avg: result.seasonAvg ?? null,
            recent_avg: result.recentAvg ?? null,
            floor_val: result.floor ?? null,
            ceiling_val: result.ceiling ?? null,
            l5_hit_count: result.hitRatesRaw?.l5Hits ?? null,
            l10_hit_count: result.hitRatesRaw?.l10Hits ?? null,
            season_hit_pct: result.hitRatesRaw?.seasonRate ?? null,
            is_b2b: isBackToBack,
            rest_days: restDays,
            minutes_l5_avg: minutesTrend.l5Avg,
            minutes_l10_avg: minutesTrend.l10Avg,
            minutes_trend: minutesTrend.direction,
            // Scoring factors from breakdown
            score_l5: breakdown.l5HitRate ?? 0,
            score_l10: breakdown.l10HitRate ?? 0,
            score_season: breakdown.seasonHitRate ?? 0,
            score_floor_ceiling: breakdown.floorCeiling ?? 0,
            score_recent_form: breakdown.recentForm ?? 0,
            score_home_away: breakdown.homeAway ?? 0,
            score_rest: breakdown.restDays ?? 0,
            score_b2b: breakdown.backToBack ?? 0,
            score_minutes_trend: breakdown.minutesTrend ?? 0,
            score_pace: breakdown.pace ?? 0,
            score_opp_defense: breakdown.opponentDefense ?? 0,
            score_odds_value: breakdown.oddsValue ?? 0,
            score_prop_type_penalty: breakdown.propTypePenalty ?? 0,
            score_z_score: breakdown.zScoreBonus ?? 0,
            score_role_change: breakdown.roleChangeBonus ?? 0,
            score_vig_filter: breakdown.vigFilterPenalty ?? 0,
            score_usg_rate: breakdown.usgBonus ?? 0,
            score_regression: breakdown.regressionBonus ?? 0,
            score_market_conf: breakdown.marketConfBonus ?? 0,
            score_home_away_split: breakdown.homeAwaySplitBonus ?? 0,
            score_minutes_floor: breakdown.minutesFloorBonus ?? 0,
            score_minutes_volume: breakdown.minutesVolumeBonus ?? 0,
            score_minutes_stability: breakdown.minutesStabilityBonus ?? 0,
            score_consistency: breakdown.consistencyBonus ?? 0,
            score_stale_data: breakdown.staleDataPenalty ?? 0,
            score_player_injury: breakdown.playerInjuryPenalty ?? 0,
            score_trivial_line_penalty: breakdown.trivialLinePenalty ?? 0,
            score_trivial_line_cap: (breakdown.trivialLineCapApplied ?? 0) > 0,
            score_low_min_risk: breakdown.lowMinRiskPenalty ?? 0,
            score_blowout_risk: breakdown.blowoutRiskPenalty ?? 0,
            score_line_movement: breakdown.lineMovementBonus ?? 0,
            // D-164/166/167 flags (D-177-B/C COALESCE makes these defensive)
            unbettable_juice_flag: result.unbettableJuiceFlag ?? false,
            coin_flip_flag: result.coinFlipFlag ?? false,
            negative_stacking_flag: result.negativeStackingFlag ?? false,
            negative_factor_count: result.negativeFactorCount ?? 0,
            // Projection data
            projected_stat: result.projectionData?.projectedStat ?? null,
            stat_stdev: result.projectionData?.statStdDev ?? null,
            z_score: result.projectionData?.zScore ?? null,
            per_minute_rate: result.projectionData?.perMinRate ?? null,
            projected_minutes: result.projectionData?.projectedMinutes ?? null,
            teammate_injuries_count: result.projectionData?.teammateInjuriesCount ?? null,
            usage_boost: result.projectionData?.usageBoost ?? null,
            // Final
            confidence: result.confidence,
            verdict: result.verdict,
            ai_analysis: null,
            // D-198 (May 17, 2026): tier-aware audit. Equals confidence on
            // identity multipliers; diverges once §19.3 tunes
            // algorithm_weights_tier_modifiers.
            confidence_pre_tier_aware: (result as { confidence_pre_tier_aware?: number | null }).confidence_pre_tier_aware ?? result.confidence,
            // Resolution (the headline value of D-181 — resolved at write time)
            actual_value: actual,
            hit,
            resolved_at: new Date().toISOString(),
            // Source markers
            source: "backfill-historical",
            recommendation_shown: false,
            is_synthetic: true,
            sport: "nba",
            algorithm_version: ALGORITHM_VERSION,
          };

          // D-181: write via DIRECT POST to /rest/v1/pick_history (not the RPC).
          // The upsert_pick_history RPC (post-D-172a + D-177-B/C) covers all
          // SCORING columns but omits backfill-specific columns: `hit`,
          // `actual_value`, `resolved_at`, `algorithm_version`, `backfill_run_id`.
          // Live-cron rows are pre-resolution (hit=null) so RPC was sufficient
          // for that path. Backfill rows are POST-resolution so the omitted
          // columns matter — direct POST writes the full payload as-is, and
          // synthetic rows don't hit the partial-unique-index conflict
          // (predicate `WHERE is_synthetic = false`).
          try {
            const postRes = await fetch(`${SUPA_URL}/rest/v1/pick_history`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                apikey: SUPA_KEY,
                Authorization: `Bearer ${SUPA_KEY}`,
                Prefer: "return=minimal",
              },
              body: JSON.stringify(payload),
            });
            if (postRes.ok) {
              summary.picks_persisted++;
              totalPicksPersisted++;
            } else {
              summary.persist_failures++;
              const errText = await postRes.text();
              if (summary.rpc_errors.length < 3) {
                summary.rpc_errors.push(`${postRes.status}: ${errText.slice(0, 200)}`);
              }
            }
          } catch (e) {
            summary.persist_failures++;
            if (summary.rpc_errors.length < 3) {
              summary.rpc_errors.push(e instanceof Error ? e.message : String(e));
            }
          }
        }
      }
    } catch (e) {
      console.log(`[d181] date ${date} failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    summaries.push(summary);
  }

  return jsonResponse({
    success: true,
    phase: "3-full-month",
    algorithm_version: ALGORITHM_VERSION,
    dry_run: dryRun,
    dates_requested: dates.length,
    total_picks_persisted: totalPicksPersisted,
    picks_generated: totalPicksPersisted,
    summaries,
    spec_file: "/tmp/d180_nba_historical_backfill_spec.md",
  });
});
