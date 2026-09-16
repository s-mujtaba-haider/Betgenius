import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";
import { captureError } from "../_shared/sentry.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// D-728: name normalization centralized to _shared/name_normalizer.ts.
// resolve-picks was the upstream source for the canonical impl (D-716);
// now every module pulls from the same place — no more cross-module drift.
import { canonicalNormalizeName as normalizeName } from "../_shared/name_normalizer.ts";

// Supabase REST API helpers
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabaseHeaders = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
};

// D-253f dry-run gate: module-scope flag set at top of Deno.serve per-request.
// Deno edge functions are per-invocation so module-scope effectively scopes to
// the current request. Writer helpers (updatePickResult, voidPick, the bets
// PATCH inside resolvePendingBets, and resetBadData) early-return when true.
// D-247 pick-resolution logic (push semantics, resolved_at filter) is
// preserved untouched — the gate ONLY suppresses the final PATCH I/O.
let _dryRun = false;
const _dryRunCounts = {
  pick_history_updates: 0,  // updatePickResult (actual_value/hit/resolved_at)
  pick_history_voids: 0,    // voidPick (voided=true)
  bets_updates: 0,          // bets PATCH (status/payout/result_value/settled_at)
};
function _resetDryRunCounts(): void {
  _dryRunCounts.pick_history_updates = 0;
  _dryRunCounts.pick_history_voids = 0;
  _dryRunCounts.bets_updates = 0;
}
function _dryRunSummary(elapsedMs: number): Record<string, unknown> {
  return {
    dry_run: true,
    would_write: {
      pick_history: _dryRunCounts.pick_history_updates + _dryRunCounts.pick_history_voids,
      pick_history_updates: _dryRunCounts.pick_history_updates,
      pick_history_voids: _dryRunCounts.pick_history_voids,
      bets: _dryRunCounts.bets_updates,
    },
    elapsed_ms: elapsedMs,
  };
}

async function quietFetch(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  }
}

// Prop type to stat key mapping - use the exact keys ESPN returns
const PROP_STAT_MAP: Record<string, string[]> = {
  points: ["points", "pts"],
  rebounds: ["rebounds", "totalRebounds", "reb"],
  assists: ["assists", "ast"],
  threes: ["threePointFieldGoalsMade", "threepointersmade", "3pm"],
  steals: ["steals", "stl"],
  blocks: ["blocks", "blk"],
};

function getStatFromBox(stats: Record<string, string | number>, propType: string): number | null {
  const normalizedProp = propType.replace("player_", "").toLowerCase();
  const keys = PROP_STAT_MAP[normalizedProp] ?? [normalizedProp];

  for (const key of keys) {
    const val = stats[key];
    if (val !== undefined && val !== null && val !== "") {
      const num = typeof val === "number" ? val : parseFloat(String(val));
      if (!isNaN(num)) {
        console.log(`[resolve] getStatFromBox: ${propType} -> ${key}=${num}`);
        return num;
      }
    }
  }
  console.log(`[resolve] getStatFromBox: ${propType} not found, tried keys: [${keys.join(", ")}]`);
  return null;
}

// Parse game_time string like "7:00 PM ET" to compare with current time
function parseGameTime(gameTimeStr: string, gameDate: string): Date | null {
  try {
    const match = gameTimeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;

    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const ampm = match[3].toUpperCase();

    if (ampm === "PM" && hours !== 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;

    const date = new Date(gameDate);
    date.setHours(hours, minutes, 0, 0);
    return date;
  } catch {
    return null;
  }
}

// Convert UTC timestamp to US Eastern date string (YYYYMMDD).
// D-162 (May 14, 2026): DST-safe via Intl. Pre-D-162 used raw -4h which is
// correct only during EDT (Mar–Nov); EST (Nov 2+, UTC-5) produced off-by-
// one-day dates in the 04:00-04:59 UTC window, mis-bucketing bet resolutions.
function utcToEasternDate(utcTimestamp: string): string {
  return new Date(utcTimestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replace(/-/g, "");
}

// Extract game date from pick - use game_time if available, otherwise created_at
function getPickGameDate(pick: { game_time: string; created_at: string }): string {
  // If game_time contains a date like "2026-02-07 7:00 PM ET", parse it
  const dateMatch = pick.game_time?.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    return dateMatch[1].replace(/-/g, "");
  }
  // Otherwise convert created_at from UTC to Eastern
  return utcToEasternDate(pick.created_at);
}

// Extract game date from bet placed_at (UTC to Eastern)
function getBetGameDate(bet: { placed_at: string }): string {
  return utcToEasternDate(bet.placed_at);
}

// Fetch unresolved picks from pick_history
async function fetchUnresolvedPicks(): Promise<Array<{
  id: string;
  player_name: string;
  team: string;
  prop_type: string;
  line: number;
  pick_side: string;
  game_time: string;
  created_at: string;
}>> {
  // Only resolve picks whose game_date is before today (Eastern time)
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const todayDate = eastern.toISOString().slice(0, 10).replace(/-/g, '');
  // D-247 (2026-05-19): filter on resolved_at=is.null (not hit=is.null) so
  // PUSH picks (actual_value == line → hit=null, voided=false, resolved_at SET)
  // aren't re-fetched on every cron tick.
  const url = `${SUPABASE_URL}/rest/v1/pick_history?resolved_at=is.null&voided=neq.true&game_date=lt.${todayDate}&select=id,player_name,team,prop_type,line,pick_side,game_time,created_at,game_date&order=created_at.asc&limit=100`;

  const res = await fetch(url, { headers: supabaseHeaders });
  if (!res.ok) {
    console.log(`[resolve] Failed to fetch unresolved picks: ${res.status}`);
    return [];
  }

  const picks = await res.json();
  return picks;
}

// Update a pick with the result
// D-247: hit can be null (push semantics; actual_value == line).
// D-253f: dry-run early-return BEFORE the PATCH I/O. Increments counter so the
// final response can report `would_write.pick_history`. Returns synthetic true.
async function updatePickResult(
  pickId: string,
  actualValue: number,
  hit: boolean | null
): Promise<boolean> {
  if (_dryRun) {
    _dryRunCounts.pick_history_updates++;
    return true;
  }
  const url = `${SUPABASE_URL}/rest/v1/pick_history?id=eq.${pickId}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...supabaseHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify({
      actual_value: actualValue,
      hit,
      resolved_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.log(`[resolve] Failed to update pick ${pickId}: ${res.status} - ${errText}`);
    return false;
  }

  // D-326 SHIP 1 — copy ai_analysis from recommendations_cache at resolve time.
  // Closes d310 GAP-1: Performance + BetTracker tabs were blind on resolved
  // picks because ai_analysis was always NULL post-resolution. Best-effort:
  // failure is NON-FATAL (the underlying pick was already updated successfully),
  // but D-727 wants the WHY visible — replace the silent swallow with a
  // logResolverFailure call. Control flow unchanged.
  try {
    await copyAiAnalysisFromCache(pickId);
  } catch (e) {
    await logResolverFailure({
      pickId, failureType: "ai_analysis_copy_failed",
      detail: `copyAiAnalysisFromCache threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  return true;
}

// D-326 SHIP 1 — best-effort backfill of pick_history.ai_analysis from the
// matching recommendations_cache row (5-field composite key, per d310 audit).
// Idempotent: PATCH includes &ai_analysis=is.null guard, so safe to re-run.
async function copyAiAnalysisFromCache(pickId: string): Promise<void> {
  const pickRes = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_history?id=eq.${pickId}&select=player_name,team,game_date,prop_type,pick_side,ai_analysis&limit=1`,
    { headers: supabaseHeaders },
  );
  if (!pickRes.ok) return;
  const pickRows = await pickRes.json() as Array<{ player_name?: string; team?: string; game_date?: string; prop_type?: string; pick_side?: string; ai_analysis?: string | null }>;
  const pick = pickRows?.[0];
  if (!pick || pick.ai_analysis) return;
  if (!pick.player_name || !pick.team || !pick.game_date || !pick.prop_type || !pick.pick_side) return;

  const q = new URLSearchParams({
    player_name: `eq.${pick.player_name}`,
    team: `eq.${pick.team}`,
    game_date: `eq.${pick.game_date}`,
    prop_type: `eq.${pick.prop_type}`,
    pick_side: `eq.${pick.pick_side}`,
    ai_analysis: "not.is.null",
    order: "created_at.desc",
    limit: "1",
    select: "ai_analysis",
  });
  const cacheRes = await fetch(`${SUPABASE_URL}/rest/v1/recommendations_cache?${q.toString()}`, { headers: supabaseHeaders });
  if (!cacheRes.ok) return;
  const cacheRows = await cacheRes.json() as Array<{ ai_analysis?: string | null }>;
  const ai = cacheRows?.[0]?.ai_analysis;
  if (!ai) return;

  await fetch(
    `${SUPABASE_URL}/rest/v1/pick_history?id=eq.${pickId}&ai_analysis=is.null`,
    {
      method: "PATCH",
      headers: { ...supabaseHeaders, "Prefer": "return=minimal" },
      body: JSON.stringify({ ai_analysis: ai }),
    },
  );
}

// D-727: canonical failure_type strings, mirrored from the
// resolver_failure_log.d727_failure_type_known CHECK constraint.
type ResolverFailureType =
  | "name_no_match"
  | "player_id_no_match"
  | "dnp"
  | "boxscore_fetch_failed"
  | "game_market_no_match"
  | "stat_not_extractable"
  | "no_final_games_on_date"
  | "ai_analysis_copy_failed"
  | "unknown";

// D-727: write a row to resolver_failure_log. Best-effort: if the insert fails
// we still log to console, but we never throw — visibility must not break the
// resolution pipeline. Mirrors the principle in voidPick's PATCH error path.
async function logResolverFailure(opts: {
  pickId?: string | null;
  betId?: string | null;
  market?: string | null;
  failureType: ResolverFailureType;
  detail?: string;
  gamePk?: number | null;
  gameDate?: string | null;
}): Promise<void> {
  if (_dryRun) return; // dry-run skips writes per the existing convention
  const row: Record<string, unknown> = {
    failure_type: opts.failureType,
  };
  if (opts.pickId)   row.pick_id   = opts.pickId;
  if (opts.betId)    row.bet_id    = opts.betId;
  if (opts.market)   row.market    = opts.market;
  if (opts.detail)   row.detail    = opts.detail.slice(0, 1000);
  if (opts.gamePk != null) row.game_pk = opts.gamePk;
  if (opts.gameDate) row.game_date = opts.gameDate;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/resolver_failure_log`, {
      method: "POST",
      headers: { ...supabaseHeaders, "Prefer": "return=minimal", "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.log(`[d727] resolver_failure_log insert failed status=${res.status} type=${opts.failureType} pickId=${opts.pickId ?? "null"}`);
    }
  } catch (e) {
    console.log(`[d727] resolver_failure_log fetch error: ${e}`);
  }
}

// Void a pick (DNP / no game / unresolvable)
// D-253f: dry-run early-return before PATCH I/O.
// D-727: accepts a reason that gets written to pick_history.resolution_note
// (the column existed but was unused — D-718 finding). Every void now carries
// its WHY at the row level, in addition to being timestamped (D-726 guarantee).
// reasonType also gets logged to resolver_failure_log for cross-row audit.
async function voidPick(
  pickId: string,
  reasonType: ResolverFailureType,
  reasonDetail?: string,
  ctx?: { market?: string | null; gamePk?: number | null; gameDate?: string | null },
): Promise<boolean> {
  if (_dryRun) {
    _dryRunCounts.pick_history_voids++;
    return true;
  }
  // Audit log (best-effort; never blocks the void)
  await logResolverFailure({
    pickId, failureType: reasonType, detail: reasonDetail,
    market: ctx?.market ?? null, gamePk: ctx?.gamePk ?? null, gameDate: ctx?.gameDate ?? null,
  });
  // Build a short human-readable note for the row-level audit column
  const noteParts: string[] = [reasonType];
  if (reasonDetail) noteParts.push(reasonDetail);
  const resolutionNote = noteParts.join(": ").slice(0, 500);
  const url = `${SUPABASE_URL}/rest/v1/pick_history?id=eq.${pickId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...supabaseHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify({
      voided: true,
      resolved_at: new Date().toISOString(),
      resolution_note: resolutionNote,
    }),
  });
  if (!res.ok) {
    console.log(`[resolve] Failed to void pick ${pickId} (reason=${reasonType}): ${res.status}`);
    return false;
  }
  return true;
}

// Reset incorrectly resolved data
async function resetBadData(): Promise<{ picksReset: number; betsReset: number }> {
  console.log(`[resolve] Resetting incorrectly resolved data...`);

  // Reset picks where resolved_at is set but actual_value/hit are NULL
  const resetPicksUrl = `${SUPABASE_URL}/rest/v1/pick_history?resolved_at=not.is.null&actual_value=is.null`;
  const resetPicksRes = await fetch(resetPicksUrl, {
    method: "PATCH",
    headers: { ...supabaseHeaders, "Prefer": "return=representation" },
    body: JSON.stringify({
      actual_value: null,
      hit: null,
      resolved_at: null,
    }),
  });

  let picksReset = 0;
  if (resetPicksRes.ok) {
    const resetPicks = await resetPicksRes.json();
    picksReset = Array.isArray(resetPicks) ? resetPicks.length : 0;
    console.log(`[resolve] Reset ${picksReset} picks with NULL actual_value`);
  }

  // Reset all settled bets back to pending
  const resetBetsUrl = `${SUPABASE_URL}/rest/v1/bets?settled_at=not.is.null`;
  const resetBetsRes = await fetch(resetBetsUrl, {
    method: "PATCH",
    headers: { ...supabaseHeaders, "Prefer": "return=representation" },
    body: JSON.stringify({
      status: "pending",
      payout: null,
      result_value: null,
      settled_at: null,
    }),
  });

  let betsReset = 0;
  if (resetBetsRes.ok) {
    const resetBets = await resetBetsRes.json();
    betsReset = Array.isArray(resetBets) ? resetBets.length : 0;
    console.log(`[resolve] Reset ${betsReset} bets to pending`);
  }

  return { picksReset, betsReset };
}

// Fetch ESPN scoreboard for a specific date
async function fetchScoreboard(dateStr: string): Promise<Array<{
  id: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  homeScore: number;
  awayScore: number;
}>> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`;
  console.log(`[resolve] Fetching scoreboard: ${url}`);
  const { ok, text } = await quietFetch(url);

  if (!ok || !text) {
    console.log(`[resolve] Scoreboard fetch failed for ${dateStr}`);
    return [];
  }

  try {
    const data = JSON.parse(text);
    const games: Array<{ id: string; homeTeam: string; awayTeam: string; status: string }> = [];

    for (const event of data?.events ?? []) {
      const competition = event?.competitions?.[0];
      if (!competition) continue;

      const status = competition?.status?.type?.name ?? "";
      const competitors = competition?.competitors ?? [];

      const home = competitors.find((c: { homeAway?: string }) => c.homeAway === "home");
      const away = competitors.find((c: { homeAway?: string }) => c.homeAway === "away");

      const homeTeam = home?.team?.displayName ?? "";
      const awayTeam = away?.team?.displayName ?? "";

      console.log(`[resolve] Game ${event.id}: ${awayTeam} @ ${homeTeam} - ${status}`);

      const homeScore = parseInt(home?.score ?? "0") || 0;
      const awayScore = parseInt(away?.score ?? "0") || 0;
      games.push({
        id: event.id,
        homeTeam,
        awayTeam,
        status,
        homeScore,
        awayScore,
      });
    }

    return games;
  } catch (e) {
    console.log(`[resolve] Error parsing scoreboard: ${e}`);
    return [];
  }
}

// Player stats structure
interface PlayerBoxStats {
  rawName: string;
  normalizedName: string;
  team: string;
  stats: Record<string, number>;
  rawLabels: string[];
  rawValues: string[];
}

// Fetch box score for a specific game - FIXED ESPN parsing
async function fetchBoxScore(gameId: string, homeTeam: string, awayTeam: string): Promise<Map<string, PlayerBoxStats>> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`;
  console.log(`[resolve] Fetching box score: ${url}`);
  const { ok, text } = await quietFetch(url);

  const playerStats = new Map<string, PlayerBoxStats>();

  if (!ok || !text) {
    console.log(`[resolve] Box score fetch failed for game ${gameId}`);
    return playerStats;
  }

  try {
    const data = JSON.parse(text);
    const boxScore = data?.boxscore;

    if (!boxScore?.players) {
      console.log(`[resolve] No boxscore.players found for game ${gameId}`);
      console.log(`[resolve] Available keys in response: ${Object.keys(data || {}).join(", ")}`);
      return playerStats;
    }

    // boxscore.players is an array of team objects
    // Each team has: team, statistics[]
    // Each statistics entry has: names[] (stat labels), athletes[]
    // Each athlete has: athlete.displayName, stats[]

    for (const teamData of boxScore.players) {
      const teamName = teamData?.team?.displayName ?? "Unknown";
      const statistics = teamData?.statistics ?? [];

      console.log(`[resolve] Team: ${teamName}, stat categories: ${statistics.length}`);

      for (const statCategory of statistics) {
        // ESPN uses "names" for the stat labels, not "labels"
        const names = statCategory?.names ?? statCategory?.labels ?? [];
        const athletes = statCategory?.athletes ?? [];

        console.log(`[resolve]   Stat labels (${names.length}): [${names.slice(0, 10).join(", ")}${names.length > 10 ? "..." : ""}]`);

        for (const athlete of athletes) {
          const rawName = athlete?.athlete?.displayName ?? "";
          const statsArray: string[] = athlete?.stats ?? [];

          if (!rawName) continue;

          const normalizedName = normalizeName(rawName);

          // Get existing player data or create new
          const existingPlayer = playerStats.get(normalizedName);
          const stats: Record<string, number> = existingPlayer?.stats ?? {};
          const allLabels: string[] = existingPlayer?.rawLabels ?? [];
          const allValues: string[] = existingPlayer?.rawValues ?? [];

          // Build stats object by mapping names[i] to statsArray[i]
          // MERGE with existing stats instead of overwriting
          for (let i = 0; i < names.length && i < statsArray.length; i++) {
            const statName = String(names[i]).toLowerCase();
            const statValue = statsArray[i];

            // Track all raw data
            allLabels.push(statName);
            allValues.push(statValue);

            // Parse the stat value
            // Some stats like FG are "5-12" format, skip those
            // We want numeric values like PTS, REB, AST
            if (typeof statValue === "string" && statValue.includes("-") && !statValue.startsWith("-")) {
              // This is a made-attempted format like "5-12", skip it
              continue;
            }

            const numValue = parseFloat(statValue);
            if (!isNaN(numValue)) {
              stats[statName] = numValue;
            }
          }

          const playerData: PlayerBoxStats = {
            rawName,
            normalizedName,
            team: teamName,
            stats,
            rawLabels: allLabels,
            rawValues: allValues,
          };

          // Debug logging for specific players
          const lowerName = rawName.toLowerCase();
          if (lowerName.includes("flagg") || lowerName.includes("doncic") || lowerName.includes("irving")) {
            console.log(`[resolve]     Category labels: [${names.join(", ")}]`);
            console.log(`[resolve]     Category values: [${statsArray.join(", ")}]`);
            console.log(`[resolve]     Merged stats: ${JSON.stringify(stats)}`);
          }

          playerStats.set(normalizedName, playerData);
        }
      }
    }

    console.log(`[resolve] Game ${gameId}: Found ${playerStats.size} players`);
    return playerStats;
  } catch (e) {
    console.log(`[resolve] Error parsing box score for game ${gameId}: ${e}`);
    return playerStats;
  }
}

// Check if player name matches
function playerNamesMatch(pickName: string, boxName: string): boolean {
  const p = pickName;
  const b = boxName;

  if (p === b) return true;

  const pParts = p.split(/\s+/);
  const bParts = b.split(/\s+/);

  if (pParts.length >= 2 && bParts.length >= 2) {
    const pLast = pParts[pParts.length - 1];
    const bLast = bParts[bParts.length - 1];
    const pFirst = pParts[0];
    const bFirst = bParts[0];

    if (pLast === bLast) {
      if (pFirst === bFirst || pFirst[0] === bFirst[0]) {
        return true;
      }
    }
  }

  if (p.includes(b) || b.includes(p)) return true;

  return false;
}

// Get stat value from PlayerBoxStats
function getPlayerStat(player: PlayerBoxStats, propType: string): number | null {
  const normalizedProp = propType.replace("player_", "").toLowerCase();
  const keys = PROP_STAT_MAP[normalizedProp] ?? [normalizedProp];

  for (const key of keys) {
    const val = player.stats[key];
    if (val !== undefined && val !== null) {
      console.log(`[resolve] ${player.rawName} ${propType}: ${key}=${val}`);
      return val;
    }
  }

  // Log available stats for debugging
  const availableStats = Object.keys(player.stats).join(", ");
  console.log(`[resolve] ${player.rawName} ${propType}: NOT FOUND (available: ${availableStats})`);
  return null;
}

// Type for date-keyed box scores: Map<dateStr, Map<playerName, stats>>
type DateKeyedBoxScores = Map<string, Map<string, PlayerBoxStats>>;

// Fetch box scores for specific dates, keyed by date
async function fetchBoxScoresForDates(dates: Set<string>): Promise<DateKeyedBoxScores> {
  const boxScoresByDate: DateKeyedBoxScores = new Map();

  for (const dateStr of dates) {
    console.log(`[resolve] Fetching box scores for ${dateStr}...`);
    const games = await fetchScoreboard(dateStr);
    const completedGames = games.filter(g => g.status === "STATUS_FINAL");

    if (!completedGames.length) {
      console.log(`[resolve]   No completed games for ${dateStr}`);
      continue;
    }

    const dateBoxScores = new Map<string, PlayerBoxStats>();

    for (const game of completedGames) {
      const boxScore = await fetchBoxScore(game.id, game.homeTeam, game.awayTeam);
      for (const [name, stats] of boxScore) {
        dateBoxScores.set(name, stats);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    boxScoresByDate.set(dateStr, dateBoxScores);
    console.log(`[resolve]   ${dateStr}: ${dateBoxScores.size} players`);
  }

  let totalPlayers = 0;
  for (const dateScores of boxScoresByDate.values()) {
    totalPlayers += dateScores.size;
  }
  console.log(`[resolve] Loaded ${totalPlayers} player-game entries across ${boxScoresByDate.size} dates`);
  return boxScoresByDate;
}

// Find player in date-keyed box scores, trying primary date then previous day
function findPlayerByDate(
  playerName: string,
  gameDate: string,
  boxScoresByDate: DateKeyedBoxScores
): { player: PlayerBoxStats | null; matchedDate: string | null } {
  const searchName = normalizeName(playerName);

  // Try primary date first
  const primaryDateScores = boxScoresByDate.get(gameDate);
  if (primaryDateScores) {
    // Exact match
    const exactMatch = primaryDateScores.get(searchName);
    if (exactMatch) {
      return { player: exactMatch, matchedDate: gameDate };
    }
    // Fuzzy match
    for (const [boxName, stats] of primaryDateScores) {
      if (playerNamesMatch(searchName, boxName)) {
        return { player: stats, matchedDate: gameDate };
      }
    }
  }

  // Try previous day (for late-night games)
  const prevDate = new Date(
    parseInt(gameDate.slice(0, 4)),
    parseInt(gameDate.slice(4, 6)) - 1,
    parseInt(gameDate.slice(6, 8))
  );
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateStr = prevDate.toISOString().slice(0, 10).replace(/-/g, "");

  const prevDateScores = boxScoresByDate.get(prevDateStr);
  if (prevDateScores) {
    // Exact match
    const exactMatch = prevDateScores.get(searchName);
    if (exactMatch) {
      return { player: exactMatch, matchedDate: prevDateStr };
    }
    // Fuzzy match
    for (const [boxName, stats] of prevDateScores) {
      if (playerNamesMatch(searchName, boxName)) {
        return { player: stats, matchedDate: prevDateStr };
      }
    }
  }

  return { player: null, matchedDate: null };
}

// Resolve pending bets directly from ESPN box scores (date-aware)
async function resolvePendingBets(
  boxScoresByDate: DateKeyedBoxScores
): Promise<number> {
  console.log(`\n[resolve] === RESOLVING PENDING BETS ===`);

  // D-673 SHIP 1 — REMOVED the early-return on empty boxScoresByDate.
  // Pre-fix: when boxScoresByDate.size === 0 (typical for MLB-only days
  // since fetchBoxScoresForDates is ESPN/NBA), the function returned 0
  // without running the pick_id-direct branch (line 753+), so MLB bets
  // whose pick_history.hit was already populated by resolveMlbPicks
  // stayed PENDING forever. The pick_id-direct branch doesn't need box
  // scores — it reads pick_history.hit/actual_value directly.
  // Now: continue into the pendingBets loop. If boxScoresByDate IS empty,
  // only the pick_id-direct branch runs (NBA player-prop matching skips).
  if (boxScoresByDate.size === 0) {
    console.log(`[resolve] No box scores available — running pick_id-direct branch only (D-673 SHIP 1)`);
  }

  // Only resolve bets whose game date is before today (Eastern time)
  const betNow = new Date();
  const betEastern = new Date(betNow.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const betTodayDate = betEastern.toISOString().slice(0, 10).replace(/-/g, '');
  
  // D-504: include pick_id so the pick_id-direct branch below can use the
  // linked pick_history row's hit/voided/actual_value to settle without
  // having to re-match the player. Without pick_id, game-level bets
  // (spread / game_total / h2h / game_side) whose player_name is a
  // "Team A vs Team B (side X)" matchup tag couldn't be settled — they
  // fell through findPlayerByDate → continue and stayed pending forever.
  const pendingBetsUrl = `${SUPABASE_URL}/rest/v1/bets?status=eq.pending&select=id,pick_id,player_name,prop_type,line,pick_side,odds,stake,placed_at`;
  const pendingRes = await fetch(pendingBetsUrl, { headers: supabaseHeaders });

  // D-515 SHIP 1 — LOUD FAIL on bets-fetch non-OK (D-506 SHIP 2b pattern).
  // Pre-fix: 500 → `return 0` → caller sees "0 bets" → cron run reports
  // success → silent stall on the bets-resolution side of D-506.
  if (!pendingRes.ok) {
    const _errBody = await pendingRes.text().catch(() => "");
    throw new Error(`pending bets fetch failed: status=${pendingRes.status} body=${_errBody.slice(0, 300)}`);
  }

  const pendingBetsRaw = await pendingRes.json() as Array<{
    id: string;
    pick_id: string | null;
    player_name: string;
    prop_type: string;
    line: number;
    pick_side: string;
    odds: number;
    stake: number;
    placed_at: string;
  }>;

  console.log(`[resolve] Found ${pendingBetsRaw.length} pending bets`);

  if (!pendingBetsRaw.length) {
    return 0;
  }

  // D-724: hydrate player_id from the linked pick_history row so the MLB
  // direct-bet matcher can join boxscores by integer id (not name).
  const pendingBets = await hydrateBetsWithPlayerId(pendingBetsRaw);

  let updatedCount = 0;

  for (const bet of pendingBets) {
    const derivedDate = getBetGameDate(bet);
    // D-643 SHIP 1 — removed the `hoursSincePlaced < 6` skip.
    // Old gate skipped any bet placed less than 6h ago, regardless of
    // whether the game itself had finished. That left day-game bets
    // stuck for hours after their games went Final. The correct gate
    // is GAME COMPLETION (status=Final), which all downstream paths
    // already enforce:
    //   - pick_id-direct branch reads pick_history.hit which is only
    //     set after MLB / NBA resolution paths confirm Final.
    //   - The NBA player-prop fall-through filters STATUS_FINAL
    //     before placing the player into boxScoresByDate.
    //   - The new D-643 MLB-direct branch (below) calls
    //     fetchMlbScheduleForDate and filters detailedState=Final/
    //     Game Over/Completed Early.
    // A bet whose game isn't yet Final naturally falls through the
    // resolver as "no match" and stays pending for the next tick.
    console.log(`\n[resolve] Bet: "${bet.player_name}" ${bet.prop_type} ${bet.pick_side} ${bet.line}`);
    console.log(`[resolve]   placed_at=${bet.placed_at}, derivedDate=${derivedDate}, pick_id=${bet.pick_id ?? '<null>'}`);

    // D-504 pick_id-direct branch: if the bet has a pick_id linkage (auto-
    // populated by the resolve_bet_pick_id BEFORE INSERT trigger from D-021),
    // use the linked pick_history row's hit/voided as the source of truth.
    // This handles 100% of bets that come through the natural-key match
    // (including game-level bets with spread/total prop_types — IF their
    // pick_id linked to a resolved pick). Bets where pick_id is NULL fall
    // through to the player-prop matching path below.
    if (bet.pick_id) {
      try {
        const phRes = await fetch(
          `${SUPABASE_URL}/rest/v1/pick_history?id=eq.${bet.pick_id}&select=hit,actual_value,voided,resolved_at&limit=1`,
          { headers: supabaseHeaders },
        );
        if (phRes.ok) {
          const phRows = await phRes.json() as Array<{ hit: boolean | null; actual_value: number | null; voided: boolean | null; resolved_at: string | null }>;
          const pick = phRows[0];
          if (pick) {
            if (pick.voided === true) {
              console.log(`[resolve]   linked pick is voided → marking bet void`);
              if (_dryRun) {
                _dryRunCounts.bets_updates++;
                updatedCount++;
                continue;
              }
              const voidUpdateUrl = `${SUPABASE_URL}/rest/v1/bets?id=eq.${bet.id}`;
              const voidRes = await fetch(voidUpdateUrl, {
                method: "PATCH",
                headers: { ...supabaseHeaders, "Prefer": "return=minimal" },
                body: JSON.stringify({
                  status: "void",
                  payout: 0,
                  settled_at: new Date().toISOString(),
                }),
              });
              if (voidRes.ok) {
                updatedCount++;
                console.log(`[resolve]   ✓ voided bet ${bet.id}`);
              } else {
                console.log(`[resolve]   ✗ failed to void bet ${bet.id}: ${voidRes.status}`);
              }
              continue;
            }
            if (pick.hit !== null && pick.hit !== undefined) {
              // Pick was resolved with an outcome — settle the bet from it
              const directHit = pick.hit === true;
              let directPayout: number;
              if (directHit) {
                directPayout = bet.odds > 0
                  ? bet.stake * (bet.odds / 100)
                  : bet.stake * (100 / Math.abs(bet.odds));
              } else {
                directPayout = -bet.stake;
              }
              directPayout = Math.round(directPayout * 100) / 100;
              const directStatus = directHit ? "won" : "lost";
              console.log(`[resolve]   pick_id-direct: hit=${directHit}, payout=${directPayout}`);
              if (_dryRun) {
                _dryRunCounts.bets_updates++;
                updatedCount++;
                continue;
              }
              const directUpdateUrl = `${SUPABASE_URL}/rest/v1/bets?id=eq.${bet.id}`;
              const directRes = await fetch(directUpdateUrl, {
                method: "PATCH",
                headers: { ...supabaseHeaders, "Prefer": "return=minimal" },
                body: JSON.stringify({
                  status: directStatus,
                  result_value: pick.actual_value ?? null,
                  payout: directPayout,
                  settled_at: new Date().toISOString(),
                }),
              });
              if (directRes.ok) {
                updatedCount++;
                console.log(`[resolve]   ✓ settled bet ${bet.id} via pick_id`);
              } else {
                console.log(`[resolve]   ✗ failed to settle: ${directRes.status}`);
              }
              continue;
            }
            // Pick exists but hit not yet determined — wait for the picks
            // pass to fill it in. Skip the player-prop path so we don't
            // double-resolve via two routes with potentially-different data.
            console.log(`[resolve]   pick_id linked but pick.hit not yet set; skipping until next run`);
            continue;
          }
          console.log(`[resolve]   pick_id=${bet.pick_id} has no pick_history row (orphan); falling through to player-prop path`);
        } else {
          console.log(`[resolve]   pick_id lookup HTTP ${phRes.status}; falling through to player-prop path`);
        }
      } catch (e) {
        console.log(`[resolve]   pick_id lookup error: ${e}; falling through to player-prop path`);
      }
    }

    // D-643 SHIP 2 + 3 — MLB-direct path for bets where pick_id is NULL
    // OR the pick_history linkage didn't resolve. Covers two D-641 gaps:
    //   (2) NULL pick_id MLB player-prop bets — direct boxscore lookup
    //       by player + market via fetchMlbScheduleForDate +
    //       fetchMlbBoxscore + pickMlbStat. Same code path the live
    //       MLB pick resolver (resolveMlbPicks) uses, applied to bets.
    //   (3) Game-side matchup-tag bets — player_name like
    //       "Team A vs Team B (side home)" / "(total over)" / "(side away)".
    //       Parsed into (home, away, kind, side); final score from
    //       fetchMlbScheduleForDate; spread / game_total / h2h math.
    //
    // Runs BEFORE the legacy NBA player-prop fall-through so MLB bets
    // never reach that path (which would call findPlayerByDate against
    // empty boxScoresByDate and `continue`, leaving them pending).
    const mlbResolved = await tryResolveMlbBetDirect(bet, derivedDate);
    if (mlbResolved !== null) {
      if (mlbResolved) updatedCount++;
      continue;
    }

    // No pick_id (or pick_id lookup failed): fall through to the original
    // player-prop matching path. This handles legacy bets and any bets where
    // the trigger couldn't find a natural-key match in pick_history.
    const { player: playerStats, matchedDate } = findPlayerByDate(
      bet.player_name,
      derivedDate,
      boxScoresByDate
    );

    if (!playerStats) {
      console.log(`[resolve]   ✗ Player not found on ${derivedDate} or previous day (no pick_id linkage to fall back on)`);
      continue;
    }

    console.log(`[resolve]   ✓ Found "${playerStats.rawName}" on ${matchedDate}`);

    const actualValue = getPlayerStat(playerStats, bet.prop_type);

    if (actualValue === null) {
      console.log(`[resolve]   No ${bet.prop_type} stat found`);
      continue;
    }

    // Determine if bet hit
    let hit: boolean;
    if (bet.pick_side === "over") {
      hit = actualValue > bet.line;
    } else {
      hit = actualValue < bet.line;
    }

    console.log(`[resolve]   actual=${actualValue}, line=${bet.line}, hit=${hit}`);

    // Calculate payout
    let payout: number;
    if (hit) {
      if (bet.odds > 0) {
        payout = bet.stake * (bet.odds / 100);
      } else {
        payout = bet.stake * (100 / Math.abs(bet.odds));
      }
    } else {
      payout = -bet.stake;
    }
    payout = Math.round(payout * 100) / 100;

    const status = hit ? "won" : "lost";

    // Update the bet
    // D-253f: skip the PATCH in dry-run, increment counter, count as "updated".
    if (_dryRun) {
      _dryRunCounts.bets_updates++;
      updatedCount++;
      console.log(`[resolve]   [dry-run] Would update bet ${bet.id}: ${status} (payout: ${payout})`);
      continue;
    }
    const updateUrl = `${SUPABASE_URL}/rest/v1/bets?id=eq.${bet.id}`;
    const updateRes = await fetch(updateUrl, {
      method: "PATCH",
      headers: { ...supabaseHeaders, "Prefer": "return=minimal" },
      body: JSON.stringify({
        status,
        result_value: actualValue,
        payout,
        settled_at: new Date().toISOString(),
      }),
    });

    if (updateRes.ok) {
      console.log(`[resolve]   Updated: ${status} (payout: ${payout})`);
      updatedCount++;
    } else {
      const errText = await updateRes.text();
      console.log(`[resolve]   Failed to update: ${updateRes.status} - ${errText}`);
    }
  }

  console.log(`[resolve] Updated ${updatedCount} bets`);
  return updatedCount;
}

// Debug mode: fetch specific player/date and return raw data
async function debugFetchPlayer(playerName: string, dateStr: string): Promise<object> {

  const games = await fetchScoreboard(dateStr);
  const completedGames = games.filter(g => g.status === "STATUS_FINAL");


  const results: object[] = [];
  const normalizedSearch = normalizeName(playerName);

  for (const game of completedGames) {
    const boxScore = await fetchBoxScore(game.id, game.homeTeam, game.awayTeam);

    for (const [name, stats] of boxScore) {
      if (name.includes(normalizedSearch) || playerNamesMatch(normalizedSearch, name)) {
        results.push({
          game: `${game.awayTeam} @ ${game.homeTeam}`,
          gameId: game.id,
          player: stats.rawName,
          team: stats.team,
          rawLabels: stats.rawLabels,
          rawValues: stats.rawValues,
          parsedStats: stats.stats,
        });
      }
    }
  }

  return {
    searchedFor: playerName,
    normalizedName: normalizedSearch,
    date: dateStr,
    gamesChecked: completedGames.length,
    matchesFound: results.length,
    matches: results,
  };
}

// ============================================================
// D-275-RESOLVE (2026-05-20) — MLB-specific resolution path.
// ============================================================
//
// Pre-D-275: resolve-picks pipeline pulled all unresolved picks but
// fetched box-scores from ESPN basketball/nba — MLB games never
// matched, picks stayed hit=NULL forever. 3,351 unresolved MLB
// rows accumulated.
//
// This helper handles MLB picks via MLB Stats API instead:
//   1. Schedule lookup: /api/v1/schedule?sportId=1&date=YYYY-MM-DD
//      → list of gamePk + statusCode
//   2. Boxscore lookup: /api/v1/game/{gamePk}/boxscore
//      → batter/pitcher stats per team
//   3. Match pick.player_name to boxscore player, extract stat,
//      compute hit per side + line.
//
// Markets handled (mlb_market_type):
//   - pitcher_k    → pitcher strikeOuts
//   - batter_hits  → batter hits
//   - batter_hr    → batter homeRuns
//   - batter_total_bases → batter totalBases
//   - batter_rbis  → batter rbi
//   - game_side    → spread side (margin + line vs 0)
//   - game_total   → total runs vs line
//
// Push semantics (per D-247): exact tie at line → hit=null,
// voided=false, resolved_at SET.

const MLB_STATS_BASE_RP = "https://statsapi.mlb.com/api/v1";

interface MlbScheduleGame {
  gamePk: number;
  status: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
}

async function fetchMlbScheduleForDate(date: string): Promise<MlbScheduleGame[]> {
  const url = `${MLB_STATS_BASE_RP}/schedule?sportId=1&date=${date}&hydrate=linescore`;
  const r = await quietFetch(url, 12000);
  if (!r.ok) { console.log(`[mlb-resolve] schedule fetch fail ${date}: HTTP ${r.status}`); return []; }
  try {
    const j = JSON.parse(r.text);
    const games: MlbScheduleGame[] = [];
    for (const date of (j.dates ?? [])) {
      for (const g of (date.games ?? [])) {
        const homeT = g?.teams?.home?.team?.name ?? "";
        const awayT = g?.teams?.away?.team?.name ?? "";
        const status = g?.status?.detailedState ?? "";
        const homeScore = g?.teams?.home?.score ?? null;
        const awayScore = g?.teams?.away?.score ?? null;
        games.push({
          gamePk: g.gamePk,
          status,
          homeTeam: homeT,
          awayTeam: awayT,
          homeScore: homeScore ?? 0,
          awayScore: awayScore ?? 0,
        });
      }
    }
    return games;
  } catch (e) {
    console.log(`[mlb-resolve] schedule parse fail: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

interface MlbPlayerStat {
  // D-721: durable integer key from MLB Stats API (boxscore.teams.{side}.players.{key}.person.id).
  // Enables direct integer-key match against pick_history.player_id (99.42% coverage after D-720).
  playerId?: number;
  fullName: string;
  hits?: number;
  homeRuns?: number;
  totalBases?: number;
  rbi?: number;
  strikeOuts?: number; // pitcher's strikeOuts when in pitching node
  atBats?: number;
  // D-625 — added for the 3 markets D-606 found unhandled.
  runs?: number;             // batter's runs scored (stats.batting.runs)
  outs?: number;             // pitcher's outs recorded (stats.pitching.outs)
  batterStrikeOuts?: number; // batter's strikeouts (stats.batting.strikeOuts) — distinct from pitcher's
}

async function fetchMlbBoxscore(gamePk: number): Promise<MlbPlayerStat[]> {
  const url = `${MLB_STATS_BASE_RP}/game/${gamePk}/boxscore`;
  const r = await quietFetch(url, 12000);
  if (!r.ok) return [];
  try {
    const j = JSON.parse(r.text);
    const out: MlbPlayerStat[] = [];
    for (const side of ["home", "away"]) {
      const players = j?.teams?.[side]?.players ?? {};
      for (const k of Object.keys(players)) {
        const p = players[k];
        const fullName = p?.person?.fullName ?? "";
        const bat = p?.stats?.batting ?? {};
        const pit = p?.stats?.pitching ?? {};
        out.push({
          playerId: p?.person?.id, // D-721
          fullName,
          hits: bat.hits,
          homeRuns: bat.homeRuns,
          totalBases: bat.totalBases,
          rbi: bat.rbi,
          atBats: bat.atBats,
          strikeOuts: pit.strikeOuts, // pitching node
          // D-625 — fields needed for batter_runs_scored / pitcher_outs / batter_strikeouts.
          runs: bat.runs,
          outs: pit.outs,
          batterStrikeOuts: bat.strikeOuts,
        });
      }
    }
    return out;
  } catch (_e) { return []; }
}

function pickMlbStat(pick: { mlb_market_type?: string; prop_type?: string }, stats: MlbPlayerStat): number | null {
  const market = (pick.mlb_market_type || "").toLowerCase();
  const prop = (pick.prop_type || "").toLowerCase();
  // pitcher_k handled via market name (mlb_market_type more reliable than prop_type)
  if (market === "pitcher_k" || prop === "pitcher_strikeouts" || prop === "strikeouts") {
    return stats.strikeOuts ?? null;
  }
  if (market === "batter_hits" || prop === "hits")             return stats.hits ?? null;
  if (market === "batter_hr"   || prop === "home_runs")        return stats.homeRuns ?? null;
  if (market === "batter_total_bases" || prop === "total_bases") return stats.totalBases ?? null;
  if (market === "batter_rbis" || prop === "rbis")             return stats.rbi ?? null;
  // D-625 — D-606 found these three markets dispatched to null → 2,505 picks
  // structurally unresolvable. Box-score field names verified against the
  // MLB Stats API /game/{gamePk}/boxscore shape: stats.batting.runs,
  // stats.pitching.outs, stats.batting.strikeOuts.
  if (market === "batter_runs_scored" || prop === "runs_scored")  return stats.runs ?? null;
  if (market === "pitcher_outs"       || prop === "pitcher_outs") return stats.outs ?? null;
  if (market === "batter_strikeouts"  || prop === "batter_strikeouts") return stats.batterStrikeOuts ?? null;
  return null;
}

// D-643 SHIP 2 + 3 — direct MLB resolver for bets (no pick_history linkage).
// Returns:
//   true   — bet was resolved and PATCHed (won/lost/void/push)
//   false  — bet was attempted but a downstream write failed
//   null   — bet did not match MLB shape; caller should try NBA fall-through
//
// Side-effects: PATCHes `bets` directly. Honors _dryRun (no writes;
// increments _dryRunCounts.bets_updates). Logs each branch loudly so a
// future operator can trace why a bet did or did not resolve.
//
// Date discovery: tries (derivedDate, derivedDate-1, derivedDate-2,
// derivedDate+1) so late-evening UTC bets don't miss a game whose ET
// date is one day off. Same pattern D-641's drain script used.

// Match strings like "Tampa Bay Rays vs Boston Red Sox (side away)".
const D643_MATCHUP_TAG_RE = /^(.+?)\s+vs\s+(.+?)\s+\((side|total)\s+(home|away|over|under)\)$/i;

interface ParsedMatchupTag {
  home: string;
  away: string;
  kind: "side" | "total";
  side: "home" | "away" | "over" | "under";
}

function parseMatchupTag(playerName: string): ParsedMatchupTag | null {
  try {
    const m = D643_MATCHUP_TAG_RE.exec(playerName.trim());
    if (!m) return null;
    return {
      home: m[1].trim(),
      away: m[2].trim(),
      kind: m[3].toLowerCase() as "side" | "total",
      side: m[4].toLowerCase() as "home" | "away" | "over" | "under",
    };
  } catch (_e) {
    // ESCALATION #3 — odd matchup format: log + skip, don't crash.
    console.log(`[d643] matchup-tag parse error for "${playerName}": ${_e}`);
    return null;
  }
}

const D643_MLB_PROP_TYPES = new Set([
  "hits", "home_runs", "rbis", "total_bases",
  "runs_scored", "pitcher_strikeouts", "strikeouts",
  "pitcher_outs", "batter_strikeouts",
  "spread", "spreads", "game_total", "totals", "h2h",
]);

function d643CandidateDates(placedAtIso: string): string[] {
  const ms = Date.parse(placedAtIso);
  if (!Number.isFinite(ms)) return [];
  const out: string[] = [];
  for (const delta of [0, -1, -2, 1]) {
    const d = new Date(ms + delta * 86400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function d643NormTeam(name: string): string {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function d643FindGameByTeams(games: MlbScheduleGame[], home: string, away: string): MlbScheduleGame | null {
  const h = d643NormTeam(home);
  const a = d643NormTeam(away);
  for (const g of games) {
    const gh = d643NormTeam(g.homeTeam);
    const ga = d643NormTeam(g.awayTeam);
    if ((gh === h && ga === a) || (gh === a && ga === h)) return g;
  }
  // Looser substring fallback (e.g., "Athletics" vs "Oakland Athletics").
  for (const g of games) {
    const gh = d643NormTeam(g.homeTeam);
    const ga = d643NormTeam(g.awayTeam);
    if ((gh.includes(h) || h.includes(gh)) && (ga.includes(a) || a.includes(ga))) return g;
    if ((gh.includes(a) || a.includes(gh)) && (ga.includes(h) || h.includes(ga))) return g;
  }
  return null;
}

function d643PayoutFor(stake: number, odds: number, hit: boolean): number {
  if (!hit) return -Math.abs(stake);
  const raw = odds > 0 ? stake * (odds / 100) : stake * (100 / Math.abs(odds));
  return Math.round(raw * 100) / 100;
}

async function d643PatchBet(betId: string, fields: Record<string, unknown>): Promise<boolean> {
  if (_dryRun) { _dryRunCounts.bets_updates++; return true; }
  const url = `${SUPABASE_URL}/rest/v1/bets?id=eq.${betId}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { ...supabaseHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ ...fields, settled_at: new Date().toISOString() }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.log(`[d643] PATCH bet ${betId} failed: ${r.status} ${t.slice(0, 200)}`);
    return false;
  }
  return true;
}

// D-724: hydrate the player_id field on each bet by looking up the linked
// pick_history row via the bet's pick_id (a soft reference, no DB FK).
// This enables tryResolveMlbBetDirect to match boxscores by integer id instead
// of player_name (the silent-skip surface from D-715/716). Bets with no pick_id
// or whose linked pick has a NULL player_id (intrinsic ambiguity) get null —
// they fall back to mlbNameMatch.
async function hydrateBetsWithPlayerId<T extends { id: string; pick_id: string | null }>(
  bets: T[],
): Promise<Array<T & { player_id: number | null }>> {
  const pickIds = Array.from(new Set(bets.map((b) => b.pick_id).filter((x): x is string => !!x)));
  const pidByPickId = new Map<string, number | null>();
  if (pickIds.length > 0) {
    // Chunk to keep URL length sane (UUIDs are 36 chars each).
    for (let i = 0; i < pickIds.length; i += 50) {
      const chunk = pickIds.slice(i, i + 50);
      const url = `${SUPABASE_URL}/rest/v1/pick_history?id=in.(${chunk.join(",")})&select=id,player_id`;
      try {
        const r = await fetch(url, { headers: supabaseHeaders });
        if (!r.ok) {
          console.log(`[d724] pick_history hydrate fetch failed status=${r.status}`);
          continue;
        }
        const rows = await r.json() as Array<{ id: string; player_id: number | null }>;
        for (const row of rows) pidByPickId.set(row.id, row.player_id);
      } catch (e) {
        console.log(`[d724] pick_history hydrate fetch error: ${e}`);
      }
    }
  }
  return bets.map((b) => ({
    ...b,
    player_id: b.pick_id ? (pidByPickId.get(b.pick_id) ?? null) : null,
  }));
}

async function tryResolveMlbBetDirect(
  bet: {
    id: string;
    player_name: string;
    // D-724: hydrated from pick_history.player_id via the bet's pick_id linkage.
    // null when bet has no pick_id, has an orphan pick_id, or the linked pick row
    // is one of the 0.58% intrinsic NULL-pid residuals (e.g., Max Muncy).
    player_id?: number | null;
    prop_type: string;
    line: number;
    pick_side: string;
    odds: number;
    stake: number;
    placed_at: string;
  },
  derivedDate: string,
): Promise<boolean | null> {
  const pt = (bet.prop_type || "").toLowerCase();
  const tag = parseMatchupTag(bet.player_name);

  // Only handle bets that look MLB: either an MLB prop_type or a matchup tag.
  if (!tag && !D643_MLB_PROP_TYPES.has(pt)) return null;

  // Derived date is YYYYMMDD; the schedule API wants YYYY-MM-DD.
  const derivedIso = derivedDate.length === 8
    ? `${derivedDate.slice(0,4)}-${derivedDate.slice(4,6)}-${derivedDate.slice(6,8)}`
    : derivedDate;
  const dates = [derivedIso, ...d643CandidateDates(bet.placed_at)];
  const seen = new Set<string>();
  const uniqDates = dates.filter((d) => { if (seen.has(d)) return false; seen.add(d); return true; });

  for (const date of uniqDates) {
    let games: MlbScheduleGame[];
    try {
      games = await fetchMlbScheduleForDate(date);
    } catch (_e) {
      console.log(`[d643] schedule fetch threw for ${date}: ${_e}`);
      continue;
    }
    if (!games.length) continue;

    // ── SHIP 3: matchup-tag → game-side resolver ──
    if (tag) {
      const g = d643FindGameByTeams(games, tag.home, tag.away);
      if (!g) continue;
      const finalStates = new Set(["Final", "Game Over", "Completed Early"]);
      const isFinal = finalStates.has(g.status);
      if (!isFinal) {
        // Game found but not Final yet (or postponed/etc). Postponed/
        // Cancelled/Suspended → void; otherwise leave pending.
        if (["Postponed", "Cancelled", "Suspended"].includes(g.status)) {
          console.log(`[d643] matchup ${tag.home} vs ${tag.away} on ${date}: status=${g.status} → void`);
          const ok = await d643PatchBet(bet.id, { status: "void", payout: 0 });
          return ok;
        }
        return null; // game not done — leave pending
      }
      const hs = g.homeScore;
      const as = g.awayScore;
      if (pt === "spread" || pt === "spreads") {
        const margin = tag.side === "home" ? hs - as : as - hs;
        const target = margin + bet.line;
        if (target === 0) {
          console.log(`[d643] spread push ${tag.home}/${tag.away} margin=${margin} line=${bet.line}`);
          const ok = await d643PatchBet(bet.id, { status: "void", result_value: margin, payout: 0 });
          return ok;
        }
        const hit = target > 0;
        const payout = d643PayoutFor(bet.stake, bet.odds, hit);
        console.log(`[d643] spread ${tag.home}/${tag.away} side=${tag.side} margin=${margin} line=${bet.line} → ${hit ? "won" : "lost"} payout=${payout}`);
        const ok = await d643PatchBet(bet.id, { status: hit ? "won" : "lost", result_value: margin, payout });
        return ok;
      }
      if (pt === "game_total" || pt === "totals") {
        const total = hs + as;
        const flip = bet.pick_side.toLowerCase() === "over" ? 1 : -1;
        const delta = (total - bet.line) * flip;
        if (delta === 0) {
          console.log(`[d643] total push ${tag.home}/${tag.away} total=${total} line=${bet.line}`);
          const ok = await d643PatchBet(bet.id, { status: "void", result_value: total, payout: 0 });
          return ok;
        }
        const hit = delta > 0;
        const payout = d643PayoutFor(bet.stake, bet.odds, hit);
        console.log(`[d643] total ${tag.home}/${tag.away} side=${bet.pick_side} total=${total} line=${bet.line} → ${hit ? "won" : "lost"} payout=${payout}`);
        const ok = await d643PatchBet(bet.id, { status: hit ? "won" : "lost", result_value: total, payout });
        return ok;
      }
      if (pt === "h2h") {
        const pickWon = (tag.side === "home" && hs > as) || (tag.side === "away" && as > hs);
        const payout = d643PayoutFor(bet.stake, bet.odds, pickWon);
        console.log(`[d643] h2h ${tag.home}/${tag.away} side=${tag.side} hs=${hs} as=${as} → ${pickWon ? "won" : "lost"} payout=${payout}`);
        const ok = await d643PatchBet(bet.id, { status: pickWon ? "won" : "lost", result_value: pickWon ? 1 : 0, payout });
        return ok;
      }
      // Matchup tag but unknown game-side prop_type → log + give up.
      console.log(`[d643] matchup tag with unsupported prop_type=${pt} on ${date}; leaving pending`);
      return null;
    }

    // ── SHIP 2: NULL pick_id MLB player prop → boxscore lookup ──
    // D-724: player_id-first matching (mirrors D-721 on the picks path). When the
    // bet was hydrated with player_id from the linked pick_history row, match
    // by integer id first. Fall back to mlbNameMatch for the 0.58% of bets
    // whose pick_id linkage carried a NULL player_id (intrinsic ambiguity like
    // Max Muncy / Jacob Gonzalez), or for bets with no pick_id at all (legacy).
    // After exhausting every Final game on this date without a match, log
    // explicit reason — replaces the prior silent fall-through that left the
    // bet quietly pending forever on a name-normalization drift (D-715/716 class).
    const finalStates = new Set(["Final", "Game Over", "Completed Early"]);
    const finals = games.filter((g) => finalStates.has(g.status));
    if (!finals.length) continue;
    let anyMatchOnDate = false;
    for (const g of finals) {
      let box: MlbPlayerStat[];
      try {
        box = await fetchMlbBoxscore(g.gamePk);
      } catch (e) {
        // D-727: boxscore fetch threw — log so transient API issues are visible
        // (this is the 1,913-pick bug class on the bets path). Bet still won't
        // be marked won/lost from this game; loop continues to the next.
        await logResolverFailure({
          betId: bet.id, failureType: "boxscore_fetch_failed",
          market: bet.prop_type, gamePk: g.gamePk, gameDate: date,
          detail: `bets-path fetchMlbBoxscore threw: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      if (!box.length) {
        // D-727: empty box-score = transient fetch failure (per D-277-FIX semantics).
        // Log without voiding — bet stays pending across multiple candidate dates.
        await logResolverFailure({
          betId: bet.id, failureType: "boxscore_fetch_failed",
          market: bet.prop_type, gamePk: g.gamePk, gameDate: date,
          detail: `bets-path empty boxscore (transient — MLB Stats API returned 0 players for gamePk=${g.gamePk})`,
        });
        continue;
      }
      let match: MlbPlayerStat | undefined;
      let matchPath: "player_id" | "name_fallback" = "name_fallback";
      if (bet.player_id != null) {
        match = box.find((s) => s.playerId === bet.player_id);
        if (match) matchPath = "player_id";
      }
      if (!match) {
        match = box.find((s) => mlbNameMatch(bet.player_name, s.fullName));
        if (match) matchPath = "name_fallback";
      }
      if (!match) continue;
      anyMatchOnDate = true;
      if (matchPath === "name_fallback") {
        console.log(`[d643] [d724] name-fallback hit: bet.id=${bet.id} player_name="${bet.player_name}" bet.player_id=${bet.player_id ?? "null"} matched_box_name="${match.fullName}" matched_box_pid=${match.playerId ?? "null"} game=${g.gamePk}`);
      }
      const actual = pickMlbStat({ prop_type: bet.prop_type }, match);
      if (actual === null || actual === undefined) {
        // Player found but stat not extractable. Could be wrong market —
        // log + leave pending.
        console.log(`[d643] ${bet.player_name} found in box ${g.gamePk} but no ${pt} stat`);
        return null;
      }
      const v = Number(actual);
      const side = bet.pick_side.toLowerCase();
      if (v === Number(bet.line)) {
        console.log(`[d643] player-prop push ${bet.player_name} ${pt} actual=${v} line=${bet.line}`);
        const ok = await d643PatchBet(bet.id, { status: "void", result_value: v, payout: 0 });
        return ok;
      }
      const hit = side === "over" ? v > bet.line : v < bet.line;
      const payout = d643PayoutFor(bet.stake, bet.odds, hit);
      console.log(`[d643] player-prop ${bet.player_name} ${pt} side=${side} actual=${v} line=${bet.line} → ${hit ? "won" : "lost"} payout=${payout}`);
      const ok = await d643PatchBet(bet.id, { status: hit ? "won" : "lost", result_value: v, payout });
      return ok;
    }
    // D-724: LOUD log when ALL Final games on this date were searched and no
    // match found. Replaces the prior silent fall-through. The bet still stays
    // pending (we don't void on miss — could be wrong date and the next candidate
    // date might match), but the reason is now explicit and auditable.
    if (!anyMatchOnDate) {
      const reason = bet.player_id == null
        ? `player_id IS NULL AND name fallback failed across all ${finals.length} Final game(s) on ${date}`
        : `player_id=${bet.player_id} not in any boxscore AND name fallback also failed across all ${finals.length} Final game(s) on ${date}`;
      console.log(`[d643] [d724] NO-MATCH-ON-DATE bet.id=${bet.id} player_name="${bet.player_name}" player_id=${bet.player_id ?? "null"} date=${date} reason="${reason}"`);
    }
    // No Final game contained this player on this date — try next date.
  }

  // Ran every candidate date; player never found, or no game was Final.
  // Return null so the caller can try the NBA fall-through (which will
  // also fail for an MLB bet, but the existing code handles that path
  // already and the bet stays pending until next tick).
  return null;
}

function mlbNameMatch(pickName: string, statsName: string): boolean {
  const a = normalizeName(pickName);
  const b = normalizeName(statsName);
  if (!a || !b) return false;
  if (a === b) return true;
  const lastA = a.split(" ").pop() ?? "";
  const lastB = b.split(" ").pop() ?? "";
  if (lastA && lastA === lastB) {
    const firstA = a.split(" ")[0] ?? "";
    const firstB = b.split(" ")[0] ?? "";
    if (firstA && firstB && (firstA[0] === firstB[0])) return true;
  }
  return false;
}

async function resolveMlbPicks(picks: Array<{ id: string; player_name: string; player_id?: number | null; team?: string; prop_type: string; line: number; pick_side: string; game_time: string; created_at: string; mlb_market_type?: string; game_date?: string; opponent?: string; is_home?: boolean }>): Promise<{ resolved: number; unresolvable: number; skipped: number }> {
  // Group by game_date for batched schedule lookup
  const byDate = new Map<string, typeof picks>();
  for (const p of picks) {
    const gd = (p.game_date || getPickGameDate({ game_time: p.game_time, created_at: p.created_at })).replace(/-/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
    if (!byDate.has(gd)) byDate.set(gd, []);
    byDate.get(gd)!.push(p);
  }

  let resolved = 0, unresolvable = 0, skipped = 0;

  for (const [date, datePicks] of byDate) {
    // Skip if date is today or future (game not yet played)
    const easternToday = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
    if (date >= easternToday) { skipped += datePicks.length; continue; }

    const games = await fetchMlbScheduleForDate(date);
    const finalGames = games.filter((g) => g.status === "Final" || g.status === "Game Over" || g.status === "Completed Early");
    if (finalGames.length === 0) {
      console.log(`[mlb-resolve] no final games for ${date}; skipping ${datePicks.length} picks`);
      skipped += datePicks.length;
      continue;
    }

    // D-730: PREFER the persisted game_outcomes table for game-market resolution.
    // Single-source-of-truth lookup keyed on game_pk; falls back to the live
    // schedule (matchedGame below) when the table hasn't been populated yet for
    // the date (e.g., right after a game finishes, before the next backfill tick).
    // Best-effort fetch — fail-open: if the table miss or REST errors, the existing
    // schedule path still resolves correctly.
    const outcomesByPk = new Map<number, { home_score: number | null; away_score: number | null; total_runs: number | null; winner: string | null }>();
    try {
      const gamePks = finalGames.map((g) => g.gamePk).join(",");
      const url = `${SUPABASE_URL}/rest/v1/game_outcomes?game_pk=in.(${gamePks})&select=game_pk,home_score,away_score,total_runs,winner&status=eq.final`;
      const r = await fetch(url, { headers: supabaseHeaders });
      if (r.ok) {
        const rows = await r.json() as Array<{ game_pk: number; home_score: number | null; away_score: number | null; total_runs: number | null; winner: string | null }>;
        for (const row of rows) outcomesByPk.set(row.game_pk, row);
      }
    } catch (_e) { /* fail-open: schedule path still works */ }

    // Boxscore lookup keyed by gamePk
    // D-277-FIX (2026-05-20): track failed-fetch state so we can SKIP
    // (not VOID) when MLB Stats API has a transient hiccup. Pre-fix:
    // if fetchMlbBoxscore returned [] (HTTP fail / transient API
    // outage), the player iteration found no match and voided. This
    // is exactly what happened at 05:30 UTC nightly cron — voiding
    // ~2,406 player-market picks that should have resolved. The
    // boxscore_fetch_failures counter lets us route player picks to
    // "skip" (retry next cron tick) instead of "void" when the
    // upstream API was unreachable.
    const boxByPk = new Map<number, MlbPlayerStat[]>();
    let boxscore_fetch_failures = 0;
    for (const g of finalGames) {
      const bs = await fetchMlbBoxscore(g.gamePk);
      if (bs.length === 0) boxscore_fetch_failures++;
      boxByPk.set(g.gamePk, bs);
    }
    const all_boxscores_failed = boxscore_fetch_failures === finalGames.length && finalGames.length > 0;
    const most_boxscores_failed = boxscore_fetch_failures >= Math.ceil(finalGames.length / 2) && finalGames.length > 0;
    if (all_boxscores_failed || most_boxscores_failed) {
      console.log(`[mlb-resolve] boxscore-fetch-resilience: ${boxscore_fetch_failures}/${finalGames.length} games failed boxscore fetch for ${date}; SKIPPING player-market picks (will retry next cron tick) instead of voiding`);
    }

    for (const pick of datePicks) {
      const isGameMarket = pick.mlb_market_type === "game_side" || pick.mlb_market_type === "game_total" ||
                           pick.prop_type === "spreads" || pick.prop_type === "totals" || pick.prop_type === "h2h";
      if (isGameMarket) {
        // Match game by team name (pick.team / pick.opponent)
        const pickTeam = (pick.team || "").toLowerCase();
        const pickOpp = (pick.opponent || "").toLowerCase();
        const matchedGame = finalGames.find((g) => {
          const h = g.homeTeam.toLowerCase(), a = g.awayTeam.toLowerCase();
          return (h === pickTeam || a === pickTeam) && (h === pickOpp || a === pickOpp);
        });
        if (!matchedGame) {
          console.log(`[mlb-resolve] game-market no match: ${pick.team} vs ${pick.opponent} on ${date}`);
          await voidPick(pick.id, "game_market_no_match", `team="${pick.team}" opponent="${pick.opponent}"`,
            { market: pick.mlb_market_type ?? pick.prop_type, gameDate: date });
          unresolvable++; continue;
        }
        // D-730: prefer the persisted game_outcomes row keyed on game_pk;
        // fall back to the live schedule (matchedGame) on table miss. Scores
        // are bit-identical when both sources have data (sourced from same API);
        // the table makes the canonical source explicit and lets future consumers
        // skip the live re-fetch.
        const goRow = outcomesByPk.get(matchedGame.gamePk);
        const useTable = goRow != null && goRow.home_score != null && goRow.away_score != null;
        const homeScore = useTable ? (goRow.home_score as number) : matchedGame.homeScore;
        const awayScore = useTable ? (goRow.away_score as number) : matchedGame.awayScore;
        if (useTable) {
          console.log(`[mlb-resolve] [d730] game_outcomes hit gamePk=${matchedGame.gamePk} home=${homeScore} away=${awayScore}`);
        }
        // Determine pick side outcome
        if (pick.mlb_market_type === "game_total" || pick.prop_type === "totals") {
          const total = (useTable && goRow!.total_runs != null) ? goRow!.total_runs : (homeScore + awayScore);
          let hit: boolean | null;
          if (Math.abs(total - pick.line) < 0.0001) hit = null;
          else if (pick.pick_side === "over")  hit = total > pick.line;
          else                                 hit = total < pick.line;
          await updatePickResult(pick.id, total, hit); resolved++;
        } else {
          // Spread / h2h
          const pickedTeamIsHome = (pick.team || "").toLowerCase() === matchedGame.homeTeam.toLowerCase();
          const margin = pickedTeamIsHome
            ? homeScore - awayScore
            : awayScore - homeScore;
          let hit: boolean | null;
          if (pick.prop_type === "h2h" || pick.mlb_market_type === "game_side" && pick.line === 0) {
            // Moneyline: hit = picked team won
            if (margin === 0) hit = null;
            else hit = margin > 0;
            await updatePickResult(pick.id, margin, hit); resolved++;
          } else {
            // Run line spread
            const adj = margin + pick.line;
            if (Math.abs(adj) < 0.0001) hit = null;
            else hit = adj > 0;
            await updatePickResult(pick.id, margin, hit); resolved++;
          }
        }
        continue;
      }
      // Player market — match player across all boxscores
      // D-277-FIX: if most boxscore fetches failed, SKIP this pick
      // (retry next cron tick) instead of voiding. Prevents the
      // 05:30 UTC mass-void incident from recurring.
      // D-727: log the skip — the 1,913-pick weekend incident was invisible
      // because nobody could see the API was down. resolver_failure_log makes
      // boxscore_fetch_failed cohort-able by date for incident reconstruction.
      if (most_boxscores_failed) {
        await logResolverFailure({
          pickId: pick.id, failureType: "boxscore_fetch_failed",
          market: pick.mlb_market_type ?? pick.prop_type, gameDate: date,
          detail: `picks-path boxscore-fetch-resilience: ${boxscore_fetch_failures}/${finalGames.length} games failed; skipping (will retry next cron tick — NOT voided)`,
        });
        skipped++; continue;
      }
      // D-721: player_id-first matching against MLB Stats API boxscore.
      // Direct integer compare for 99.42% of player-prop picks (D-720 keystone).
      // Falls back to name match for the 0.58% (intrinsically-ambiguous Max Muncy /
      // Jose Fermin / Jacob Gonzalez etc., where the keystone left player_id NULL on
      // purpose), and for any pick whose box-score row happens to lack person.id
      // (defensive — MLB API has always carried it, but the fallback prevents
      // a future API hiccup from causing a silent mass-void).
      let matched: MlbPlayerStat | null = null;
      let matchPath: "player_id" | "name_fallback" | "none" = "none";

      if (pick.player_id != null) {
        for (const bs of boxByPk.values()) {
          for (const s of bs) {
            if (s.playerId === pick.player_id) { matched = s; matchPath = "player_id"; break; }
          }
          if (matched) break;
        }
      }
      if (!matched) {
        for (const bs of boxByPk.values()) {
          for (const s of bs) {
            if (mlbNameMatch(pick.player_name, s.fullName)) { matched = s; matchPath = "name_fallback"; break; }
          }
          if (matched) break;
        }
      }
      if (!matched) {
        // D-721: LOUD failure log — never silent. Explicit about which paths tried
        // and why the void is happening. Replaces the prior one-line generic log
        // that surfaced the D-715/716 silent-void bug class.
        // D-727: classify reason so resolver_failure_log can cohort name_no_match vs
        // player_id_no_match — operators auditing a slate can tell at a glance whether
        // metadata is stale (name) or the box-score side lacks pid (id).
        const failureType: ResolverFailureType =
          pick.player_id == null ? "name_no_match" : "player_id_no_match";
        const reason = pick.player_id == null
          ? `player_id IS NULL (intrinsic ambiguity or unbackfilled) AND name fallback failed`
          : `player_id=${pick.player_id} not in any boxscore AND name fallback also failed`;
        console.log(`[mlb-resolve] [d721] VOID pick.id=${pick.id} player_name="${pick.player_name}" player_id=${pick.player_id ?? "null"} date=${date} reason="${reason}"`);
        await voidPick(pick.id, failureType, `player_name="${pick.player_name}" player_id=${pick.player_id ?? "null"} | ${reason}`,
          { market: pick.mlb_market_type ?? pick.prop_type, gameDate: date });
        unresolvable++; continue;
      }
      if (matchPath === "name_fallback") {
        // D-721: log fallback usage so we can audit how often the name path actually fires.
        console.log(`[mlb-resolve] [d721] name-fallback hit: pick.id=${pick.id} player_name="${pick.player_name}" pick.player_id=${pick.player_id ?? "null"} matched_box_name="${matched.fullName}" matched_box_pid=${matched.playerId ?? "null"}`);
      }
      const actualVal = pickMlbStat(pick, matched);
      if (actualVal === null) {
        console.log(`[mlb-resolve] stat null for ${pick.player_name} market=${pick.mlb_market_type} prop=${pick.prop_type}; voiding`);
        // D-727: classify as DNP — player matched in boxscore but the stat field is null.
        // This is a genuine "didn't play / didn't bat / didn't pitch" outcome,
        // distinct from a fetch failure. The pick correctly voids; resolver_failure_log
        // captures the WHY for audit cohorting.
        await voidPick(pick.id, "dnp", `player_name="${pick.player_name}" market=${pick.mlb_market_type ?? pick.prop_type} stat field null`,
          { market: pick.mlb_market_type ?? pick.prop_type, gameDate: date });
        unresolvable++; continue;
      }
      let hit: boolean | null;
      if (Math.abs(actualVal - pick.line) < 0.0001) hit = null;
      else if (pick.pick_side === "over")           hit = actualVal > pick.line;
      else                                          hit = actualVal < pick.line;
      await updatePickResult(pick.id, actualVal, hit); resolved++;
    }
  }
  return { resolved, unresolvable, skipped };
}

// Main handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // D-253f: reset module-scope dry-run state at the top of every request.
  _dryRun = false;
  _resetDryRunCounts();
  const _entryStart = Date.now();

  try {
    let body: { debug?: boolean; player?: string; date?: string; reset?: boolean; dry_run?: boolean; diagnose_picks_query?: boolean } = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch {
      // No body or invalid JSON, proceed normally
    }

    // D-253f: caller-controlled dry-run gate. When true: run all reads,
    // ESPN box-score fetches, and resolution computation as normal but
    // skip ALL writes (updatePickResult / voidPick / bets PATCH). D-247
    // push-semantics + resolved_at filter remain intact — the gate is
    // ABOVE the writer helpers, not inside the resolution logic.
    if (body.dry_run === true) _dryRun = true;

    if (body.debug && body.player && body.date) {
      console.log(`[DEBUG MODE] Player: ${body.player}, Date: ${body.date}`);
      const debugResult = await debugFetchPlayer(body.player, body.date);
      return jsonResponse(debugResult);
    }

    // D-506 SHIP 1 — read-only diagnostic mode. Reproduces the picks-fetch
    // exactly as the main path does (same URL pattern, same headers) and
    // returns the HTTP/parse metadata without performing any resolution.
    // Used once to identify the silent-exit mechanism; safe to leave in
    // (gated behind the diagnose_picks_query body flag).
    if (body.diagnose_picks_query === true) {
      const _cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const _diagUrl = `${SUPABASE_URL}/rest/v1/pick_history?hit=is.null&resolved_at=is.null&voided=neq.true&game_date=gte.${_cutoff}&select=id,player_name,team,prop_type,line,pick_side,game_time,created_at,sport,opponent,mlb_market_type,game_date,is_home&order=game_date.desc,created_at.desc&limit=200`;
      let _status = 0, _ctype = "", _blen = 0, _bhead = "", _parsedCount = -1, _fetchErr = "";
      try {
        const _r = await fetch(_diagUrl, { headers: supabaseHeaders });
        _status = _r.status;
        _ctype = _r.headers.get("content-type") || "";
        const _t = await _r.text();
        _blen = _t.length;
        _bhead = _t.slice(0, 500);
        try {
          const _p = JSON.parse(_t);
          _parsedCount = Array.isArray(_p) ? _p.length : -2;
        } catch (e) {
          _parsedCount = -3;
        }
      } catch (e) {
        _fetchErr = e instanceof Error ? e.message : String(e);
      }
      return jsonResponse({
        diagnose: true,
        supabase_url_set: SUPABASE_URL.length > 0,
        supabase_url_host: SUPABASE_URL.replace(/^https?:\/\//, "").split("/")[0],
        service_key_len: SUPABASE_KEY.length,
        cutoff_date: _cutoff,
        picks_url: _diagUrl,
        http_status: _status,
        content_type: _ctype,
        body_length: _blen,
        body_head: _bhead,
        parsed_count: _parsedCount,
        fetch_error: _fetchErr,
      });
    }

    if (body.reset) {
      // D-253f: refuse the destructive reset path in dry-run. The reset
      // path is RESET_TOKEN-gated already; the dry-run flag is just an
      // additional safety so callers can't accidentally combine the two.
      if (_dryRun) {
        return jsonResponse({ dry_run: true, error: "reset not supported in dry-run mode" }, 400);
      }
      // D-053 — gate destructive resetBadData() behind RESET_TOKEN env var.
      // Without this, anyone with the function URL could POST {"reset":true}
      // and wipe all settled bets + reset NULL-actual_value picks.
      const resetToken = req.headers.get("x-reset-token") ?? "";
      const expected = Deno.env.get("RESET_TOKEN") ?? "";
      if (!expected || resetToken !== expected) {
        console.log(`[RESET MODE] Unauthorized reset attempt`);
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      console.log(`[RESET MODE] Resetting bad data...`);
      const resetResult = await resetBadData();
      return jsonResponse({ success: true, message: "Reset complete", ...resetResult });
    }

    console.log("\n=== RESOLVE PICKS ===");
    const startTime = Date.now();

    // Step 1: Fetch batch of oldest unresolved picks (limit=500)
    // D-275-RESOLVE (2026-05-20): include `sport` column. Pre-fix the
    // SELECT didn't pull sport, so the entire downstream pipeline
    // (fetchBoxScoresForDates → fetchScoreboard → ESPN basketball/nba
    // hardcoded URL) silently failed for MLB rows — function found
    // no NBA game matching the MLB game_id, marked as unresolvable,
    // never wrote hit/resolved_at. D-274 audit surfaced 3,351 MLB
    // picks with hit IS NULL. The fix: route MLB picks through
    // resolveMlbPicks() helper using MLB Stats API; NBA path
    // unchanged.
    //
    // D-294E (2026-05-23) EMERGENCY: accept body params
    //   `limit` (default 500, capped 1000) and `sport` (optional 'mlb'/'nba')
    //   so manual drain can use smaller batches (avoid CPU
    //   WORKER_RESOURCE_LIMIT seen at 500 mixed-sport batches) AND
    //   prioritize MLB without waiting for queue head. Defaults
    //   preserve original behavior for the daily cron.
    // D-294E (2026-05-23): default reduced from 500 → 200 because
    // 500 mixed-sport batches hit WORKER_RESOURCE_LIMIT on the edge
    // function CPU cap (verified live during emergency drain). Pre-fix
    // the daily cron's single 500-LIMIT run would crash → ZERO picks
    // resolved that day, queue grew daily. Now: 200 per run = ~45s
    // safe runtime. Need higher throughput? Either raise the cron
    // frequency in pg_cron OR call with body.limit (manual drain).
    //
    // D-294E (also): add game_date >= today-14d cutoff. Pre-fix the
    // 321 stale-backfilled NBA picks dated 2024-10-31 → 2025-01-05
    // (created during May 15 NBA backfill batch) headed the queue by
    // ASC order and consumed CPU/HTTP budget every run — ESPN game IDs
    // from 2024 don't even return reliable data anymore. The cutoff
    // skips them entirely (NOT voided — just deferred). Callers can
    // override via body.since_days to re-include older picks.
    const _bodyLimit = typeof body?.limit === "number" && body.limit > 0 ? Math.min(Math.floor(body.limit), 1000) : 200;
    const _bodySport = typeof body?.sport === "string" && (body.sport === "mlb" || body.sport === "nba") ? body.sport : null;
    const _sportFilter = _bodySport ? `&sport=eq.${_bodySport}` : "";
    const _sinceDays = typeof body?.since_days === "number" && body.since_days > 0 ? Math.min(Math.floor(body.since_days), 365) : 14;
    const _cutoffDate = new Date(Date.now() - _sinceDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // D-673 SHIP 1 fix — also gate `game_date < today (eastern)` so the recent-first
    // ordering doesn't waste the per-run budget on TODAY's picks (games not played
    // yet, would all skip). Pre-fix the first recent-first run pulled 300 TODAY
    // picks (DESC put them at the head) and skipped all 300 → 0 resolved.
    const _todayEasternStr = new Date().toLocaleString("en-CA", { timeZone: "America/New_York" })
      .slice(0, 10);
    const _dateFilter = `&game_date=gte.${_cutoffDate}&game_date=lt.${_todayEasternStr}`;
    // D-673 SHIP 1 — RECENT-FIRST ordering (replaces D-294E created_at.asc default).
    // Old default `order=created_at.asc` made yesterday's picks wait ~16 days
    // behind a 9,810-row backlog. Now defaults to game_date.desc + created_at.desc
    // so yesterday's picks resolve TODAY. Callers can opt back into oldest-first
    // by passing body.priority="oldest" (used by the dedicated backlog-drain pass).
    const _bodyPriority = typeof body?.priority === "string" && body.priority === "oldest" ? "oldest" : "recent";
    const _orderClause = _bodyPriority === "oldest"
      ? "&order=game_date.asc,created_at.asc"
      : "&order=game_date.desc,created_at.desc";
    // D-389a (2026-06-01) — query-gate fix for #77 push-jam. PUSH outcomes
    // write hit=null + resolved_at=NOW + actual_value=margin via
    // updatePickResult (line 213-249). Pre-fix the query gated only on
    // `hit IS NULL AND voided != true`, so pushes re-qualified every run
    // and cycled the queue head forever (139 rows from 5/18 consumed ~70%
    // of the 200/run budget; effective fresh-pick throughput was ~61/run
    // ×3 runs = 183/day vs ~700-1000/day creation rate → 58% backlog).
    // Adding `&resolved_at=is.null` excludes any pick the resolver has
    // already touched (push OR resolved). Backlog math: 200 fresh × 3 =
    // 600/day max, matches creation rate baseline.
    // D-721: SELECT player_id so resolveMlbPicks can match boxscore by integer id (99.42% coverage).
    const picksUrl = `${SUPABASE_URL}/rest/v1/pick_history?hit=is.null&resolved_at=is.null&voided=neq.true${_sportFilter}${_dateFilter}&select=id,player_name,player_id,team,prop_type,line,pick_side,game_time,created_at,sport,opponent,mlb_market_type,game_date,is_home${_orderClause}&limit=${_bodyLimit}`;
    let allPicksRaw: Array<{ id: string; player_name: string; player_id: number | null; team: string; prop_type: string; line: number; pick_side: string; game_time: string; created_at: string; sport?: string; opponent?: string; mlb_market_type?: string; game_date?: string; is_home?: boolean }> = [];
    // D-506 SHIP 2b — LOUD FAIL on picks-query non-OK. Pre-fix, the try/catch
    // swallowed PostgREST 5xx responses (including statement-timeout 500s)
    // by leaving allPicksRaw = [] and continuing as "no picks". 12-day stall,
    // 15,961 unresolved picks, 35 of 36 cron runs reported "succeeded".
    // Now: non-OK throws → top-level catch fires notify + heartbeat error +
    // returns 500, so cron.job_run_details and Sentry both surface the failure.
    const picksRes = await fetch(picksUrl, { headers: supabaseHeaders });
    if (!picksRes.ok) {
      const _errBody = await picksRes.text().catch(() => "");
      throw new Error(`picks query failed: status=${picksRes.status} body=${_errBody.slice(0, 300)}`);
    }
    allPicksRaw = await picksRes.json();
    console.log(`[resolve] Found ${allPicksRaw.length} unresolved picks (all sports)`);

    // D-275-RESOLVE: route MLB picks to MLB Stats API resolver;
    // NBA picks continue through existing ESPN flow below.
    const mlbPicks = allPicksRaw.filter((p) => p.sport === "mlb");
    const allPicks = allPicksRaw.filter((p) => p.sport !== "mlb"); // NBA + null (legacy)
    console.log(`[resolve] split: nba=${allPicks.length}, mlb=${mlbPicks.length}`);

    let mlbResolveSummary = { resolved: 0, unresolvable: 0, skipped: 0 };
    if (mlbPicks.length > 0) {
      mlbResolveSummary = await resolveMlbPicks(mlbPicks);
      console.log(`[resolve][MLB] resolved=${mlbResolveSummary.resolved} unresolvable=${mlbResolveSummary.unresolvable} skipped=${mlbResolveSummary.skipped}`);
    }

    if (allPicks.length === 0) {
      // No picks, just try to resolve bets
      const pendingBetsUrl = `${SUPABASE_URL}/rest/v1/bets?status=eq.pending&select=id,pick_id,player_name,prop_type,line,pick_side,odds,stake,placed_at&limit=100`;
      let pendingBets: Array<{ id: string; pick_id: string | null; player_name: string; prop_type: string; line: number; pick_side: string; odds: number; stake: number; placed_at: string }> = [];
      // D-515 SHIP 1 — LOUD FAIL on bets-fetch non-OK (D-506 SHIP 2b pattern).
      // Pre-fix: try/catch + `if(.ok)` BOTH swallowed → function returned
      // "Nothing to resolve" success on a PostgREST 500. Same class as D-506.
      const pendingBetsRes = await fetch(pendingBetsUrl, { headers: supabaseHeaders });
      if (!pendingBetsRes.ok) {
        const _errBody = await pendingBetsRes.text().catch(() => "");
        throw new Error(`pending bets fetch failed (no-picks path): status=${pendingBetsRes.status} body=${_errBody.slice(0, 300)}`);
      }
      pendingBets = await pendingBetsRes.json();

      if (pendingBets.length === 0) {
        if (_dryRun) return jsonResponse({ success: true, message: "Nothing to resolve", resolved: 0, skipped: 0, betsUpdated: 0, mlb: mlbResolveSummary, ..._dryRunSummary(Date.now() - _entryStart) });
        // D-389a: heartbeat on the NBA-empty early-return path so resolve-picks
        // self-reports even when its only work was MLB (pre-fix this path
        // bypassed line 1562 heartbeat → 4-day stale heartbeat per D-387 §(j)).
        await writeHeartbeat({ jobName: "resolve-picks", status: "success", durationMs: Date.now() - _entryStart });
        return jsonResponse({ success: true, message: "Nothing to resolve", resolved: 0, skipped: 0, betsUpdated: 0, mlb: mlbResolveSummary });
      }

      // Resolve bets only
      const now = new Date();
      const todayEastern = utcToEasternDate(now.toISOString());
      const datesToCheck = new Set<string>();
      // Filter out recent bets (placed < 18 hours ago)
      const filteredPendingBets = pendingBets.filter(bet => {
        const placedAt = new Date(bet.placed_at);
        const hoursSince = (Date.now() - placedAt.getTime()) / (1000 * 60 * 60);
        if (hoursSince < 18) { console.log("[resolve] Skipping recent inline bet (" + hoursSince.toFixed(1) + "h ago): " + bet.player_name); return false; }
        return true;
      });
      if (filteredPendingBets.length === 0) {
        if (_dryRun) return jsonResponse({ success: true, message: "All bets too recent to resolve", resolved: 0, skipped: 0, betsUpdated: 0, mlb: mlbResolveSummary, ..._dryRunSummary(Date.now() - _entryStart) });
        // D-389a: heartbeat on this early-return path too (NBA empty + bets too recent).
        await writeHeartbeat({ jobName: "resolve-picks", status: "success", durationMs: Date.now() - _entryStart });
        return jsonResponse({ success: true, message: "All bets too recent to resolve", resolved: 0, skipped: 0, betsUpdated: 0, mlb: mlbResolveSummary });
      }
      for (const bet of filteredPendingBets) {
        const gameDate = getBetGameDate(bet);
        datesToCheck.add(gameDate);
        const prevDate = new Date(parseInt(gameDate.slice(0, 4)), parseInt(gameDate.slice(4, 6)) - 1, parseInt(gameDate.slice(6, 8)));
        prevDate.setDate(prevDate.getDate() - 1);
        datesToCheck.add(prevDate.toISOString().slice(0, 10).replace(/-/g, ""));
      }
      const boxScoresByDate = await fetchBoxScoresForDates(datesToCheck);
      const betsUpdated = await resolvePendingBets(boxScoresByDate);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const base = { success: true, message: `No picks, resolved ${betsUpdated} bets`, resolved: 0, skipped: 0, betsUpdated, mlb: mlbResolveSummary, elapsedSeconds: parseFloat(elapsed) };
      if (_dryRun) return jsonResponse({ ...base, ..._dryRunSummary(Date.now() - _entryStart) });
      // D-389a: heartbeat on the bets-resolved early-return path.
      await writeHeartbeat({ jobName: "resolve-picks", status: "success", durationMs: Date.now() - _entryStart });
      return jsonResponse(base);
    }

    // Step 2: Group picks by derived game date
    const picksByDate = new Map<string, typeof allPicks>();
    for (const pick of allPicks) {
      const gameDate = getPickGameDate(pick);
      if (!picksByDate.has(gameDate)) {
        picksByDate.set(gameDate, []);
      }
      picksByDate.get(gameDate)!.push(pick);
    }

    // Step 3: Sort date keys and process ALL dates (with timeout safety)
    const sortedDates = Array.from(picksByDate.keys()).sort();
    let totalResolved = 0;
    let totalSkipped = 0;
    let totalUnresolvable = 0;
    let totalErrors = 0;
    let totalBetsUpdated = 0;
    const processedDates: string[] = [];

    for (const targetDate of sortedDates) {
    const loopElapsed = (Date.now() - startTime) / 1000;
    if (loopElapsed > 45) {
      console.log(`[resolve] Safety timeout at ${loopElapsed.toFixed(1)}s — processed ${processedDates.length} dates, stopping`);
      break;
    }
    const picksForDate = picksByDate.get(targetDate)!;
    console.log(`[resolve] Processing date: ${targetDate} (${picksForDate.length} picks)`);

    // Step 4: Eligibility filter
    const now = new Date();
    const todayEastern = utcToEasternDate(now.toISOString());
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

    let eligiblePicks: typeof picksForDate;
    if (targetDate < todayEastern) {
      // Past date - all picks are eligible (game is definitely over)
      eligiblePicks = picksForDate;
      console.log(`[resolve] Past date, all ${eligiblePicks.length} picks eligible`);
    } else {
      // Today - use 3-hour-after-game-time filter
      eligiblePicks = picksForDate.filter((pick) => {
        const gameDateTime = parseGameTime(pick.game_time, pick.created_at);
        if (gameDateTime) return gameDateTime < threeHoursAgo;
        const createdAt = new Date(pick.created_at);
        const sixHoursAfterCreation = new Date(createdAt.getTime() + 6 * 60 * 60 * 1000);
        return sixHoursAfterCreation < now;
      });
      console.log(`[resolve] Today's date, ${eligiblePicks.length}/${picksForDate.length} picks eligible (3hr filter)`);
    }

    // Step 5: Dates to check = target date + previous day only (max 2)
    const datesToCheck = new Set<string>();
    datesToCheck.add(targetDate);
    const prevDate = new Date(parseInt(targetDate.slice(0, 4)), parseInt(targetDate.slice(4, 6)) - 1, parseInt(targetDate.slice(6, 8)));
    prevDate.setDate(prevDate.getDate() - 1);
    datesToCheck.add(prevDate.toISOString().slice(0, 10).replace(/-/g, ""));

    // Also add dates from pending bets
    const pendingBetsUrl = `${SUPABASE_URL}/rest/v1/bets?status=eq.pending&select=id,pick_id,player_name,prop_type,line,pick_side,odds,stake,placed_at&limit=100`;
    let pendingBets: Array<{ id: string; pick_id: string | null; player_name: string; prop_type: string; line: number; pick_side: string; odds: number; stake: number; placed_at: string }> = [];
    try {
      const pendingBetsRes = await fetch(pendingBetsUrl, { headers: supabaseHeaders });
      if (pendingBetsRes.ok) {
        pendingBets = await pendingBetsRes.json();
      } else {
        // D-727: was a silent fall-through to "Found 0 pending bets" on a 5xx.
        // This is a date-aggregator path (not a resolution path), so we don't
        // void anything — but the operator needs to know the bets query failed.
        const _body = await pendingBetsRes.text().catch(() => "");
        console.log(`[resolve] [d727] dates-aggregator bets fetch HTTP ${pendingBetsRes.status}: ${_body.slice(0, 200)}`);
        await logResolverFailure({
          failureType: "unknown",
          detail: `dates-aggregator pending-bets fetch HTTP ${pendingBetsRes.status}: ${_body.slice(0, 400)}`,
        });
      }
    } catch (e) {
      console.log(`[resolve] [d727] dates-aggregator bets fetch threw: ${e}`);
      await logResolverFailure({
        failureType: "unknown",
        detail: `dates-aggregator pending-bets fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    console.log(`[resolve] Found ${pendingBets.length} pending bets`);

    for (const bet of pendingBets) {
      const gameDate = getBetGameDate(bet);
      datesToCheck.add(gameDate);
      const betPrevDate = new Date(parseInt(gameDate.slice(0, 4)), parseInt(gameDate.slice(4, 6)) - 1, parseInt(gameDate.slice(6, 8)));
      betPrevDate.setDate(betPrevDate.getDate() - 1);
      datesToCheck.add(betPrevDate.toISOString().slice(0, 10).replace(/-/g, ""));
    }

    console.log(`[resolve] Checking ${datesToCheck.size} dates: ${Array.from(datesToCheck).sort().join(", ")}`);

    if (eligiblePicks.length === 0 && pendingBets.length === 0) {
      const base = { success: true, message: "Nothing eligible yet", resolved: 0, skipped: picksForDate.length, betsUpdated: 0, targetDate };
      if (_dryRun) return jsonResponse({ ...base, ..._dryRunSummary(Date.now() - _entryStart) });
      return jsonResponse(base);
    }

    // Step 6: Fetch box scores keyed by date
    let boxScoresByDate: DateKeyedBoxScores;
    try {
      boxScoresByDate = await fetchBoxScoresForDates(datesToCheck);
    } catch (espnErr) {
      console.error(`[resolve] ESPN fetch failed:`, espnErr);
      return jsonResponse({ success: false, message: "ESPN data fetch failed, try again in a minute", targetDate, totalUnresolved: allPicks.length });
    }

    if (boxScoresByDate.size === 0) {
      const base = { success: true, message: "No completed games found", resolved: 0, skipped: eligiblePicks.length, unresolvable: 0, targetDate };
      if (_dryRun) return jsonResponse({ ...base, ..._dryRunSummary(Date.now() - _entryStart) });
      return jsonResponse(base);
    }

    // Step 7: Resolve each pick with date-aware lookup
    console.log(`\n[resolve] === Resolving ${eligiblePicks.length} picks ===`);
    let resolved = 0;
    let unresolvable = 0;
    let skipped = 0;
    let errors = 0;

    for (const pick of eligiblePicks) {
      const derivedDate = getPickGameDate(pick);
      console.log(`\n[resolve] Pick: ${pick.player_name} | ${pick.prop_type} ${pick.pick_side} ${pick.line}`);
      console.log(`[resolve]   created_at=${pick.created_at}, game_time=${pick.game_time}, derivedDate=${derivedDate}`);

      // === GAME PICKS (spreads & totals) — resolve from scoreboard scores ===
      if (pick.prop_type === "spread" || pick.prop_type === "game_total") {
        const games = await fetchScoreboard(derivedDate);
        const completedGames = games.filter(g => g.status === "STATUS_FINAL");
        const pickNameLower = pick.player_name.toLowerCase();
        const pickTeamLower = (pick.team || "").toLowerCase();

        const matchedGame = completedGames.find(g => {
          const home = g.homeTeam.toLowerCase();
          const away = g.awayTeam.toLowerCase();
          return pickNameLower.includes(home) || pickNameLower.includes(away) ||
                 home.includes(pickNameLower) || away.includes(pickNameLower) ||
                 home.includes(pickTeamLower) || pickTeamLower.includes(home);
        });

        if (!matchedGame) {
          console.log("[resolve]   ✗ Game not found for \"" + pick.player_name + "\" on " + derivedDate);
          if (completedGames.length > 0) {
            // D-727: NBA game-market pick whose teams didn't appear in any completed
            // game on the target date. Genuine no-match (not a transient API issue,
            // since completedGames was non-empty). Void with reason.
            await voidPick(pick.id, "game_market_no_match",
              `nba team="${pick.team}" player_name="${pick.player_name}"`,
              { market: pick.prop_type, gameDate: derivedDate });
            unresolvable++;
          } else {
            // D-727: no completed games on this date — log as informational skip.
            // We don't void: schedule may be incomplete, the slate may be earlier than
            // expected, or scoreboard may be lagging. Pick stays pending for retry.
            await logResolverFailure({
              pickId: pick.id, failureType: "no_final_games_on_date",
              market: pick.prop_type, gameDate: derivedDate,
              detail: `NBA scoreboard returned 0 completed games for ${derivedDate}`,
            });
            skipped++;
          }
          continue;
        }

        console.log("[resolve]   Game: " + matchedGame.awayTeam + " @ " + matchedGame.homeTeam + " | " + matchedGame.awayScore + "-" + matchedGame.homeScore);

        let actualValue: number;
        let hit: boolean | null;

        if (pick.prop_type === "spread") {
          // Determine if picked team is home or away
          const pickedHome = pick.pick_side === "home" ||
            matchedGame.homeTeam.toLowerCase().includes(pickNameLower) ||
            pickNameLower.includes(matchedGame.homeTeam.toLowerCase());
          const margin = pickedHome
            ? matchedGame.homeScore - matchedGame.awayScore
            : matchedGame.awayScore - matchedGame.homeScore;
          actualValue = margin;
          // Cover = margin + spread > 0 (spread is already for picked team)
          // Home -5, margin 8: 8+(-5)=3>0 ✓  |  Away +5, margin -3: -3+5=2>0 ✓
          // D-247 (2026-05-19): exact tie at the spread is a PUSH (hit=null),
          // not a loss (hit=false). Was push-as-loss prior to D-247.
          if ((margin + pick.line) === 0) {
            hit = null;
          } else {
            hit = (margin + pick.line) > 0;
          }
        } else {
          // game_total: combined score vs line
          actualValue = matchedGame.homeScore + matchedGame.awayScore;
          // D-247 (2026-05-19): actual == line is a PUSH (hit=null), not loss.
          if (actualValue === pick.line) {
            hit = null;
          } else if (pick.pick_side === "over") {
            hit = actualValue > pick.line;
          } else {
            hit = actualValue < pick.line;
          }
        }

        console.log("[resolve]   " + pick.prop_type + ": actual=" + actualValue + " line=" + pick.line + " side=" + pick.pick_side + " hit=" + hit);
        await updatePickResult(pick.id, actualValue, hit);
        resolved++;
        continue;
      }

      // === PLAYER PROPS — resolve from box scores ===
      const { player: playerStats, matchedDate } = findPlayerByDate(pick.player_name, derivedDate, boxScoresByDate);

      // Check if ESPN had data for the target date (or previous day)
      const prevDate = new Date(parseInt(derivedDate.slice(0, 4)), parseInt(derivedDate.slice(4, 6)) - 1, parseInt(derivedDate.slice(6, 8)));
      prevDate.setDate(prevDate.getDate() - 1);
      const prevDateStr = prevDate.toISOString().slice(0, 10).replace(/-/g, "");
      const targetDateHasData = boxScoresByDate.has(derivedDate) || boxScoresByDate.has(prevDateStr);

      if (!playerStats) {
        console.log(`[resolve]   ✗ Player not found on ${derivedDate} or previous day`);
        if (targetDateHasData) {
          console.log(`[resolve]   Voiding pick (DNP/no game)`);
          // D-727: NBA box-scores fetched successfully but this player isn't in them.
          // Genuine DNP (didn't play, inactive, or scratched). Void with reason —
          // distinct from a transient ESPN fetch failure (the targetDateHasData
          // gate ensures we only void when we KNOW the data was available).
          await voidPick(pick.id, "dnp",
            `nba player_name="${pick.player_name}" not in box scores for ${derivedDate}`,
            { market: pick.prop_type, gameDate: derivedDate });
          unresolvable++;
        } else {
          console.log(`[resolve]   Skipping (no ESPN data for ${derivedDate})`);
          // D-727: transient ESPN-data absence; this is the 1,913-pick bug
          // class — DO NOT void, log to resolver_failure_log so the operator
          // can see the API outage. Pick stays pending for the next cron tick.
          await logResolverFailure({
            pickId: pick.id, failureType: "boxscore_fetch_failed",
            market: pick.prop_type, gameDate: derivedDate,
            detail: `NBA: no ESPN box-score data for ${derivedDate} (or prev day); pick stays pending for retry`,
          });
          skipped++;
        }
        continue;
      }

      console.log(`[resolve]   ✓ Found "${playerStats.rawName}" on ${matchedDate}`);
      const actualValue = getPlayerStat(playerStats, pick.prop_type);

      if (actualValue === null) {
        console.log(`[resolve]   No ${pick.prop_type} stat found`);
        if (targetDateHasData) {
          console.log(`[resolve]   Voiding pick (DNP/no game)`);
          // D-727: player found in box scores but the stat field is null — genuine
          // DNP for THIS prop (e.g., a player who appeared but had 0 minutes / 0 stats).
          await voidPick(pick.id, "stat_not_extractable",
            `nba player_name="${pick.player_name}" prop_type=${pick.prop_type} stat field null`,
            { market: pick.prop_type, gameDate: derivedDate });
          unresolvable++;
        } else {
          console.log(`[resolve]   Skipping (no ESPN data for ${derivedDate})`);
          // D-727: same transient-fetch-failure path as above; do not void.
          await logResolverFailure({
            pickId: pick.id, failureType: "boxscore_fetch_failed",
            market: pick.prop_type, gameDate: derivedDate,
            detail: `NBA: no ESPN box-score data for ${derivedDate} (or prev day); pick stays pending for retry`,
          });
          skipped++;
        }
        continue;
      }

      // D-247 (2026-05-19): actual_value == line is a PUSH (hit=null), not a loss.
      // Pre-D-247 the strict inequality produced hit=false on pushes → ~3.25% of
      // recorded losses were actually pushes. resolved_at is still set so the
      // updated query filter (resolved_at=is.null) won't re-fetch.
      let hit: boolean | null;
      if (actualValue === pick.line) {
        hit = null;
      } else if (pick.pick_side === "over") {
        hit = actualValue > pick.line;
      } else {
        hit = actualValue < pick.line;
      }

      console.log(`[resolve]   actual=${actualValue}, line=${pick.line}, hit=${hit}`);
      const updated = await updatePickResult(pick.id, actualValue, hit);
      if (updated) { resolved++; } else { errors++; }
    }

    // Step 8: Resolve pending bets
    // D-515 SHIP 1 — REMOVED the silent swallow that paired with the
    // resolvePendingBets():698 swallow (both fixed). The inner fn now
    // throws loudly on bets-fetch non-OK; let it bubble to the top-level
    // catch so the cron run fires notify + heartbeat error + 500.
    const betsUpdated = await resolvePendingBets(boxScoresByDate);

    totalResolved += resolved;
    totalSkipped += skipped;
    totalUnresolvable += unresolvable;
    totalErrors += errors;
    totalBetsUpdated += betsUpdated;
    processedDates.push(targetDate);
    } // end for loop over dates

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[resolve] All dates done in ${elapsed}s: resolved=${totalResolved}, dates=${processedDates.join(',')}`);

    // SMS alert hooks — fire after the result is built. notify() is silent-
    // catch + rate-limited per title; never crashes this function.
    // D-253f: suppress notify() in dry-run (writes notifications_log).
    if (!_dryRun) {
      if (totalErrors > 5) {
        await notify({
          severity: "warning",
          title: "resolve-picks errors elevated",
          message: `errors=${totalErrors}, resolved=${totalResolved}, skipped=${totalSkipped} across ${processedDates.length} dates`,
          metadata: { errors: totalErrors, resolved: totalResolved },
        });
      }
      // Stuck-bets check: if there were unresolved picks AND we managed to
      // resolve almost none of them after going through the full flow, that's
      // a stuck-bets condition.
      if (allPicks.length >= 5 && totalResolved < 2 && totalUnresolvable < 2) {
        await notify({
          severity: "warning",
          title: "resolve-picks stuck bets",
          message: `${allPicks.length} unresolved picks, only ${totalResolved} resolved + ${totalUnresolvable} unresolvable — most appear stuck`,
          metadata: { unresolved_total: allPicks.length, resolved: totalResolved, unresolvable: totalUnresolvable },
        });
      }
    }

    const mainBase = {
      success: true,
      message: `Resolved ${totalResolved + mlbResolveSummary.resolved} picks across ${processedDates.length} dates (nba=${totalResolved}, mlb=${mlbResolveSummary.resolved}), updated ${totalBetsUpdated} bets`,
      resolved: totalResolved + mlbResolveSummary.resolved,
      resolved_by_sport: { nba: totalResolved, mlb: mlbResolveSummary.resolved },
      skipped: totalSkipped + mlbResolveSummary.skipped,
      unresolvable: totalUnresolvable + mlbResolveSummary.unresolvable,
      errors: totalErrors,
      betsUpdated: totalBetsUpdated,
      processedDates,
      totalUnresolved: allPicks.length + mlbPicks.length,
      elapsedSeconds: parseFloat(elapsed),
    };
    if (_dryRun) return jsonResponse({ ...mainBase, ..._dryRunSummary(Date.now() - _entryStart) });
    // D-272-INF-2: heartbeat success.
    await writeHeartbeat({ jobName: "resolve-picks", status: "success", durationMs: Date.now() - _entryStart });
    return jsonResponse(mainBase);

  } catch (err) {
    console.error("[resolve] Error:", err);
    // Critical: cron crashed entirely. Caller's catch returned 500.
    // D-253f: suppress notify in dry-run (writes notifications_log).
    if (!_dryRun) {
      await notify({
        severity: "critical",
        title: "resolve-picks cron crashed",
        message: err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400),
      });
    }
    // OBS-02: also surface to Sentry. Non-blocking; existing notify path
    // continues firing. Stack trace + breadcrumbs only available via Sentry.
    await captureError(err, {
      function: "resolve-picks",
      phase: "top-level-handler",
    });
    // D-272-INF-2: heartbeat error.
    if (!_dryRun) await writeHeartbeat({ jobName: "resolve-picks", status: "error", durationMs: Date.now() - _entryStart, error: err instanceof Error ? err.message : String(err) });
    return jsonResponse({ success: false, error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
