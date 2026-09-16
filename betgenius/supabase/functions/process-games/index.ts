import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";
import { captureError } from "../_shared/sentry.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";
import { selectBestSameLineBook } from "../_shared/best_price.ts";
import { logSonnetUsage } from "../_shared/sonnet_usage_log.ts";
// D-487 SHIP 2 — unified pick_history writer (NBA-first staged rollout).
// This batch routes the NBA caller through the helper; MLB + analyze-pick
// migrate in later stages after NBA verifies for 7d. See d486_write_path_design.md.
import { writePickHistory, type PickHistoryPayload } from "../_shared/pick_history_writer.ts";
import {
  logErrorStructured,
  trackFailureRate,
  captureWithContext,
} from "../_shared/error_handling.ts";
import {
  // D-155 (May 14, 2026): scoring math moved to _shared/scoring.ts.
  // process-games + analyze-pick now share single source of truth.
  type ScoringWeights, type ScoreOneSideHelpers,
  type ExtractedProp, type GameLogEntry, type PlayerResult, type MinutesTrend,
  type AbsenceInfo, type OpponentStats, type PropAnalysisResult, type CachedPlayerData,
  type GameLineSnapshot,
  loadWeightsFromDB,
  PROP_STAT_MAP, getStatValue, isDNPGame,
  calcHitRates, calculateMinutesTrend, detectRecentAbsence, calculateStdDev,
  calculatePerMinuteRate, projectMinutes, computeProjectedStat, calculateZScore,
  calculateUsageBoost, detectMinutesFloor, calculateHomeAwaySplit,
  detectMarketConfirmation, detectRegression, calculateUSGRate, detectRoleChange,
  calculatePaceDefenseScores, getScoreLabel, getPlayerInjuryStatus,
  calculateConfidenceScore, scoreOneSide, MINUTE_BOUND_PROPS,
} from "../_shared/scoring.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// --- Configuration ---
const ODDS_API_KEY = Deno.env.get("THE_ODDS_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const BALLDONTLIE_API_KEY = Deno.env.get("BALLDONTLIE_API_KEY") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const ESPN_FETCH_TIMEOUT_MS = 5000;
const PLAYER_BATCH_SIZE = 10;
const MAX_PROCESSING_MS = 300000; // 300s max, Pro tier allows 400s // 120s max, leaving 30s buffer within 150s limit

// --- Backfill-only "as of" date override ---
// Tier 0 #12 Phase 2 Fix #1 (May 11, 2026 night): when scoreSlateForDate
// replays a historical pick, it must use targetDate as the "now" reference
// for score_stale_data instead of the wall clock. Otherwise an April pick
// replayed in May is marked stale against TODAY (Phase 1 found mean abs
// drift 7.02pp on this factor — top of the 12 drift sources).
//
// scoreSlateForDate sets this before its scoring loop and resets to null
// in finally. Live cron path never touches it → stale calc resolves to
// new Date() → behavior unchanged in production.
let _backfillAsOfDate: Date | null = null;

// --- Backfill-only injury-fetch short-circuit ---
// Tier 0 #12 Phase 3 Fix #5 amendment-2 (May 11, 2026 night): scoreSlateForDate
// alone clearing bdlInjuriesByTeam is insufficient — scoreOneSide calls
// getTeamInjuries → fetchTeamInjuries → loadBdlInjuries which re-populates
// the map during scoring. This flag short-circuits loadBdlInjuries at the
// top, preventing any code path inside scoreOneSide from refilling the map
// during backfill. scoreSlateForDate sets true when options.skipInjuryFetch=true,
// resets false in finally. Live cron path leaves it false → loadBdlInjuries
// runs normally → behavior unchanged in production.
let _suppressInjuryFetch: boolean = false;

// D-253f dry-run gate: module-scope flag set at top of Deno.serve per-request.
// Deno edge functions are per-invocation so module-scope effectively scopes to
// the current request. Writer helpers (logPickToHistory, logToRecommendationsCache,
// postCache, logRun, logError, plus the inline cron_progress / spread+total
// pick_history / recommendations_cache POSTs in the entry handler) all early-
// return when true. Counts what WOULD be written so the dry-run response
// reports `would_write.*`. Reset to false on every request.
let _dryRun: boolean = false;
const _dryRunCounts = {
  pick_history: 0,
  recommendations_cache: 0,
  cron_progress: 0,
  cache_writes: 0,
  run_log: 0,
  error_log: 0,
};
function _resetDryRunCounts(): void {
  _dryRunCounts.pick_history = 0;
  _dryRunCounts.recommendations_cache = 0;
  _dryRunCounts.cron_progress = 0;
  _dryRunCounts.cache_writes = 0;
  _dryRunCounts.run_log = 0;
  _dryRunCounts.error_log = 0;
}

// --- Dynamic Weights (loaded from DB, fallback to defaults) ---
// --- Diagnostics ---
const runStats = {
  startTime: 0, gamesFound: 0, propsFetched: 0, playersLoaded: 0, playersSkipped: 0,
  oppStatsFound: 0, oppStatsFailed: 0, propsScored: 0, recommendations: 0,
  aiGenerated: 0, aiFailed: 0, errorsCount: 0, notes: [] as string[],
};
function resetRunStats() {
  runStats.startTime = Date.now(); runStats.gamesFound = 0; runStats.propsFetched = 0;
  runStats.playersLoaded = 0; runStats.playersSkipped = 0; runStats.oppStatsFound = 0;
  runStats.oppStatsFailed = 0; runStats.propsScored = 0; runStats.recommendations = 0;
  runStats.aiGenerated = 0; runStats.aiFailed = 0; runStats.errorsCount = 0; runStats.notes = [];
  resetCacheCounts();
}
async function logError(phase: string, errorType: string, errorMessage: string, context: Record<string, unknown> = {}) {
  runStats.errorsCount++;
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    // D-253f: suppress error_log writes in dry-run EXCEPT dry_run_internal
    // telemetry (so helper bugs in dry-run still surface).
    if (_dryRun && errorType !== "dry_run_internal") {
      _dryRunCounts.error_log++;
      return;
    }
    await fetch(`${url}/rest/v1/error_log`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ function_name: "process-games", phase, error_type: errorType, error_message: errorMessage, context }),
    });
  } catch (_e) { console.error(`[diag] Failed to log error: ${errorMessage}`); }
}
async function logRun(status: string) {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    // D-253f: skip run_log writes + notify() calls in dry-run.
    if (_dryRun) {
      _dryRunCounts.run_log++;
      return;
    }
    // D-052 Phase 2: append cache-writer counts to notes for run_log visibility.
    const cacheNote = "cache_writes={"
      + "pgl:" + cacheCounts.player_game_logs
      + ",pm:"  + cacheCounts.player_metadata
      + ",tm:"  + cacheCounts.team_metadata
      + ",ods:" + cacheCounts.opponent_defensive_stats
      + ",ti:"  + cacheCounts.team_injuries
      + ",sb:"  + cacheCounts.game_scoreboard
      + ",err:" + cacheCounts.errors
      + "}";
    const allNotes = [...runStats.notes, cacheNote];
    await fetch(`${url}/rest/v1/run_log`, {
      method: "POST", headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        function_name: "process-games", duration_ms: Date.now() - runStats.startTime,
        games_found: runStats.gamesFound, props_fetched: runStats.propsFetched,
        players_loaded: runStats.playersLoaded, players_skipped: runStats.playersSkipped,
        opp_stats_found: runStats.oppStatsFound, opp_stats_failed: runStats.oppStatsFailed,
        props_scored: runStats.propsScored, recommendations: runStats.recommendations,
        ai_generated: runStats.aiGenerated, ai_failed: runStats.aiFailed,
        errors_count: runStats.errorsCount,
        // C32 fix (May 5): promote cache POST failure count from notes string
        // to first-class column. Sourced from cacheCounts.errors which is
        // incremented at process-games:193 inside postCache helper. Distinct
        // from opp_stats_failed (ESPN/BDL fetch failures only).
        cache_write_errors: cacheCounts.errors,
        status,
        notes: allNotes.join("; "),
      }),
    });

    // SMS alert hooks — fire after run_log POST so we have durable record
    // of any condition that triggered an alert. notify() is silent-catch
    // and rate-limited per title; never crashes this function.
    if (status === "failed") {
      await notify({
        severity: "critical",
        title: "process-games cron tick failed",
        message: `errors=${runStats.errorsCount} props_scored=${runStats.propsScored} games_found=${runStats.gamesFound}`,
        metadata: { errors_count: runStats.errorsCount, recommendations: runStats.recommendations },
      });
    } else if (runStats.errorsCount > 5) {
      await notify({
        severity: "critical",
        title: "process-games 5+ errors in single tick",
        message: `errors=${runStats.errorsCount}, recs=${runStats.recommendations}, cache_errors=${cacheCounts.errors}`,
        metadata: { errors_count: runStats.errorsCount, cache_write_errors: cacheCounts.errors },
      });
    } else if (status === "success" && runStats.recommendations === 0 && runStats.gamesFound > 0) {
      await notify({
        severity: "critical",
        title: "process-games zero picks generated",
        message: `games_found=${runStats.gamesFound}, props_scored=${runStats.propsScored}, props_fetched=${runStats.propsFetched} — silent failure mode`,
        metadata: { games_found: runStats.gamesFound, props_scored: runStats.propsScored },
      });
    } else if (cacheCounts.errors > 5) {
      await notify({
        severity: "warning",
        title: "process-games cache write errors elevated",
        message: `cache_write_errors=${cacheCounts.errors} on tick with ${runStats.gamesFound} games`,
        metadata: { cache_write_errors: cacheCounts.errors, errors_count: runStats.errorsCount },
      });
    }
  } catch (_e) { console.error("[diag] Failed to log run"); }
}

// ============================================================================
// D-052 — Cache Phase 2: writers
//
// Non-blocking, fire-and-await POSTs to the 6 cache_* tables created in Phase
// 1 (D-043). Each writer is fully wrapped in try/catch — if a cache write
// fails, the failure is logged to error_log + counted in cacheCounts.errors,
// and the cron continues. Cache writes are NEVER on the critical path; the
// production scoring loop runs identically with or without these writers.
//
// Patterns:
//   - Snapshot tables (cache_opponent_defensive_stats, cache_team_injuries):
//     PK includes snapshot_date so historical state is preserved. Multiple
//     cron ticks within the same day merge under the same snapshot_date row.
//   - Last-write-wins (cache_player_game_logs, cache_player_metadata,
//     cache_team_metadata, cache_game_scoreboard): on_conflict resolves to
//     merge-duplicates so the freshest cron run overwrites.
//
// No readers wired yet — Phase 5+ wires read paths (analyze-pick first, then
// process-games' scoring path itself).
// ============================================================================

const cacheCounts = { player_game_logs: 0, player_metadata: 0, team_metadata: 0, opponent_defensive_stats: 0, team_injuries: 0, game_scoreboard: 0, errors: 0 };
function resetCacheCounts() {
  cacheCounts.player_game_logs = 0; cacheCounts.player_metadata = 0; cacheCounts.team_metadata = 0;
  cacheCounts.opponent_defensive_stats = 0; cacheCounts.team_injuries = 0; cacheCounts.game_scoreboard = 0;
  cacheCounts.errors = 0;
}

async function postCache(table: string, onConflict: string, rows: unknown[]): Promise<boolean> {
  if (!rows.length) return true;
  // D-253f: skip ALL cache_* writes in dry-run. Count rows that WOULD be written.
  if (_dryRun) {
    _dryRunCounts.cache_writes += rows.length;
    return true;
  }
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return false;

    // D-063: Dedupe within batch by the on_conflict natural key. Postgres
    // raises 21000 ("ON CONFLICT DO UPDATE command cannot affect row a
    // second time") when a single INSERT contains multiple rows that map
    // to the same conflict target — `merge-duplicates` is row-vs-existing,
    // not row-vs-other-rows-in-the-same-statement. Last-write-wins map
    // collapses intra-batch dupes (e.g. ESPN gamelog returning the same
    // game twice for a player, or BDL injury feed listing the same
    // (player, team) pair across multiple endpoint pages).
    const keyCols = onConflict.split(",").map((c) => c.trim()).filter(Boolean);
    const seen = new Map<string, unknown>();
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const k = keyCols.map((c) => String(r[c] ?? "")).join("|");
      seen.set(k, row);
    }
    const dedupedRows = Array.from(seen.values());
    const dupesRemoved = rows.length - dedupedRows.length;
    if (dupesRemoved > 0) {
      // Visibility hook so we can see in run_log notes when dedupe is hot.
      // Counts roll up via cacheCounts; not a failure.
      console.log(`[cache-write] ${table}: deduped ${dupesRemoved} intra-batch row(s) on key (${onConflict}); ${dedupedRows.length} rows posted`);
    }

    const res = await fetch(
      `${url}/rest/v1/${table}?on_conflict=${onConflict}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(dedupedRows),
      }
    );
    if (!res.ok) {
      cacheCounts.errors++;
      const body = await res.text().catch(() => "");
      await logError("cache-write", "post_failed", `POST ${table} status=${res.status}`, { table, status: res.status, body: body.slice(0, 500), rowCount: dedupedRows.length, dupesRemoved });
      return false;
    }
    return true;
  } catch (err) {
    cacheCounts.errors++;
    await logError("cache-write", "post_threw", err instanceof Error ? err.message : String(err), { table, rowCount: rows.length });
    return false;
  }
}

// Helper: convert a permissive date string (ISO datetime, "YYYY-MM-DD", ESPN
// "Wed 4/30", or empty) into a YYYY-MM-DD string Postgres DATE accepts. Returns
// null when nothing parseable is available.
function toIsoDate(s: string): string | null {
  if (!s) return null;
  // Already YYYY-MM-DD form
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  try {
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

// C33 Phase 2/3 (May 7, 2026): converts YYYYMMDD compact format → YYYY-MM-DD
// ISO format for the new game_date_new DATE columns. Used at every writer site
// that dual-writes to pick_history.game_date_new + recommendations_cache.game_date_new
// during the gradual cutover. Phase 6 (next session) drops OLD column and renames NEW.
function yyyymmddToIsoDate(yyyymmdd: string | null | undefined): string | null {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

const TEAM_ESPN_ID_REVERSE = new Map<string, string>(); // espn_id -> team_name (lowercase)
function ensureTeamEspnReverseBuilt() {
  if (TEAM_ESPN_ID_REVERSE.size > 0) return;
  for (const [name, id] of Object.entries(TEAM_ESPN_IDS)) TEAM_ESPN_ID_REVERSE.set(String(id), name);
}

async function writeCachePlayerGameLogs(playerId: string, playerName: string, sport: string, gameLog: GameLogEntry[]) {
  if (!playerId || !gameLog || gameLog.length === 0) return;
  const sportKey = sport === "basketball" ? "nba" : sport;
  const rows: Record<string, unknown>[] = [];
  for (const g of gameLog) {
    const isoDate = toIsoDate(g.date);
    if (!isoDate) continue;
    const stats = g.stats || {};
    rows.push({
      player_id: playerId,
      player_name: playerName,
      game_date: isoDate,
      opponent: g.opponent || null,
      is_home: g.homeAway === "home" ? true : g.homeAway === "away" ? false : null,
      minutes: stats["MIN"] ?? stats["MINS"] ?? null,
      points: stats["PTS"] ?? null,
      rebounds: stats["REB"] ?? null,
      assists: stats["AST"] ?? null,
      threes: stats["3PM"] ?? null,
      steals: stats["STL"] ?? null,
      blocks: stats["BLK"] ?? null,
      turnovers: stats["TO"] ?? null,
      result: null,
      source: "espn",
      sport: sportKey,
    });
  }
  if (rows.length === 0) return;
  const ok = await postCache("cache_player_game_logs", "player_id,game_date,sport", rows);
  if (ok) cacheCounts.player_game_logs += rows.length;
}

async function writeCachePlayerMetadata(player: PlayerResult, sport: string) {
  if (!player?.id) return;
  const sportKey = sport === "basketball" ? "nba" : sport;
  const row = {
    player_id: player.id,
    player_name: player.displayName,
    team_name: player.team || null,
    position: player.position || null,
    is_active: true,
    last_updated: new Date().toISOString(),
    sport: sportKey,
  };
  const ok = await postCache("cache_player_metadata", "player_id", [row]);
  if (ok) cacheCounts.player_metadata += 1;
}

async function writeCacheTeamMetadata() {
  ensureTeamEspnReverseBuilt();
  // May 5 Phase 4 fix: prior version iterated TEAM_ESPN_IDS whose keys are
  // ABBREVIATIONS ("ATL", "BOS"). That broke three fields:
  //   team_name=ATL (should be full name), abbreviation="" (TEAM_ABBREV["ATL"]
  //   doesn't exist), bdl_id=null (bdlTeamNameToId keys are lowercase full
  //   names — line 1473 sets via t.full_name.toLowerCase()).
  // Iterate TEAM_ABBREV instead — its keys ARE lowercase full names. Each
  // dictionary lookup now matches the right shape:
  //   abbreviation: TEAM_ABBREV["atlanta hawks"] = "ATL" ✓
  //   espn_id: TEAM_ESPN_IDS["ATL"] = "1" ✓
  //   bdl_id: bdlTeamNameToId.get("atlanta hawks") ✓
  // Note: TEAM_ESPN_IDS has dual keys (e.g., "GS" + "GSW" both map to 9). The
  // canonical lookup via TEAM_ABBREV avoids that ambiguity.
  const rows: Record<string, unknown>[] = [];
  for (const [fullName, abbrev] of Object.entries(TEAM_ABBREV)) {
    const espnId = TEAM_ESPN_IDS[abbrev] ?? "";
    rows.push({
      team_name: fullName,
      abbreviation: abbrev,
      bdl_id: bdlTeamNameToId.get(fullName) ?? null,
      espn_id: String(espnId),
      conference: null,
      division: null,
      current_pace: null,
      schedule_density: null,
      last_updated: new Date().toISOString(),
      sport: "nba",
    });
  }
  if (rows.length === 0) return;
  const ok = await postCache("cache_team_metadata", "team_name,sport", rows);
  if (ok) cacheCounts.team_metadata += rows.length;
}

async function writeCacheOpponentDefensiveStats(teamName: string, snapshotDate: string, oppStats: OpponentStats) {
  if (!teamName || !snapshotDate || !oppStats) return;
  const isoDate = toIsoDate(snapshotDate);
  if (!isoDate) return;
  // May 5 fix: NUMERIC(4,3) columns expect decimal-format pcts (0.472).
  // ESPN returns percentage-format (47.2). Normalize before writing so the
  // schema's intended semantic holds without column scale changes.
  const normalizePct = (v: number | null | undefined): number | null => {
    if (v == null || v === 0) return null;
    return v > 1.0 ? v / 100 : v;
  };
  const row = {
    team_name: teamName,
    snapshot_date: isoDate,
    bdl_team_id: bdlTeamNameToId.get(teamName.toLowerCase()) ?? null,
    ppg_allowed: oppStats.pointsAllowedPerGame || null,
    rpg_allowed: oppStats.reboundsAllowedPerGame || null,
    apg_allowed: oppStats.assistsAllowedPerGame || null,
    spg_allowed: null,
    bpg_allowed: null,
    threes_allowed: null,
    fg_pct_allowed: normalizePct(oppStats.oppFieldGoalPct),
    three_pct_allowed: normalizePct(oppStats.oppThreePointPct),
    pace: oppStats.pace || null,
    // May 5 Phase 4: persist BDL def_rating (added by da98c6c, column added by
    // migration 20260505000000). Phase 5 readers consume this for points/PRA/
    // PA/PR opp signal. NUMERIC(5,2), NBA league avg ~113, range 95-115.
    def_rating: oppStats.defensiveRating > 0 ? oppStats.defensiveRating : null,
    net_rating: null,
    sos: null,
    sport: "nba",
  };
  const ok = await postCache("cache_opponent_defensive_stats", "team_name,snapshot_date,sport", [row]);
  if (ok) cacheCounts.opponent_defensive_stats += 1;
}

async function writeCacheTeamInjuries(snapshotDate: string) {
  const isoDate = toIsoDate(snapshotDate);
  if (!isoDate) return;
  const rows: Record<string, unknown>[] = [];
  for (const [teamName, injuries] of bdlInjuriesByTeam.entries()) {
    for (const inj of injuries) {
      if (!inj.playerName) continue;
      rows.push({
        player_name: inj.playerName,
        team_name: teamName,
        snapshot_date: isoDate,
        status: inj.status || "Unknown",
        description: inj.description || null,
        bdl_id: null,
        sport: "nba",
      });
    }
  }
  if (rows.length === 0) return;
  const ok = await postCache("cache_team_injuries", "player_name,team_name,snapshot_date,sport", rows);
  if (ok) cacheCounts.team_injuries += rows.length;
}

async function writeCacheGameScoreboard(scoreboard: ScoreboardData | null) {
  if (!scoreboard?.events?.length) return;
  const rows: Record<string, unknown>[] = [];
  for (const ev of scoreboard.events) {
    try {
      const e = ev as Record<string, unknown>;
      const gameId = String(e.id ?? "");
      if (!gameId) continue;
      const startTime = (e.date as string) ?? null;
      const isoDate = toIsoDate(startTime || "");
      if (!isoDate) continue;
      const comps = (e.competitions as Array<Record<string, unknown>>) ?? [];
      const comp = comps[0];
      const competitors = (comp?.competitors as Array<Record<string, unknown>>) ?? [];
      const homeComp = competitors.find(c => c.homeAway === "home");
      const awayComp = competitors.find(c => c.homeAway === "away");
      const homeTeam = ((homeComp?.team as Record<string, unknown>)?.displayName as string) || "";
      const awayTeam = ((awayComp?.team as Record<string, unknown>)?.displayName as string) || "";
      if (!homeTeam || !awayTeam) continue;
      const status = ((e.status as Record<string, unknown>)?.type as Record<string, unknown>)?.name as string ?? "unknown";
      const homeScore = parseInt(String(homeComp?.score ?? ""), 10);
      const awayScore = parseInt(String(awayComp?.score ?? ""), 10);
      rows.push({
        game_id: gameId,
        game_date: isoDate,
        home_team: homeTeam,
        away_team: awayTeam,
        start_time: startTime,
        status,
        home_score: isNaN(homeScore) ? null : homeScore,
        away_score: isNaN(awayScore) ? null : awayScore,
        sport: "nba",
      });
    } catch (_e) { /* skip malformed event */ }
  }
  if (rows.length === 0) return;
  const ok = await postCache("cache_game_scoreboard", "game_id,sport", rows);
  if (ok) cacheCounts.game_scoreboard += rows.length;
}

// --- In-memory caches (per invocation) ---
const bdlTeamNameToId = new Map<string, number>();
const injuryCache = new Map<string, string[]>();
let oppStatsDiagLogged = false;

// --- Team name normalization ---
const TEAM_NAME_NORMALIZE: Record<string, string> = {
  "la clippers": "los angeles clippers",
  "la lakers": "los angeles lakers",
  "los angeles clippers": "los angeles clippers",
  "los angeles lakers": "los angeles lakers",
};

const TEAM_ABBREV: Record<string, string> = {
  "atlanta hawks": "ATL", "boston celtics": "BOS", "brooklyn nets": "BKN",
  "charlotte hornets": "CHA", "chicago bulls": "CHI", "cleveland cavaliers": "CLE",
  "dallas mavericks": "DAL", "denver nuggets": "DEN", "detroit pistons": "DET",
  "golden state warriors": "GSW", "houston rockets": "HOU", "indiana pacers": "IND",
  "los angeles clippers": "LAC", "los angeles lakers": "LAL", "memphis grizzlies": "MEM",
  "miami heat": "MIA", "milwaukee bucks": "MIL", "minnesota timberwolves": "MIN",
  "new orleans pelicans": "NOP", "new york knicks": "NYK", "oklahoma city thunder": "OKC",
  "orlando magic": "ORL", "philadelphia 76ers": "PHI", "phoenix suns": "PHX",
  "portland trail blazers": "POR", "sacramento kings": "SAC", "san antonio spurs": "SAS",
  "toronto raptors": "TOR", "utah jazz": "UTA", "washington wizards": "WAS"
};

const TEAM_ESPN_IDS: Record<string, string> = {
  "ATL": "1", "BOS": "2", "BKN": "17", "CHA": "30", "CHI": "4",
  "CLE": "5", "DAL": "6", "DEN": "7", "DET": "8", "GS": "9", "GSW": "9",
  "HOU": "10", "IND": "11", "LAC": "12", "LAL": "13", "MEM": "29",
  "MIA": "14", "MIL": "15", "MIN": "16", "NO": "3", "NOP": "3", "NY": "18", "NYK": "18",
  "OKC": "25", "ORL": "19", "PHI": "20", "PHX": "21", "POR": "22",
  "SA": "24", "SAS": "24", "SAC": "23", "TOR": "28", "UTA": "26", "WAS": "27",
};

function normalizeTeamName(team: string): string {
  const lower = team.toLowerCase().trim();
  return TEAM_NAME_NORMALIZE[lower] ?? lower;
}

// --- Types ---

interface OddsEvent {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers?: Array<{
    key: string;
    markets?: Array<{
      key: string;
      outcomes?: Array<{
        name: string;
        description?: string;
        price: number;
        point?: number;
      }>;
    }>;
  }>;
}


// --- Utility Functions ---

async function quietFetch(url: string, timeoutMs?: number): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const res = await fetch(url, { signal: controller.signal });
    if (timeoutId) clearTimeout(timeoutId);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (_e) {
    return { ok: false, status: 0, text: "" };
  }
}

async function logApiUsage(endpoint: string, httpStatus: number, headers: Headers | null, context: Record<string, unknown> = {}, eventCount: number | null = null): Promise<void> {
  try {
    const used = headers ? parseInt(headers.get("x-requests-used") || "0", 10) : NaN;
    const remaining = headers ? parseInt(headers.get("x-requests-remaining") || "0", 10) : NaN;
    const last = headers ? parseInt(headers.get("x-requests-last") || "0", 10) : NaN;
    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !key) return;
    await fetch(url + "/rest/v1/api_usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key, "Prefer": "return=minimal" },
      body: JSON.stringify({
        function_name: "process-games",
        endpoint, http_status: httpStatus,
        requests_used: isNaN(used) ? null : used,
        requests_remaining: isNaN(remaining) ? null : remaining,
        requests_last: isNaN(last) ? null : last,
        event_count: eventCount, context,
      }),
    });
  } catch (_err) { /* non-fatal */ }
}

// Circuit breaker: query most recent api_usage row; if requests_remaining is below
// CIRCUIT_BREAKER_THRESHOLD, log to error_log and return false so the caller skips
// the Odds API call. Fails open on DB errors so logging hiccups don't stall runs.
const CIRCUIT_BREAKER_THRESHOLD = 500;
async function checkCircuitBreaker(context: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !key) return true;
    // Only consider rows from successful (200) responses. 5xx responses from The Odds
    // API have no x-requests-* headers, so logApiUsage stores them with remaining=0 —
    // if we didn't filter, a single 503 would self-brick the breaker on every run.
    const res = await fetch(
      url + "/rest/v1/api_usage?select=requests_remaining,called_at&http_status=eq.200&order=called_at.desc&limit=1",
      { headers: { "apikey": key, "Authorization": "Bearer " + key } }
    );
    if (!res.ok) return true;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return true;
    const remaining = rows[0]?.requests_remaining;
    if (typeof remaining !== "number") return true;
    if (remaining < CIRCUIT_BREAKER_THRESHOLD) {
      await logError("circuit_breaker", "circuit_breaker",
        "Odds API requests_remaining=" + remaining + " below threshold=" + CIRCUIT_BREAKER_THRESHOLD + " — skipping Odds API calls",
        { ...context, remaining, threshold: CIRCUIT_BREAKER_THRESHOLD, last_called_at: rows[0]?.called_at ?? null }
      );
      return false;
    }
    return true;
  } catch (_err) { return true; }
}

function formatGameTime(isoTime: string): string {
  try {
    const date = new Date(isoTime);
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET";
  } catch (_e) {
    return "";
  }
}

// --- ESPN Functions ---

function namesMatch(query: string, candidate: string): boolean {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (c === q) return true;
  if (c.includes(q) || q.includes(c)) return true;
  const qWords = q.split(/\s+/);
  return qWords.length > 1 && qWords.every(w => c.includes(w));
}

async function fetchAthleteProfile(playerId: string, sport: string): Promise<{ team: string; position: string }> {
  const sportPath = sport === "basketball" ? "basketball/nba" : sport;
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${playerId}`;
  const { ok, text } = await quietFetch(url, ESPN_FETCH_TIMEOUT_MS);
  if (!ok || !text) return { team: "", position: "" };
  try {
    const data = JSON.parse(text);
    const athlete = data?.athlete ?? data;
    return {
      team: athlete?.team?.displayName ?? athlete?.team?.name ?? "",
      position: athlete?.position?.displayName ?? athlete?.position?.abbreviation ?? "",
    };
  } catch (_e) {
    return { team: "", position: "" };
  }
}

async function searchPlayer(name: string, sport: string, timeoutMs?: number): Promise<PlayerResult | null> {
  // Attempt 1: site.web search
  {
    const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=5&mode=prefix&type=player`;
    const { ok, text } = await quietFetch(url, timeoutMs);
    if (ok && text) {
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data?.items)) {
          for (const item of data.items) {
            const entryName = item?.displayName ?? item?.title ?? item?.name ?? "";
            const athleteId = item?.id;
            if (athleteId && namesMatch(name, entryName)) {
              let team = item?.team?.displayName ?? item?.description ?? "";
              let position = item?.position ?? "";
              if (!team) {
                const profile = await fetchAthleteProfile(String(athleteId), sport);
                team = profile.team;
                position = profile.position || position;
              }
              return { id: String(athleteId), displayName: entryName, team, position };
            }
          }
        }
      } catch (_e) { /* ignore */ }
    }
  }
  // Attempt 2: site API v2
  {
    const sportPath = sport === "basketball" ? "basketball/nba" : sport;
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/athletes?search=${encodeURIComponent(name)}`;
    const { ok, text } = await quietFetch(url, timeoutMs);
    if (ok && text) {
      try {
        const data = JSON.parse(text);
        const athletes = data?.athletes ?? data?.items ?? [];
        for (const athlete of Array.isArray(athletes) ? athletes : []) {
          const aName = athlete?.displayName ?? athlete?.fullName ?? athlete?.name ?? "";
          const aId = athlete?.id ?? athlete?.uid?.match?.(/(\d+)/)?.[1];
          if (aId && namesMatch(name, aName)) {
            let team = athlete?.team?.displayName ?? athlete?.team?.name ?? "";
            let position = athlete?.position?.displayName ?? athlete?.position?.abbreviation ?? "";
            if (!team) {
              const profile = await fetchAthleteProfile(String(aId), sport);
              team = profile.team;
              position = profile.position || position;
            }
            return { id: String(aId), displayName: aName, team, position };
          }
        }
      } catch (_e) { /* ignore */ }
    }
  }
  return null;
}

async function fetchGameLog(playerId: string, sport: string, timeoutMs?: number): Promise<GameLogEntry[]> {
  const sportPath = sport === "basketball" ? "basketball/nba" : sport;
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${playerId}/gamelog`;
  const { ok, text } = await quietFetch(url, timeoutMs);
  if (!ok || !text) return [];
  try {
    const data = JSON.parse(text);
    const entries: GameLogEntry[] = [];
    const labels: string[] = data?.labels ?? [];
    const names: string[] = data?.names ?? [];
    const eventsObj = data?.events ?? {};
    const seasonTypes = data?.seasonTypes ?? [];
    const statKeys = labels.length ? labels : names;
    if (!statKeys.length) return [];
    for (const seasonType of seasonTypes) {
      const categories = seasonType?.categories ?? [];
      for (const category of categories) {
        const catEvents = category?.events ?? [];
        const catLabels: string[] = category?.labels ?? statKeys;
        for (const catEvent of catEvents) {
          const eventId = catEvent?.eventId ?? catEvent?.id;
          const eventInfo = eventsObj[eventId] ?? {};
          const statsValues: string[] = catEvent?.stats ?? [];
          const statsMap: Record<string, number> = {};
          catLabels.forEach((label: string, i: number) => {
            if (i < statsValues.length) {
              const rawVal = String(statsValues[i]);
              const numMatch = rawVal.match(/^[\d.]+/);
              if (numMatch) {
                const val = parseFloat(numMatch[0]);
                if (!isNaN(val)) statsMap[label] = val;
              }
            }
          });
          if (Object.keys(statsMap).length > 0) {
            entries.push({
              date: eventInfo.gameDate ?? "",
              opponent: eventInfo.opponent?.displayName ?? eventInfo.opponent?.abbreviation ?? "",
              // §19.3 May 12 fix per /tmp/home_away_split_dead_factor_audit_may12.md.
              // ESPN gamelog uses `atVs` ('vs'=home, '@'=away); the field
              // `eventInfo.homeAway` does not exist (verified May 12 via live
              // endpoint curl). Producer-side bug: factor was dark since
              // fetchGameLog inception — 0 fires across 4,543 picks all eras.
              // D-058 fixed the downstream consumer at calculateHomeAwaySplit
              // but this producer needed fixing to make D-058 effective.
              // Parallel fix applied at: analyze-pick:351, analyze-pick:392,
              // get-player-stats:327, get-player-stats:368, backtest:168.
              // §1.12 24h fire-rate re-check owed (D-131 forward-ref).
              homeAway: eventInfo.atVs === "vs" ? "home" : eventInfo.atVs === "@" ? "away" : "",
              stats: statsMap,
            });
          }
        }
      }
    }
    return entries;
  } catch (e) {
    // D-158 (May 14, 2026): structured log so fetchGameLog parse failures
    // surface in error_log. Silent return-[] previously masked ESPN
    // schema-change regressions for players whose gamelog endpoint started
    // returning an unparseable shape.
    await logErrorStructured("warning", {
      function_name: "process-games",
      phase: "fetch-game-log",
      error_type: "gamelog_parse_failed",
      message: e instanceof Error ? e.message : String(e),
      payload: { playerId, sport },
    });
    return [];
  }
}

// --- Analysis Functions ---

// D-137 Tier 2 #6 (May 13, 2026, CEO §19.3 V0-B): minute-bound prop set for
// score_blowout_risk. Penalty applies ONLY to these prop types because they
// correlate with minutes played; blocks/steals/turnovers/threes excluded
// (skill counters can produce volume even in reduced minutes).
const MINUTE_BOUND_PROPS: Set<string> = new Set([
  "points", "rebounds", "assists",
  "points_rebounds_assists", "points_rebounds", "points_assists", "rebounds_assists",
  "player_points", "player_rebounds", "player_assists",
  "player_points_rebounds_assists", "player_points_rebounds",
  "player_points_assists", "player_rebounds_assists",
]);

// D-137: per-cron-tick game-line cache. Module-level Map because Deno edge
// functions are stateless across invocations; within a single tick, populated
// once per game at the per-pending-game loop entry, read by scoreOneSide.
// Key format: `${homeTeam}|${awayTeam}|${gameDate}` (YYYY-MM-DD).
const gameLineCache: Map<string, GameLineSnapshot> = new Map();

async function loadGameLineFromCache(homeTeam: string, awayTeam: string, gameDateIso: string): Promise<GameLineSnapshot | null> {
  const key = `${homeTeam}|${awayTeam}|${gameDateIso}`;
  const cached = gameLineCache.get(key);
  if (cached) return cached;
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !k) return null;
    const q = `${url}/rest/v1/cache_game_lines?game_date=eq.${gameDateIso}&home_team=eq.${encodeURIComponent(homeTeam)}&away_team=eq.${encodeURIComponent(awayTeam)}&select=spread_line,favored_team,spread_line_t0&limit=1`;
    const res = await fetch(q, { headers: { "apikey": k, "Authorization": "Bearer " + k } });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      gameLineCache.set(key, { spread: null, favoredTeam: null, spreadT0: null });
      return null;
    }
    const r = rows[0];
    const snap: GameLineSnapshot = {
      spread: typeof r.spread_line === "number" ? r.spread_line : (r.spread_line ? Number(r.spread_line) : null),
      favoredTeam: r.favored_team ?? null,
      // D-139: spread_line_t0 (first-observed) — null when not yet populated.
      spreadT0: typeof r.spread_line_t0 === "number" ? r.spread_line_t0 : (r.spread_line_t0 ? Number(r.spread_line_t0) : null),
    };
    gameLineCache.set(key, snap);
    return snap;
  } catch (_e) {
    return null;
  }
}






// --- Opponent Data ---

async function fetchOpponentDefensiveStats(teamId: string, teamName?: string, asOfDate?: string): Promise<OpponentStats | null> {
  // Tier 0 #12 Phase 2 Fix #2 (May 11, 2026 night): `asOfDate` (YYYY-MM-DD,
  // optional) selects which `cache_opponent_defensive_stats` snapshot to use
  // for the rebounds/assists override (C26-B). Backfill passes targetDate.
  // Live cron leaves it undefined → falls back to today's ET date (legacy
  // behavior, unchanged). Backward-only fallback: if no exact-date snapshot
  // exists, take the nearest prior snapshot. Never falls forward in time.
  if (!teamId) return null;

  function collectAllStats(data: Record<string, unknown>): Map<string, number> {
    const statsMap = new Map<string, number>();
    function walk(obj: unknown, depth = 0): void {
      if (depth > 10 || !obj || typeof obj !== "object") return;
      const o = obj as Record<string, unknown>;
      if (typeof o.name === "string" && typeof o.value === "number") statsMap.set(o.name.toLowerCase(), o.value);
      if (typeof o.name === "string" && typeof o.displayValue === "string") {
        const val = parseFloat(o.displayValue);
        if (!isNaN(val) && !statsMap.has(o.name.toLowerCase())) statsMap.set(o.name.toLowerCase(), val);
      }
      if (Array.isArray(obj)) { for (const item of obj) walk(item, depth + 1); }
      else { for (const val of Object.values(o)) walk(val, depth + 1); }
    }
    walk(data);
    return statsMap;
  }

  function findStat(allStats: Map<string, number>, names: string[]): number {
    for (const name of names) { const val = allStats.get(name); if (val !== undefined && val > 0) return val; }
    return 0;
  }

  function buildOpponentStats(allStats: Map<string, number>): OpponentStats | null {
    // NOTE (May 4 megadeploy): see OpponentStats interface comment. The first
    // three fields fall through to OPP's own averages — acknowledged proxy.
    const pointsAllowedRaw = findStat(allStats, ["avgpointsagainst", "pointsagainst", "opppoints", "opposingteamavgpoints", "opponentpointspergame", "avgpoints", "points"]);
    const reboundsAllowedRaw = findStat(allStats, ["avgreboundsagainst", "opprebounds", "reboundsagainst", "opposingteamavgrebounds", "avgrebounds", "totalrebounds"]);
    const assistsAllowedRaw = findStat(allStats, ["oppassists", "assistsagainst", "opposingteamavgassists", "avgassists", "assists"]);
    // May 5 Phase 4 fix: NUMERIC(5,2) max 999.99. Per-game NBA values < 250.
    // Values above threshold are season-total leaks from findStat fall-through
    // to "points"/"totalrebounds"/"assists" when avg* keys had value=0 +
    // displayValue=number ESPN JSON quirk. collectAllStats stores value=0
    // first (line 1170) then skips displayValue fallback (line 1173 `!has(...)`).
    // findStat then returns 0 (val>0 check fails), falls through to season totals.
    // Cap to 0 → triggers writer's `|| null` short-circuit and avoids
    // NUMERIC(5,2) overflow. Same pattern as 58bac62 pace fix.
    // The deeper collectAllStats fix is deferred (Option b) — flagged for
    // future monthly audit; this defensive cap covers the symptom safely.
    const pointsAllowed = pointsAllowedRaw > 250 ? 0 : pointsAllowedRaw;
    const reboundsAllowed = reboundsAllowedRaw > 100 ? 0 : reboundsAllowedRaw;
    const assistsAllowed = assistsAllowedRaw > 60 ? 0 : assistsAllowedRaw;
    const oppFgPct = findStat(allStats, ["oppfieldgoalpct", "fieldgoalpctagainst", "opponentfieldgoalpercentage", "opposingteamfieldgoalpct"]);
    const oppThreePct = findStat(allStats, ["oppthreepointpct", "threepointpctagainst", "opponentthreepointpercentage", "oppthreepointfieldgoalpercentage", "opposingteamthreepointpct"]);
    // May 5 fix: prefer per-game `pacefactor` (~95-110) before falling back
    // to `possessions` (season total ~8000s — always overflows NUMERIC(5,2)
    // pace column in cache_opponent_defensive_stats). `avgestimatedpossessions`
    // is also per-game (~99-100). `pace` field doesn't exist in either ESPN
    // endpoint — keeping it in the lookup as a no-op for forward compat.
    const paceRaw = findStat(allStats, ["pacefactor", "avgestimatedpossessions", "possessionspergame", "pace", "possessions", "estimatedpossessions"]);
    // Defensive normalize: per-game pace is ~95-110. If a season total leaks
    // through (>200), fall back to league average 101 rather than overflow.
    const pace = paceRaw > 200 ? 101 : paceRaw;
    const defRating = findStat(allStats, ["defensiverating", "defrating", "drtg", "defensiveefficiency"]);
    // May 4 megadeploy: extract opp's-OWN stats from corrected ESPN sports.core.api
    // endpoint. These are CORRECT signals (not proxies) for steals/blocks/turnovers/3PM
    // player props per Decision #6 routing.
    const oppOwnTurnovers = findStat(allStats, ["avgturnovers", "turnoverspergame"]);
    const oppOwnSteals = findStat(allStats, ["avgsteals", "stealspergame"]);
    const oppOwnBlocks = findStat(allStats, ["avgblocks", "blockspergame"]);
    const oppOwnTwoPtFGPct = findStat(allStats, ["twopointfieldgoalpct", "twopointfgpct"]);
    const oppOwnThreePtFGPct = findStat(allStats, ["threepointpct", "threepointfieldgoalpct"]);
    const oppOwnFGPct = findStat(allStats, ["fieldgoalpct"]);
    const oppPaceFactor = findStat(allStats, ["pacefactor", "avgestimatedpossessions"]);
    let defenseRank = "average";
    if (defRating > 0) {
      if (defRating <= 108) defenseRank = "elite (top 5)";
      else if (defRating <= 112) defenseRank = "good (top 10)";
      else if (defRating <= 115) defenseRank = "average";
      else if (defRating <= 118) defenseRank = "below average";
      else defenseRank = "poor (bottom 5)";
    } else if (pointsAllowed > 0) {
      if (pointsAllowed <= 108) defenseRank = "elite defense";
      else if (pointsAllowed <= 112) defenseRank = "good defense";
      else if (pointsAllowed <= 116) defenseRank = "average defense";
      else defenseRank = "weak defense";
    }
    return {
      pointsAllowedPerGame: pointsAllowed, reboundsAllowedPerGame: reboundsAllowed,
      assistsAllowedPerGame: assistsAllowed, oppFieldGoalPct: oppFgPct,
      oppThreePointPct: oppThreePct, pace, defensiveRating: defRating, defenseRank,
      oppOwnTurnovers, oppOwnSteals, oppOwnBlocks,
      oppOwnTwoPtFGPct, oppOwnThreePtFGPct, oppOwnFGPct, oppPaceFactor,
    };
  }

  async function attemptFetch(): Promise<OpponentStats | null> {
    // May 4 megadeploy: try sports.core.api FIRST (regular-season seasontype=2
    // honored via path segment /types/2/). The site.api fallback silently
    // returns POSTSEASON data when team qualifiedPostSeason — caused all
    // opp-stats fetches to use 6-game playoff samples since Apr 18 (2026
    // playoffs began). The /leagues/ segment is also required (was missing
    // in prior production code → 404 → silent fall-through to site.api).
    const url1 = `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2026/types/2/teams/${teamId}/statistics`;
    const res1 = await quietFetch(url1, ESPN_FETCH_TIMEOUT_MS);
    if (res1.ok && res1.text) {
      try {
        const data = JSON.parse(res1.text);
        const allStats = collectAllStats(data);
        if (!oppStatsDiagLogged) {
          oppStatsDiagLogged = true;
          console.log(`[oppStats-DIAG] teamId=${teamId} | Total stats: ${allStats.size} (regular season)`);
        }
        const result = buildOpponentStats(allStats);
        if (result && result.pointsAllowedPerGame > 0) return result;
      } catch (_e) { /* ignore */ }
    }
    // Site.api fallback — used only if sports.core.api fails. Returns POSTSEASON
    // data when applicable (acknowledged limitation; site.api ignores
    // seasontype query param).
    const url2 = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/statistics`;
    const res2 = await quietFetch(url2, ESPN_FETCH_TIMEOUT_MS);
    if (res2.ok && res2.text) {
      try {
        const data = JSON.parse(res2.text);
        const allStats = collectAllStats(data);
        const result = buildOpponentStats(allStats);
        if (result && result.pointsAllowedPerGame > 0) return result;
      } catch (_e) { /* ignore */ }
    }
    return null;
  }

  let result = await attemptFetch();
  if (!result) {
    await new Promise(r => setTimeout(r, 2000));
    result = await attemptFetch();
  }
  // May 5 BDL rewire — closes C26 partial resolution.
  // Populate defensiveRating from BDL /v1/teamseasonaverages/advanced. The
  // ESPN endpoint findStat for "defensiverating" never matches (returns 0).
  // BDL's def_rating is points-allowed-per-100-possessions — a true defensive
  // matchup signal. Used by calculatePaceDefenseScores for points/PRA/PA props.
  // Single BDL call per opp team per cron tick (well under API budget).
  if (result && teamName && BALLDONTLIE_API_KEY) {
    try {
      const searchName = teamName.toLowerCase().replace(/[^a-z0-9 ]/g, "");
      const bdlId = bdlTeamNameToId.get(searchName);
      if (bdlId) {
        const advUrl = `https://api.balldontlie.io/v1/teamseasonaverages/advanced?season=2025&team_id=${bdlId}`;
        const advRes = await fetch(advUrl, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
        if (advRes.ok) {
          const advData = await advRes.json();
          const defRating = advData.data?.[0]?.def_rating;
          if (typeof defRating === "number" && defRating > 0) {
            result.defensiveRating = defRating;
            // Refresh defenseRank using the now-populated defRating.
            if (defRating <= 108) result.defenseRank = "elite (top 5)";
            else if (defRating <= 112) result.defenseRank = "good (top 10)";
            else if (defRating <= 115) result.defenseRank = "average";
            else if (defRating <= 118) result.defenseRank = "below average";
            else result.defenseRank = "poor (bottom 5)";
          }
        }
      }
    } catch (_e) { /* ignore — fall back to ESPN-only result */ }
  }

  // C26-B (May 7, 2026): override ESPN-sourced reboundsAllowedPerGame /
  // assistsAllowedPerGame with TRUE opponent-allowed values from the daily
  // BDL aggregation snapshot (cache_opponent_defensive_stats.rpg_allowed_bdl
  // + apg_allowed_bdl, populated by snapshot-opp-stats edge function). The
  // ESPN values these columns are populated from return the team's OWN RPG/APG
  // not what they ALLOW opponents — so the existing values in OpponentStats
  // were structurally wrong for rebounds/assists prop scoring. Fallback to
  // ESPN values stays in place if the BDL snapshot hasn't run yet for today.
  if (result && teamName) {
    try {
      const SUPA_URL_C = Deno.env.get("SUPABASE_URL") || "";
      const SUPA_KEY_C = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      if (SUPA_URL_C && SUPA_KEY_C) {
        // Fix #2: backfill passes asOfDate=targetDate; live cron passes
        // undefined → defaults to today's ET date. Query strategy: try
        // exact-date match first, then fall back BACKWARD to the most
        // recent snapshot on or before asOfDate. Never forward.
        const requestedDate = asOfDate || new Date(Date.now() - 4 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        const baseUrl = SUPA_URL_C + "/rest/v1/cache_opponent_defensive_stats" +
          `?team_name=eq.${encodeURIComponent(teamName)}` +
          `&sport=eq.nba` +
          `&select=rpg_allowed_bdl,apg_allowed_bdl,opp_stats_source,snapshot_date`;
        // 1) exact-date match
        let cacheRes = await fetch(
          baseUrl + `&snapshot_date=eq.${requestedDate}&limit=1`,
          { headers: { apikey: SUPA_KEY_C, Authorization: "Bearer " + SUPA_KEY_C } },
        );
        let rows: Array<{ rpg_allowed_bdl?: number; apg_allowed_bdl?: number; snapshot_date?: string }> = [];
        if (cacheRes.ok) rows = await cacheRes.json();
        // 2) if no exact match AND asOfDate was supplied, try nearest-prior
        if ((!Array.isArray(rows) || rows.length === 0) && asOfDate) {
          cacheRes = await fetch(
            baseUrl + `&snapshot_date=lte.${requestedDate}&order=snapshot_date.desc&limit=1`,
            { headers: { apikey: SUPA_KEY_C, Authorization: "Bearer " + SUPA_KEY_C } },
          );
          if (cacheRes.ok) rows = await cacheRes.json();
        }
        if (Array.isArray(rows) && rows.length > 0) {
          const row = rows[0];
          if (typeof row.rpg_allowed_bdl === "number" && row.rpg_allowed_bdl > 0) {
            result.reboundsAllowedPerGame = row.rpg_allowed_bdl;
          }
          if (typeof row.apg_allowed_bdl === "number" && row.apg_allowed_bdl > 0) {
            result.assistsAllowedPerGame = row.apg_allowed_bdl;
          }
        }
      }
    } catch (_e) { /* ignore — fall back to ESPN-only values */ }
  }

  // D-186 (May 15, 2026): enrich result with per-opp-position GOAT advanced
  // lookups from cache_team_advanced_stats_by_position. Two reads: lookup
  // team_abbr in cache_team_metadata, then position rows for the snapshot.
  // Idempotent + graceful-degradation — missing rows = no enrichment, no
  // behavior change vs pre-D-186.
  if (result && teamName) {
    try {
      const SUPA_URL_D = Deno.env.get("SUPABASE_URL") || "";
      const SUPA_KEY_D = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      if (SUPA_URL_D && SUPA_KEY_D) {
        const requestedDate = asOfDate || new Date(Date.now() - 4 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        const tmUrl = SUPA_URL_D + "/rest/v1/cache_team_metadata" +
          `?team_name=eq.${encodeURIComponent(teamName)}&sport=eq.nba&select=abbreviation&limit=1`;
        const tmRes = await fetch(tmUrl, {
          headers: { apikey: SUPA_KEY_D, Authorization: "Bearer " + SUPA_KEY_D },
        });
        const tmRows = tmRes.ok ? await tmRes.json() : [];
        const abbr = Array.isArray(tmRows) && tmRows[0]?.abbreviation;
        if (abbr) {
          let posUrl = SUPA_URL_D + "/rest/v1/cache_team_advanced_stats_by_position" +
            `?team_abbr=eq.${encodeURIComponent(abbr)}&sport=eq.nba` +
            `&snapshot_date=eq.${requestedDate}` +
            `&select=position,defensive_rating,defensive_rebound_percentage,assist_percentage`;
          let posRes = await fetch(posUrl, {
            headers: { apikey: SUPA_KEY_D, Authorization: "Bearer " + SUPA_KEY_D },
          });
          let posRows = posRes.ok ? await posRes.json() : [];
          if ((!Array.isArray(posRows) || posRows.length === 0) && asOfDate) {
            posUrl = SUPA_URL_D + "/rest/v1/cache_team_advanced_stats_by_position" +
              `?team_abbr=eq.${encodeURIComponent(abbr)}&sport=eq.nba` +
              `&snapshot_date=lte.${requestedDate}&order=snapshot_date.desc&limit=10` +
              `&select=position,defensive_rating,defensive_rebound_percentage,assist_percentage,snapshot_date`;
            posRes = await fetch(posUrl, {
              headers: { apikey: SUPA_KEY_D, Authorization: "Bearer " + SUPA_KEY_D },
            });
            posRows = posRes.ok ? await posRes.json() : [];
            // Filter to single snapshot_date (most recent)
            if (Array.isArray(posRows) && posRows.length > 0) {
              const latestDate = posRows[0].snapshot_date;
              posRows = posRows.filter((p: { snapshot_date?: string }) => p.snapshot_date === latestDate);
            }
          }
          if (Array.isArray(posRows) && posRows.length > 0) {
            const dr: Record<string, number> = {};
            const drb: Record<string, number> = {};
            const ast: Record<string, number> = {};
            for (const p of posRows) {
              if (p.defensive_rating != null) dr[p.position] = Number(p.defensive_rating);
              if (p.defensive_rebound_percentage != null) drb[p.position] = Number(p.defensive_rebound_percentage);
              if (p.assist_percentage != null) ast[p.position] = Number(p.assist_percentage);
            }
            if (Object.keys(dr).length) result.defensiveRatingVsPosition = dr;
            if (Object.keys(drb).length) result.defensiveReboundPctVsPosition = drb;
            if (Object.keys(ast).length) result.assistPctVsPosition = ast;
          }
        }
      }
    } catch (_e) { /* graceful degradation — no enrichment */ }
  }

  return result;
}


// --- BallDontLie Injury System ---

interface BdlInjury {
  playerName: string;
  status: string;
  description: string;
  teamName: string;
  // ISO YYYY-MM-DD or null. Populated 126/128 rows in BDL today (audit
  // May 10). Used by getPlayerInjuryStatus to scale long-term-out penalties.
  returnDate: string | null;
}
let bdlInjuriesLoaded = false;
const bdlInjuriesByTeam = new Map<string, BdlInjury[]>();

async function loadBdlInjuries(): Promise<void> {
  // Tier 0 #12 Phase 3 Fix #5 amendment-2: when scoreSlateForDate has
  // requested injury-fetch suppression (set via _suppressInjuryFetch top-of-
  // file), short-circuit any code path that would re-populate bdlInjuriesByTeam.
  // This catches the implicit call from scoreOneSide → getTeamInjuries →
  // fetchTeamInjuries → loadBdlInjuries that bypassed the explicit
  // `options.skipInjuryFetch` gate in scoreSlateForDate. Live cron path
  // leaves the flag false → this guard is a no-op → behavior unchanged.
  if (_suppressInjuryFetch) return;
  if (bdlInjuriesLoaded) return;
  // D-162 (May 14, 2026): flag set AFTER successful load (was: before fetch).
  // Pre-D-162 behavior: a transient BDL outage on cron-tick start would set
  // bdlInjuriesLoaded=true with empty bdlInjuriesByTeam, poisoning every
  // subsequent loadBdlInjuries() call in the run → all players treated as
  // "no injury" → score_player_injury silently returns 0. Now: failure leaves
  // the flag false so the next call (next player in the loop) retries.
  if (!BALLDONTLIE_API_KEY) {
    console.log("[injuries-bdl] No API key set");
    bdlInjuriesLoaded = true; // no-key state is permanent within this isolate
    return;
  }
  try {
    const teamsRes = await fetch("https://api.balldontlie.io/v1/teams", { headers: { "Authorization": BALLDONTLIE_API_KEY } });
    if (!teamsRes.ok) {
      await logErrorStructured("warning", {
        function_name: "process-games",
        phase: "load-bdl-injuries",
        error_type: "bdl_teams_fetch_failed",
        message: `HTTP ${teamsRes.status}`,
      });
      return; // flag stays false → retry on next call
    }
    const teamsData = await teamsRes.json();
    const teamMap = new Map<number, string>();
    for (const t of teamsData.data) { teamMap.set(t.id, t.full_name.toLowerCase()); bdlTeamNameToId.set(t.full_name.toLowerCase(), t.id); }
    let cursor: number | null = null;
    const allInjuries: any[] = [];
    do {
      const url = cursor ? "https://api.balldontlie.io/v1/player_injuries?per_page=100&cursor=" + cursor : "https://api.balldontlie.io/v1/player_injuries?per_page=100";
      const res = await fetch(url, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
      if (!res.ok) {
        await logErrorStructured("warning", {
          function_name: "process-games",
          phase: "load-bdl-injuries",
          error_type: "bdl_injuries_fetch_failed",
          message: `HTTP ${res.status} cursor=${cursor ?? "null"}`,
        });
        return; // flag stays false → retry on next call
      }
      const data = await res.json();
      allInjuries.push(...data.data);
      cursor = data.meta?.next_cursor || null;
    } while (cursor);
    for (const inj of allInjuries) {
      const teamName = teamMap.get(inj.player?.team_id) || "unknown";
      const playerName = ((inj.player?.first_name || "") + " " + (inj.player?.last_name || "")).trim();
      const entry: BdlInjury = {
        playerName,
        status: inj.status || "Unknown",
        description: inj.description || "",
        teamName,
        returnDate: inj.return_date || null,
      };
      if (!bdlInjuriesByTeam.has(teamName)) bdlInjuriesByTeam.set(teamName, []);
      bdlInjuriesByTeam.get(teamName)!.push(entry);
    }
    bdlInjuriesLoaded = true; // success → mark loaded for remainder of isolate lifecycle
    console.log("[injuries-bdl] Loaded " + allInjuries.length + " injuries across " + bdlInjuriesByTeam.size + " teams");
  } catch (e) {
    await logErrorStructured("warning", {
      function_name: "process-games",
      phase: "load-bdl-injuries",
      error_type: "bdl_load_threw",
      message: e instanceof Error ? e.message : String(e),
    });
    // flag stays false → retry on next call
  }
}

async function fetchTeamInjuries(teamName: string): Promise<string[]> {
  await loadBdlInjuries();
  const key = teamName.toLowerCase();
  const injuries = bdlInjuriesByTeam.get(key) || [];
  return injuries.map(inj => inj.playerName + ": " + inj.status + (inj.description ? " - " + inj.description.substring(0, 120) : ""));
}


async function getTeamInjuries(teamName: string): Promise<string[]> {
  const key = teamName.toLowerCase();
  if (injuryCache.has(key)) return injuryCache.get(key)!;
  const injuries = await fetchTeamInjuries(teamName);
  injuryCache.set(key, injuries);
  return injuries;
}

// --- Game Context ---

// Shared cache for scoreboard lookups within a single invocation
const scoreboardCache = new Map<string, Array<Record<string, unknown>>>();

async function checkBackToBack(teamName: string): Promise<{ isBackToBack: boolean; restDays: number }> {
  try {
    // Tier 0 #12 Phase 3 Fix #4 (May 11, 2026 night): reuse _backfillAsOfDate
    // override (Phase 2 commit bef3163). In backfill mode, scoreSlateForDate
    // sets it before its scoring loop → checkBackToBack scans backward from
    // targetDate, not from wall clock. Live cron leaves override null →
    // resolves to new Date() → identical pre-fix behavior. Eliminates
    // score_rest + score_b2b drift (Phase 1 measured 1.84pp combined).
    const now = _backfillAsOfDate ?? new Date();
    const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const normalizedTeam = teamName.toLowerCase().trim();

    // Look back up to 15 days. Return as soon as we find a game the team played.
    for (let daysBack = 1; daysBack <= 15; daysBack++) {
      const checkDate = new Date(easternNow);
      checkDate.setDate(checkDate.getDate() - daysBack);
      const year = checkDate.getFullYear();
      const month = String(checkDate.getMonth() + 1).padStart(2, '0');
      const day = String(checkDate.getDate()).padStart(2, '0');
      const dateStr = `${year}${month}${day}`;

      let events: Array<Record<string, unknown>>;
      if (scoreboardCache.has(dateStr)) {
        events = scoreboardCache.get(dateStr)!;
      } else {
        const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`;
        const { ok, text } = await quietFetch(url, ESPN_FETCH_TIMEOUT_MS);
        if (!ok || !text) {
          scoreboardCache.set(dateStr, []);
          continue;
        }
        try {
          const data = JSON.parse(text);
          events = data?.events ?? [];
          scoreboardCache.set(dateStr, events);
        } catch {
          scoreboardCache.set(dateStr, []);
          continue;
        }
      }

      for (const event of events) {
        const competitions = (event as Record<string, unknown>)?.competitions as Array<Record<string, unknown>> ?? [];
        for (const comp of competitions) {
          const competitors = (comp as Record<string, unknown>)?.competitors as Array<Record<string, unknown>> ?? [];
          for (const competitor of competitors) {
            const teamData = (competitor as Record<string, unknown>)?.team as Record<string, unknown> ?? {};
            const dn = ((teamData?.displayName as string) ?? "").toLowerCase();
            const ab = ((teamData?.abbreviation as string) ?? "").toLowerCase();
            if (dn.includes(normalizedTeam) || normalizedTeam.includes(dn) || ab === normalizedTeam || normalizedTeam.includes(ab)) {
              // daysBack=1 means team played yesterday → B2B, restDays=0
              // daysBack=N means N-1 days of rest
              return { isBackToBack: daysBack === 1, restDays: daysBack - 1 };
            }
          }
        }
      }
    }

    // Team hasn't played in 15+ days — treat as max rest (extended absence)
    return { isBackToBack: false, restDays: 15 };
  } catch (_e) {
    return { isBackToBack: false, restDays: 1 };
  }
}

interface ScoreboardData { events: Array<Record<string, unknown>>; fetchedAt: Date; }

async function fetchScoreboard(): Promise<ScoreboardData | null> {
  try {
    const now = new Date();
    const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const year = easternNow.getFullYear();
    const month = String(easternNow.getMonth() + 1).padStart(2, '0');
    const day = String(easternNow.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;
    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`;
    const { ok, text } = await quietFetch(url, ESPN_FETCH_TIMEOUT_MS);
    if (!ok || !text) return null;
    const data = JSON.parse(text);
    return { events: data?.events ?? [], fetchedAt: now };
  } catch (e) {
    // D-158 (May 14, 2026): structured log — fetchScoreboard failure leaves
    // the entire cron tick without opponent-team-ID lookups, which silently
    // degrades downstream factors (opponent form, pace, defense).
    await logErrorStructured("warning", {
      function_name: "process-games",
      phase: "fetch-scoreboard",
      error_type: "scoreboard_parse_failed",
      message: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function fetchOpponentTeamIdFromScoreboard(teamName: string, scoreboardData: ScoreboardData): string | null {
  try {
    const normalizedTeam = teamName.toLowerCase().trim();
    const normalizedTeamForMatch = normalizeTeamName(teamName);
    const uniqueEventsMap = new Map<string, Record<string, unknown>>();
    for (const event of scoreboardData.events) {
      const eventId = (event as Record<string, unknown>)?.id as string;
      if (eventId && !uniqueEventsMap.has(eventId)) uniqueEventsMap.set(eventId, event as Record<string, unknown>);
    }
    const uniqueEvents = Array.from(uniqueEventsMap.values());
    for (const event of uniqueEvents) {
      for (const comp of (event as Record<string, unknown>)?.competitions as Array<Record<string, unknown>> ?? []) {
        const competitors = comp?.competitors as Array<Record<string, unknown>> ?? [];
        if (competitors.length !== 2) continue;
        const home = competitors.find((c) => c.homeAway === "home");
        const away = competitors.find((c) => c.homeAway === "away");
        if (!home || !away) continue;
        const homeTeamName = ((home?.team as Record<string, unknown>)?.displayName as string ?? "").toLowerCase();
        const awayTeamName = ((away?.team as Record<string, unknown>)?.displayName as string ?? "").toLowerCase();
        const homeAbbrev = ((home?.team as Record<string, unknown>)?.abbreviation as string ?? "").toLowerCase();
        const awayAbbrev = ((away?.team as Record<string, unknown>)?.abbreviation as string ?? "").toLowerCase();
        const homeTeamNormalized = normalizeTeamName(homeTeamName);
        const awayTeamNormalized = normalizeTeamName(awayTeamName);
        const isHomeTeam = homeTeamName.includes(normalizedTeam) || normalizedTeam.includes(homeTeamName) || homeTeamNormalized === normalizedTeamForMatch || homeAbbrev === normalizedTeam;
        const isAwayTeam = awayTeamName.includes(normalizedTeam) || normalizedTeam.includes(awayTeamName) || awayTeamNormalized === normalizedTeamForMatch || awayAbbrev === normalizedTeam;
        if (isHomeTeam) return String((away?.team as Record<string, unknown>)?.id ?? "");
        if (isAwayTeam) return String((home?.team as Record<string, unknown>)?.id ?? "");
      }
    }
    return null;
  } catch (_e) { return null; }
}

// --- Player Data Fetching ---

async function fetchPlayerDataCached(playerName: string): Promise<CachedPlayerData | null> {
  const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const EDT_OFF = 4 * 60 * 60 * 1000;
  const cacheDate = new Date(Date.now() - EDT_OFF).toISOString().slice(0, 10).replace(/-/g, "");
  try {
    const cacheUrl = SUPA_URL + "/rest/v1/player_data_cache?player_name=eq." + encodeURIComponent(playerName) + "&cache_date=eq." + cacheDate + "&select=data&limit=1";
    const cacheRes = await fetch(cacheUrl, { headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY } });
    if (cacheRes.ok) {
      const rows = await cacheRes.json();
      if (rows.length > 0 && rows[0].data) return rows[0].data as CachedPlayerData;
    }
  } catch (_e) { /* cache miss */ }
  const data = await fetchPlayerDataWithTimeout(playerName);
  if (data) {
    try {
      fetch(SUPA_URL + "/rest/v1/player_data_cache", {
        method: "POST",
        headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({ player_name: playerName, cache_date: cacheDate, data }),
      });
    } catch (_e) { /* non-critical */ }
  }
  return data;
}

async function fetchPlayerDataWithTimeout(playerName: string): Promise<CachedPlayerData | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const timeoutPromise = new Promise<null>((resolve) => { setTimeout(() => resolve(null), ESPN_FETCH_TIMEOUT_MS); });
    const fetchPromise = (async (): Promise<CachedPlayerData | null> => {
      const player = await searchPlayer(playerName, "basketball", ESPN_FETCH_TIMEOUT_MS);
      if (!player) return null;
      const gameLog = await fetchGameLog(player.id, "basketball", ESPN_FETCH_TIMEOUT_MS);
      if (!gameLog.length) return null;
      const minutesTrend = calculateMinutesTrend(gameLog);
      return { player, gameLog, minutesTrend };
    })();
    const result = await Promise.race([fetchPromise, timeoutPromise]);
    if (result) return result;
    if (attempt === 1) console.log("[espn] Retry for " + playerName);
  }
  return null;
}

// --- Score a single prop (both sides, pick better one) ---

async function scoreProp(
  playerData: CachedPlayerData, prop: ExtractedProp,
  edgeData: { b2b: { isBackToBack: boolean; restDays: number }; oppStats: OpponentStats | null },
  weights: ScoringWeights,
  helpers: ScoreOneSideHelpers,
): Promise<PropAnalysisResult | null> {
  // D-155: weights + helpers passed through to imported scoreOneSide.
  const overResult = await scoreOneSide(playerData, prop, edgeData, "over", weights, helpers);
  const underResult = await scoreOneSide(playerData, prop, edgeData, "under", weights, helpers);
  if (!overResult && !underResult) return null;
  if (!overResult) return underResult;
  if (!underResult) return overResult;
  if (underResult.confidence > overResult.confidence) return underResult;
  return overResult;
}


// --- Gemini AI Analysis ---

async function getGeminiAnalysis(data: {
  playerName: string; team: string; propType: string; pickSide: string; line: number; odds: number;
  seasonAvg: number; recentAvg: number; floor: number; ceiling: number; confidence: number;
  last5Values: number[]; hitRates: { l5: string; l10: string }; isHome: boolean;
  opponent?: string; oppStats?: { pointsAllowedPerGame: number; reboundsAllowedPerGame: number; assistsAllowedPerGame: number; defenseRank: string; pace?: number; defensiveRating?: number } | null;
  absenceInfo?: AbsenceInfo | null; teamInjuries?: string[]; opponentInjuries?: string[];
  projectedStat?: number; zScore?: number; projectedMinutes?: number; perMinRate?: number;
  roleChange?: string; minutesStability?: string; consistency?: string;
}): Promise<string | null> {
  const last5Str = data.last5Values.join(", ");
  const homeAway = data.isHome ? "HOME" : "AWAY";
  const absenceLine = data.absenceInfo ? `- RECENT ABSENCE: Player missed approximately ${data.absenceInfo.gamesEstimate} games (${data.absenceInfo.daysGap}-day gap between ${data.absenceInfo.fromDate} and ${data.absenceInfo.toDate})` : "";
  const teamInjuriesStr = data.teamInjuries && data.teamInjuries.length > 0 ? data.teamInjuries.join("\n  ") : "None reported";
  const oppInjuriesStr = data.opponentInjuries && data.opponentInjuries.length > 0 ? data.opponentInjuries.join("\n  ") : "None reported";
  const normalizedProp = data.propType.replace("player_", "").toLowerCase();
  let oppStatValue = 0, oppStatLabel = "PPG";
  if (data.oppStats) {
    if (normalizedProp === "points") { oppStatValue = data.oppStats.pointsAllowedPerGame; oppStatLabel = "PPG allowed"; }
    else { oppStatValue = 0; oppStatLabel = ""; }
  }

  // Build projection context from real data
  const projLine = data.projectedStat && data.projectedStat > 0
    ? `Our model projects ${data.projectedStat.toFixed(1)} ${normalizedProp} (line is ${data.line}). Z-score: ${(data.zScore ?? 0).toFixed(1)} (positive = projects above line).`
    : "";
  const projMinsLine = data.projectedMinutes && data.projectedMinutes > 0
    ? `Projected ${data.projectedMinutes.toFixed(0)} minutes at ${(data.perMinRate ?? 0).toFixed(2)} ${normalizedProp}/min.`
    : "";
  const roleLine = data.roleChange && data.roleChange !== "none"
    ? `ROLE CHANGE: ${data.roleChange} detected.`
    : "";
  const stabilityLine = data.minutesStability || "";
  const consistencyLine = data.consistency || "";

  // Build opponent matchup stats for ALL prop types
  let oppMatchupLine = "";
  if (data.oppStats) {
    const parts: string[] = [];
    if (data.oppStats.pointsAllowedPerGame > 0) parts.push("PPG allowed: " + data.oppStats.pointsAllowedPerGame.toFixed(1));
    if (data.oppStats.reboundsAllowedPerGame > 0) parts.push("RPG allowed: " + data.oppStats.reboundsAllowedPerGame.toFixed(1));
    if (data.oppStats.assistsAllowedPerGame > 0) parts.push("APG allowed: " + data.oppStats.assistsAllowedPerGame.toFixed(1));
    if (data.oppStats.pace && data.oppStats.pace > 0) parts.push("Pace: " + data.oppStats.pace.toFixed(1));
    if (data.oppStats.defensiveRating && data.oppStats.defensiveRating > 0) parts.push("Def Rating: " + data.oppStats.defensiveRating.toFixed(1));
    parts.push("Rank: " + (data.oppStats.defenseRank ?? "unknown"));
    oppMatchupLine = parts.join(" | ");
  }

  const prompt = `You are a sharp NBA analyst writing a 2-sentence betting note. Use the PROJECTION and MATCHUP data below — do not make up stats.

PICK: ${data.playerName} (${data.team}) | ${data.propType} ${data.pickSide.toUpperCase()} ${data.line} | ${homeAway} vs ${data.opponent ?? "Unknown"}

PROJECTION MODEL:
${projLine || "No projection available."}
${projMinsLine || ""}
${roleLine}
${stabilityLine}
${consistencyLine}

OPPONENT DEFENSIVE PROFILE (${data.opponent ?? "Unknown"}):
${oppMatchupLine || "No defensive data available."}

${absenceLine}
TEAMMATE INJURIES: ${teamInjuriesStr}
OPPONENT INJURIES: ${oppInjuriesStr}

Write exactly 2 sentences:

SENTENCE 1 — THE EDGE OR THE RISK: Using the projection and opponent data above, explain WHY this ${data.pickSide.toUpperCase()} has an edge OR why it's risky. Reference specific numbers from the data (e.g. "projects 26.3 against a team allowing 118 PPG" or "only 0.42 ${normalizedProp}/min makes clearing ${data.line} unlikely"). Do NOT invent stats not listed above.

SENTENCE 2 — VERDICT: One sentence ending with TAKE, LEAN, or FADE. Name the single biggest factor driving your call.

ABSOLUTE RULES:
- ONLY reference stats provided above. Do NOT invent pace tendencies, coaching schemes, defensive strategies, hit rates, denominators, percentages, or any sample-size claim that isn't shown above.
- DATA INTEGRITY: if you cite a window (season, L5, L10, recent), the data must come verbatim from the inputs. Never say "season hit rate" unless a season-labeled hit rate is in the data. Subscribers verify our claims against external sources — mislabeling breaks trust.
- NEVER start with "With [player] out" — injuries are listed, the reader sees them.
- NEVER say "average defense/matchup" — use the actual numbers or skip it.
- NEVER restate hit rates or last 5 values — the reader already sees those.
- If the projection model has no data, focus on the opponent defensive profile numbers.
- Vary your opening — never start two analyses the same way.

No markdown, no asterisks, no disclaimers.`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const requestBody = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 200, temperature: 0.9 } };
  try {
    let result = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
    let text = await result.text();
    if (result.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      const retry = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
      text = await retry.text();
      if (retry.status !== 200) return null;
    } else if (result.status !== 200) return null;
    const json = JSON.parse(text);
    const content = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    return content ? content.replace(/\*\*/g, '').replace(/\*/g, '').replace(/##/g, '').replace(/#/g, '').trim() : null;
  } catch (_e) { return null; }
}

// --- Claude Sonnet Analysis Engine ---

// D-273-FOLLOWUP-HALLUCINATION (2026-05-20): persona rewrites to stop
// model from inventing rest/B2B/court-level details. Pre-fix personas
// primed "rest" + "pace" + "rotations" → audit found 16% NBA SUSPECT
// rate when score_rest=0 (i.e. those values weren't in breakdown).
// New personas describe voice + tone only; specific data categories
// must come from the PICK block per RULE 0 in the prompt body.
const ANALYST_PERSONAS = [
  "You are a sharp sports bettor writing for a premium betting Discord. Be direct, opinionated, use conviction language. Use game counts not percentages (say 'hit in 4 of 5' not '80%'). No hedging.",
  "You are a former NBA player turned analyst. Keep it real and grounded. Reference ONLY the matchup context listed in the PICK block — never invent rest, rotations, or defensive schemes that aren't provided.",
  "You are a quantitative sports analyst. Lead with projection edge and sample size from the PICK block. Use only the metrics explicitly listed — never invent regression, variance, or other stats not provided. Precise but readable.",
  "You are a veteran no-BS handicapper. Cut through the noise. Short, punchy, opinionated. Reference only what's in the PICK block; if the line looks off relative to the projection, say so plainly.",
];

function getPersonaIndex(name: string, date: string): number {
  let h = 0;
  const s = name + date;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return Math.abs(h) % ANALYST_PERSONAS.length;
}

// D-168 (May 14, 2026): AI verdict alignment.
//
// Sonnet (and the template fallbacks) end each analysis with TAKE / LEAN /
// FADE. The algorithm independently produces an Elite/Strong/Good/Lean/Pass
// verdict via getScoreLabel(finalScore). When they disagree, the subscriber
// sees mixed signals — D-148 §15.10 #5/#7/#10 trust-surface bug.
//
// Approach C: prompt-bias the AI toward agreement (in the prompts themselves)
// AND log mismatches to error_log post-hoc for CEO observability. We do NOT
// rewrite AI text — subscriber sees the honest AI take. The log gives CEO
// a quarterly diff to tune the prompts.
//
// Tier expectation (only Good+ get AI):
//   Elite (90+) / Strong (80+) → TAKE expected
//   Good (70-79)               → TAKE or LEAN acceptable
function extractAIVerdictServer(prose: string | null | undefined): "TAKE" | "LEAN" | "FADE" | null {
  if (!prose) return null;
  const tail = prose.slice(-160).toUpperCase();
  const tokens: Array<"TAKE" | "LEAN" | "FADE"> = [];
  for (const m of tail.matchAll(/\b(TAKE|LEAN|FADE)\b/g)) {
    tokens.push(m[1] as "TAKE" | "LEAN" | "FADE");
  }
  if (tokens.length === 0) return null;
  // Mirror src/lib/ai_verdict.ts: conservative bias FADE > LEAN > TAKE on collision.
  if (tokens.includes("FADE")) return "FADE";
  if (tokens.includes("LEAN")) return "LEAN";
  return "TAKE";
}

// Returns severity of mismatch or null when aligned. Severity drives whether
// we log "warning" (real divergence) or "debug" (mild divergence).
function classifyVerdictAlignment(
  algoConfidence: number,
  aiVerdict: "TAKE" | "LEAN" | "FADE" | null,
): "aligned" | "mild" | "mismatch" | "no_ai_verdict" {
  if (aiVerdict === null) return "no_ai_verdict";
  // Elite / Strong: expect TAKE.
  if (algoConfidence >= 80) {
    if (aiVerdict === "TAKE") return "aligned";
    if (aiVerdict === "LEAN") return "mild";
    return "mismatch"; // FADE on 80+ — strong divergence
  }
  // Good (70-79): TAKE or LEAN acceptable.
  if (algoConfidence >= 70) {
    if (aiVerdict === "TAKE" || aiVerdict === "LEAN") return "aligned";
    return "mismatch"; // FADE on 70-79
  }
  // < 70 not AI-analyzed in production. If we ever see it, treat as aligned
  // because the gate prevents this branch.
  return "aligned";
}

async function logVerdictMismatch(
  algoConfidence: number,
  algoLabel: string,
  aiVerdict: "TAKE" | "LEAN" | "FADE" | null,
  severity: "warning" | "debug",
  context: { player?: string; prop?: string; line?: number; pickSide?: string; engine: string },
): Promise<void> {
  await logErrorStructured(severity, {
    function_name: "process-games",
    phase: "ai-verdict-reconcile",
    error_type: "ai_verdict_mismatch",
    message: `Algo=${algoLabel}(${algoConfidence}) vs AI=${aiVerdict ?? "NONE"} via ${context.engine}`,
    payload: {
      algo_confidence: algoConfidence,
      algo_label: algoLabel,
      ai_verdict: aiVerdict,
      severity_tier: severity,
      player: context.player,
      prop: context.prop,
      line: context.line,
      pick_side: context.pickSide,
      engine: context.engine,
    },
  });
}

// D-171 (May 14, 2026): shared helper composing extract + classify + log.
// Reused by player path (D-168) AND game path (D-171). errorType lets the
// caller distinguish ai_verdict_mismatch (player) vs ai_verdict_mismatch_game
// when querying error_log by type.
async function reconcileAndLogVerdict(
  aiText: string | null | undefined,
  algoConfidence: number,
  algoLabel: string,
  errorType: "ai_verdict_mismatch" | "ai_verdict_mismatch_game",
  context: { player?: string; prop?: string; line?: number; pickSide?: string; engine: string; matchup?: string },
): Promise<void> {
  try {
    const aiVerdict = extractAIVerdictServer(aiText);
    const align = classifyVerdictAlignment(algoConfidence, aiVerdict);
    if (align !== "mismatch" && align !== "mild") return;
    const severity: "warning" | "debug" = align === "mismatch" ? "warning" : "debug";
    await logErrorStructured(severity, {
      function_name: "process-games",
      phase: "ai-verdict-reconcile",
      error_type: errorType,
      message: `Algo=${algoLabel}(${algoConfidence}) vs AI=${aiVerdict ?? "NONE"} via ${context.engine}`,
      payload: {
        algo_confidence: algoConfidence,
        algo_label: algoLabel,
        ai_verdict: aiVerdict,
        severity_tier: severity,
        player: context.player,
        prop: context.prop,
        line: context.line,
        pick_side: context.pickSide,
        engine: context.engine,
        matchup: context.matchup,
      },
    });
  } catch (_e) { /* observability must not break the caller */ }
}

async function getSonnetAnalysis(result: PropAnalysisResult, gameDate: string): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const bd = result.breakdown || {};
  const pd = result.projectionData;
  const prop = result.propType.replace("player_", "");
  const opponent = result.opponent || "the opponent";
  // D-397: NBA coach map removed (stale-data Popovich hallucination class).
  // oppCoach declaration deleted along with the prompt line below.
  const teamInj = getKeyInjuries(result.team || "");
  const oppInj = getKeyInjuries(opponent);
  const persona = ANALYST_PERSONAS[getPersonaIndex(result.playerName, gameDate)];
  const edgeVal = pd?.projectedStat ? (result.pickSide === "over" ? pd.projectedStat - result.line : result.line - pd.projectedStat) : 0;
  const keyFactors = Object.entries(bd).filter(([,v]) => typeof v === "number" && Math.abs(v as number) >= 3).map(([k,v]) => k + "=" + v).join(", ");

  // Tier 1 Fix #2 (May 11, 2026): hit-rate denominators are now explicit
  // (X/N for every window) so the AI cannot reverse-engineer a percentage
  // back to an invented "X in N" framing with the wrong N. The "season"
  // line previously passed only "%" — Sonnet, told to use game counts
  // (rule 2), backfilled "60%" as "6 in 10" and mislabeled it as season.
  // Now season carries its actual hits/total + gamesPlayed sample size.
  const gp = result.gamesPlayed ?? 0;
  const seasonHits = result.hitRatesRaw?.seasonHits ?? 0;
  const seasonTotal = result.hitRatesRaw?.seasonTotal ?? gp;
  // D-168 (May 14, 2026): inject algorithm verdict + alignment bias.
  // Approach C, prompt half — biases Sonnet to align with the algorithm
  // unless it finds specific data reasons to disagree.
  const algoConfidence_d168 = result.confidence;
  const algoLabel_d168 = result.verdict || "Pass";
  const expectedAlignment_d168 =
    algoConfidence_d168 >= 80 ? "TAKE (Elite/Strong tier)"
    : algoConfidence_d168 >= 70 ? "TAKE or LEAN (Good tier)"
    : "LEAN or FADE (sub-Good tier)";
  const prompt = `${persona}

PICK DATA:
- Player: ${result.playerName} (${result.team})
- Prop: ${prop} ${result.pickSide} ${result.line} at ${result.odds > 0 ? "+" : ""}${result.odds}
- Projection: ${pd?.projectedStat?.toFixed(1) ?? "N/A"} in ${pd?.projectedMinutes?.toFixed(0) ?? "?"} min (edge: ${edgeVal.toFixed(1)})
- Z-Score: ${pd?.zScore?.toFixed(2) ?? "N/A"} | StdDev: ${pd?.statStdDev?.toFixed(1) ?? "N/A"}
- Hit rate vs this ${result.line} line — L5: ${result.hitRatesRaw?.l5Hits ?? "?"}/5 | L10: ${result.hitRatesRaw?.l10Hits ?? "?"}/10 | Season-to-date: ${seasonHits}/${seasonTotal}
- Stat averages — L5 avg: ${result.recentAvg?.toFixed(1) ?? "?"} | Season-to-date avg (${gp} games): ${result.seasonAvg?.toFixed(1) ?? "?"} | Floor (last 10): ${result.floor ?? "?"} | Ceiling (last 10): ${result.ceiling ?? "?"}
- Last 5 game values: [${result.last5Values?.join(", ") ?? ""}]
- Opponent: ${opponent}
- Opp defense: ${result.oppStats?.pointsAllowedPerGame ? result.oppStats.pointsAllowedPerGame.toFixed(1) + " PPG allowed (" + result.oppStats.defenseRank + ")" : "no data"}
- ${result.team} injuries: ${teamInj.length > 0 ? teamInj.join(", ") : "none"}
- ${opponent} injuries: ${oppInj.length > 0 ? oppInj.join(", ") : "none"}
- B2B: ${result.isBackToBack ? "Yes" : "No"} | Rest: ${result.restDays ?? "?"} days
- Key factors: ${keyFactors || "none dominant"}
- Algorithm verdict: ${algoLabel_d168} (confidence ${algoConfidence_d168}/100). Expected alignment: ${expectedAlignment_d168}. Your verdict should usually agree with the algorithm; only differ if you find specific data reasons that contradict it, and if you do differ, name the data point in your prose.

DATA INTEGRITY RULES (read first — violating these breaks subscriber trust):
- Cite ONLY stats explicitly listed above. Never invent denominators, sample sizes, percentages, or splits.
- Match labels exactly: "L5" means the 5-game window above. "L10" means the 10-game window. "Season-to-date" means the ${gp}-game window labeled above — do not call it "season" if you meant L10.
- If you reference a hit rate, the numerator and denominator must come verbatim from the corresponding line above. Do not back-convert a percentage to an invented "X in N".
- If a window is not provided (e.g., no L20 above), do not reference it.
- D-273-FOLLOWUP-HALLUCINATION: do NOT reference rest days, back-to-back, or pace UNLESS the values shown above are non-zero / non-"?". Only mention the rest factor when restDays is a real number AND meaningful (≤1 = on B2B; ≥3 = well-rested). Otherwise stay silent on rest.

WRITING RULES:
1. Argue for or critique the ${result.pickSide.toUpperCase()} at ${result.line}.
2. When citing hit rates, use the exact "X/N" form above — say "4 of 5" or "6 of 10" or "${seasonHits} of ${seasonTotal}". Never strip the denominator.
3. Reference the opponent by name with specific context.
4. Only mention injuries if they materially affect THIS pick.
5. SELF-CHECK before writing: do the L5/L10/season hit rates, projection, floor/ceiling, opponent defense, and key factors support the ${result.pickSide.toUpperCase()} side? The algorithm sees the same numbers you do. If you would conclude the other side is favored on the stats, do not invent reasons to disagree — the algorithm already weighted these. You may FADE on PRICE/JUICE/VALUE alone (e.g., "the projected edge does not justify -350 juice") but DO NOT contradict the stat-favored side. Narrative must be consistent with the stats; verdict may differ on price.
6. End with TAKE, LEAN, or FADE.
7. 3-4 sentences max. No markdown, no asterisks, no disclaimers.
8. Never start with the player's full name — vary your openings.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      // D-453: bump max_tokens 250 -> 350 to give the 3-4 sentence cap real headroom.
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 350, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { const errText = (await res.text()).substring(0, 500); console.log("[sonnet] API error: " + res.status + " " + errText); await logError("sonnet", "api_error", "Sonnet returned " + res.status + ": " + errText, { status: res.status, body: errText }); return null; }
    const data = await res.json();
    // D-463 — capture Anthropic usage block (best-effort; swallows errors).
    await logSonnetUsage("nba_player", "claude-sonnet-4-6", data.usage, {
      player: result.playerName,
      prop: prop,
      confidence: result.confidence,
    });
    const text = data.content?.[0]?.text;
    return text ? text.replace(/\*\*/g, "").replace(/\*/g, "").replace(/##/g, "").replace(/#/g, "").trim() : null;
  } catch (err) { await logError("sonnet", "catch", "Sonnet fetch crashed: " + String(err), {}); return null; }
}

async function getSonnetGameAnalysis(
  pickType: string, pickSide: string, line: number, confidence: number,
  breakdown: Record<string, number>, homeTeam: string, awayTeam: string,
  homeStats: any, awayStats: any, h2h?: { homeWins: number; awayWins: number }
): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const gd = new Date(Date.now() - 4*60*60*1000).toISOString().slice(0,10).replace(/-/g,"");
  const persona = ANALYST_PERSONAS[getPersonaIndex(homeTeam + awayTeam, gd)];
  // D-397: NBA coach map removed (stale-data Popovich hallucination class).
  // homeCoach/awayCoach declarations deleted along with the prompt line below.
  const homeInj = getKeyInjuries(homeTeam);
  const awayInj = getKeyInjuries(awayTeam);
  const sideLabel = pickType === "spread"
    ? (pickSide === "home" ? homeTeam + " " + (line > 0 ? "+" : "") + line : awayTeam + " " + (line > 0 ? "+" : "") + (-line))
    : (pickSide === "over" ? "Over " + line : "Under " + line);

  // D-168 (May 14, 2026): inject algorithm tier + alignment bias.
  const algoLabel_d168 =
    confidence >= 90 ? "Elite Pick"
    : confidence >= 80 ? "Strong Pick"
    : confidence >= 70 ? "Good Pick"
    : confidence >= 60 ? "Lean"
    : "Pass";
  const expectedAlignment_d168 =
    confidence >= 80 ? "TAKE (Elite/Strong tier)"
    : confidence >= 70 ? "TAKE or LEAN (Good tier)"
    : "LEAN or FADE (sub-Good tier)";

  // D-453: per-stat-line team-name anchoring (ports MLB pattern from
  // _shared/anthropic_mlb.ts:183-186) — prevents home/away inversion in
  // the narrative by attaching team name to every value rather than
  // relying on a generic "Home:" / "Away:" label.
  const prompt = `${persona}

GAME: ${awayTeam} @ ${homeTeam}
PICK: ${sideLabel} (${pickType}) | Confidence: ${confidence}/100
- Algorithm verdict: ${algoLabel_d168}. Expected alignment: ${expectedAlignment_d168}. Your verdict should usually agree; only differ if you find specific data reasons.
- Records: ${homeTeam} ${homeStats?.wins ?? "?"}-${homeStats?.losses ?? "?"} · ${awayTeam} ${awayStats?.wins ?? "?"}-${awayStats?.losses ?? "?"}
- L10: ${homeTeam} ${homeStats?.l10Wins ?? "?"}-${homeStats?.l10Losses ?? "?"} · ${awayTeam} ${awayStats?.l10Wins ?? "?"}-${awayStats?.l10Losses ?? "?"}
- PPG scored: ${homeTeam} ${homeStats?.ppgScored?.toFixed(1) ?? "?"} · ${awayTeam} ${awayStats?.ppgScored?.toFixed(1) ?? "?"}
- PPG allowed: ${homeTeam} ${homeStats?.ppgAllowed?.toFixed(1) ?? "?"} · ${awayTeam} ${awayStats?.ppgAllowed?.toFixed(1) ?? "?"}
- Point diff: ${homeTeam} ${homeStats?.pointDiff?.toFixed(1) ?? "?"} · ${awayTeam} ${awayStats?.pointDiff?.toFixed(1) ?? "?"}
- Rest: ${homeTeam} ${homeStats?.restDays ?? "?"}d · ${awayTeam} ${awayStats?.restDays ?? "?"}d
- H2H this season: ${homeTeam} ${h2h?.homeWins ?? 0} - ${awayTeam} ${h2h?.awayWins ?? 0}
- ${homeTeam} injuries: ${homeInj.length > 0 ? homeInj.join(", ") : "none"}
- ${awayTeam} injuries: ${awayInj.length > 0 ? awayInj.join(", ") : "none"}
- Key factors: ${JSON.stringify(breakdown)}

RULES:
0. Cite ONLY values provided above. Do not invent or estimate any statistic, player attribute, weather, injury, or context not listed. Do not reference rest, B2B, or coach style if those values aren't passed.
1. Argue for or critique the ${sideLabel} pick.
2. Reference both teams by name.
3. SELF-CHECK before writing: which team has the better record, the better point diff, the higher PPG-scored, the better PPG-allowed defense? The algorithm sees the same numbers you do. If you would conclude a different team is favored on the stats, do not invent reasons to disagree — the algorithm already weighted these. You may FADE on PRICE/JUICE/VALUE alone (e.g., "the projected edge does not justify -350 juice") but DO NOT contradict the stat-favored team. Narrative must be consistent with the stats; verdict may differ on price.
4. End with TAKE, LEAN, or FADE.
5. 3-4 sentences max. No markdown, no asterisks.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      // D-453: bump max_tokens 250 -> 350 to give the 3-4 sentence cap real headroom.
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 350, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) {
      // D-458: capture Anthropic response body for diagnosis (previously
      // only logged status to console).
      const errText = (await res.text()).substring(0, 500);
      console.log("[sonnet-game] API error: " + res.status + " " + errText);
      await logError("sonnet-game", "api_error", "Sonnet-game returned " + res.status + ": " + errText, { status: res.status, body: errText });
      return null;
    }
    const data = await res.json();
    // D-463 — capture Anthropic usage block (best-effort; swallows errors).
    await logSonnetUsage("nba_game", "claude-sonnet-4-6", data.usage, {
      pickType: pickType,
      pickSide: pickSide,
      line: line,
      confidence: confidence,
      matchup: awayTeam + " @ " + homeTeam,
    });
    const text = data.content?.[0]?.text;
    return text ? text.replace(/\*\*/g, "").replace(/\*/g, "").replace(/##/g, "").replace(/#/g, "").trim() : null;
  } catch (err) { console.log("[sonnet-game] Error: " + err); return null; }
}

// --- Game Sides & Totals ---

interface GameOdds {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  gameTime: string;
  spread?: { homeSpread: number; homeOdds: number; awaySpread: number; awayOdds: number };
  total?: { line: number; overOdds: number; underOdds: number };
}

interface TeamRecentStats {
  wins: number; losses: number;
  l5Record: string; l10Record: string;
  ppgScored: number; ppgAllowed: number;
  recentScores: number[];
  l10Wins?: number; l10Losses?: number;
  homeWins?: number; homeLosses?: number;
  awayWins?: number; awayLosses?: number;
  recentPPG?: number;
  pointDiff?: number;
  restDays?: number;
  strengthOfSchedule?: number;
  netRating?: number;
}

async function fetchTeamRecentStats(teamName: string): Promise<TeamRecentStats | null> {
  try {
    const searchName = teamName.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    const abbrev = TEAM_ABBREV[searchName];
    if (!abbrev) { console.log("[team-stats] No abbrev for: " + teamName); return null; }
    const teamId = TEAM_ESPN_IDS[abbrev] ?? "";
    if (!teamId) { console.log("[team-stats] No ESPN ID for: " + abbrev); return null; }
    const teamUrl = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/" + teamId;
    const teamRes = await quietFetch(teamUrl);
    let wins = 0, losses = 0, ppgScored = 0, ppgAllowed = 0;
    if (teamRes.ok && teamRes.text) {
      try {
        const teamData = JSON.parse(teamRes.text);
        const record = teamData.team?.record?.items?.[0]?.summary ?? "";
        if (record) { const parts = record.split("-"); wins = parseInt(parts[0]) || 0; losses = parseInt(parts[1]) || 0; }
      } catch (_e) { /* ignore */ }
    }
    const statsUrl = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/" + teamId + "/statistics";
    const statsRes = await quietFetch(statsUrl);
    if (statsRes.ok && statsRes.text) {
      try {
        const statsData = JSON.parse(statsRes.text);
        const statCategories = statsData.results?.stats?.categories ?? statsData.stats?.categories ?? [];
        for (const category of Array.isArray(statCategories) ? statCategories : []) {
          for (const stat of category.stats ?? []) {
            if ((stat.name ?? "") === "avgPoints") ppgScored = parseFloat(stat.value ?? stat.displayValue ?? "0") || 0;
          }
        }
      } catch (_e) { /* ignore */ }
    }
    let l10Wins = 0, l10Losses = 0, homeWins = 0, homeLosses = 0, awayWins = 0, awayLosses = 0;
    let recentPPG = 0, pointDiff = 0, restDays = 1;
    const recentScores: number[] = [];
    try {
      const bdlId = bdlTeamNameToId.get(searchName);
      if (bdlId && BALLDONTLIE_API_KEY) {
        const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
        const gamesUrl = "https://api.balldontlie.io/v1/games?team_ids[]=" + bdlId + "&seasons[]=2025&start_date=" + thirtyDaysAgo + "&per_page=25";
        const gamesRes = await fetch(gamesUrl, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
        if (gamesRes.ok) {
          const gamesData = await gamesRes.json();
          const games = (gamesData.data || []).filter((g: any) => g.status === "Final");
          games.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
          if (games.length > 0) {
            const lastGameDate = new Date(games[0].date);
            restDays = Math.max(1, Math.round((Date.now() - lastGameDate.getTime()) / (1000*60*60*24)));
          }
          const last10 = games.slice(0, 10);
          for (const g of last10) {
            const isHome = g.home_team?.id === bdlId;
            const ts = isHome ? g.home_team_score : g.visitor_team_score;
            const os = isHome ? g.visitor_team_score : g.home_team_score;
            if (ts > os) l10Wins++; else l10Losses++;
          }
          const last5 = games.slice(0, 5);
          let l5Total = 0;
          for (const g of last5) {
            const isHome = g.home_team?.id === bdlId;
            const ts = isHome ? g.home_team_score : g.visitor_team_score;
            l5Total += ts; recentScores.push(ts);
          }
          recentPPG = last5.length > 0 ? l5Total / last5.length : 0;
          let totalPD = 0;
          for (const g of games) {
            const isHome = g.home_team?.id === bdlId;
            const ts = isHome ? g.home_team_score : g.visitor_team_score;
            const os = isHome ? g.visitor_team_score : g.home_team_score;
            totalPD += (ts - os);
            if (isHome) { if (ts > os) homeWins++; else homeLosses++; }
            else { if (ts > os) awayWins++; else awayLosses++; }
          }
          pointDiff = games.length > 0 ? totalPD / games.length : 0;
        }
      }
    } catch (_e) { /* ignore */ }
    let netRating = ppgScored - ppgAllowed;
    let strengthOfSchedule = 0.5;
    try {
      const bdlId2 = bdlTeamNameToId.get(searchName);
      if (bdlId2 && BALLDONTLIE_API_KEY) {
        const advUrl = "https://api.balldontlie.io/v1/teamseasonaverages/advanced?season=2025&team_id=" + bdlId2;
        const advRes = await fetch(advUrl, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
        if (advRes.ok) {
          const advData = await advRes.json();
          if (advData.data?.[0]) netRating = advData.data[0].net_rating ?? netRating;
        }
        const standUrl = "https://api.balldontlie.io/v1/standings?season=2025";
        const standRes = await fetch(standUrl, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
        if (standRes.ok) {
          const standData = await standRes.json();
          const standMap = new Map<number, number>();
          for (const s of standData.data || []) {
            const gp = (s.wins || 0) + (s.losses || 0);
            standMap.set(s.team?.id || 0, gp > 0 ? s.wins / gp : 0.5);
          }
          const thirtyDaysAgo2 = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
          const sosUrl = "https://api.balldontlie.io/v1/games?team_ids[]=" + bdlId2 + "&seasons[]=2025&start_date=" + thirtyDaysAgo2 + "&per_page=15";
          const sosRes = await fetch(sosUrl, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
          if (sosRes.ok) {
            const sosData = await sosRes.json();
            const finals = (sosData.data || []).filter((g: any) => g.status === "Final");
            let oppWpSum = 0, oppCount = 0;
            for (const g of finals) {
              const isHome = g.home_team?.id === bdlId2;
              const oppId = isHome ? g.visitor_team?.id : g.home_team?.id;
              const oppWp = standMap.get(oppId);
              if (oppWp !== undefined) { oppWpSum += oppWp; oppCount++; }
            }
            if (oppCount > 0) strengthOfSchedule = oppWpSum / oppCount;
          }
        }
      }
    } catch (_e) { /* ignore */ }
    return { wins, losses, l5Record: l10Wins+"-"+l10Losses, l10Record: l10Wins+"-"+l10Losses, ppgScored, ppgAllowed, recentScores, l10Wins, l10Losses, homeWins, homeLosses, awayWins, awayLosses, recentPPG, pointDiff, restDays, strengthOfSchedule, netRating };
  } catch (e) {
    // D-158 (May 14, 2026): structured log — fetchTeamRecentStats outer
    // failure leaves SOS/recent-form/net-rating dark for that team. Silent
    // return-null previously hid ESPN schema regressions per-team.
    await logErrorStructured("warning", {
      function_name: "process-games",
      phase: "fetch-team-recent-stats",
      error_type: "team_recent_stats_failed",
      message: e instanceof Error ? e.message : String(e),
      payload: { teamName },
    });
    return null;
  }
}

function scoreGameSide(
  game: GameOdds, homeStats: TeamRecentStats | null, awayStats: TeamRecentStats | null,
  homeInjuries: string[], awayInjuries: string[],
  h2h?: { homeWins: number; awayWins: number }
): { side: string; team: string; spread: number; odds: number; confidence: number; breakdown: Record<string, number> } | null {
  if (!game.spread) return null;
  let score = 50;
  const breakdown: Record<string, number> = {};
  const homeWinPct = homeStats ? homeStats.wins / Math.max(1, homeStats.wins + homeStats.losses) : 0.5;
  const awayWinPct = awayStats ? awayStats.wins / Math.max(1, awayStats.wins + awayStats.losses) : 0.5;
  breakdown.winPctDiff = Math.round((homeWinPct - awayWinPct) * 20);
  const homePPG = homeStats?.ppgScored ?? 0;
  const awayPPG = awayStats?.ppgScored ?? 0;
  const homeDefPPG = homeStats?.ppgAllowed ?? 0;
  const awayDefPPG = awayStats?.ppgAllowed ?? 0;
  const expectedMargin = ((homePPG - awayDefPPG) - (awayPPG - homeDefPPG)) / 2 + 3;
  const spreadEdge = expectedMargin + game.spread.homeSpread;
  breakdown.spreadEdge = spreadEdge > 5 ? 10 : spreadEdge > 3 ? 7 : spreadEdge > 1 ? 4 : spreadEdge > 0 ? 2 : spreadEdge > -2 ? -2 : spreadEdge > -4 ? -5 : -8;
  const homeInjuryCount = homeInjuries.filter(i => i.includes("Out") || i.includes("Day-to-Day")).length;
  const awayInjuryCount = awayInjuries.filter(i => i.includes("Out") || i.includes("Day-to-Day")).length;
  const injuryDiff = awayInjuryCount - homeInjuryCount;
  breakdown.injuryImpact = injuryDiff >= 3 ? 6 : injuryDiff >= 1 ? 3 : injuryDiff <= -3 ? -6 : injuryDiff <= -1 ? -3 : 0;
  breakdown.homeCourt = 2;
  const homeL10WP = (homeStats?.l10Wins ?? 5) / Math.max(1, (homeStats?.l10Wins ?? 5) + (homeStats?.l10Losses ?? 5));
  const awayL10WP = (awayStats?.l10Wins ?? 5) / Math.max(1, (awayStats?.l10Wins ?? 5) + (awayStats?.l10Losses ?? 5));
  breakdown.l10Form = Math.round((homeL10WP - awayL10WP) * 12);
  const homeHWP = (homeStats?.homeWins ?? 0) / Math.max(1, (homeStats?.homeWins ?? 0) + (homeStats?.homeLosses ?? 1));
  const awayAWP = (awayStats?.awayWins ?? 0) / Math.max(1, (awayStats?.awayWins ?? 0) + (awayStats?.awayLosses ?? 1));
  breakdown.homeAwayRecord = Math.round((homeHWP - awayAWP) * 8);
  const pdDiff = (homeStats?.pointDiff ?? 0) - (awayStats?.pointDiff ?? 0);
  breakdown.pointDiffEdge = pdDiff > 8 ? 8 : pdDiff > 4 ? 5 : pdDiff > 2 ? 3 : pdDiff > 0 ? 1 : pdDiff > -2 ? -1 : pdDiff > -4 ? -3 : pdDiff > -8 ? -5 : -8;
  const restDiff = (homeStats?.restDays ?? 1) - (awayStats?.restDays ?? 1);
  breakdown.restAdvantage = restDiff >= 3 ? 5 : restDiff >= 1 ? 2 : restDiff <= -3 ? -5 : restDiff <= -1 ? -2 : 0;
  const homeTrend = homeStats?.recentPPG && homeStats?.ppgScored ? (homeStats.recentPPG - homeStats.ppgScored) : 0;
  const awayTrend = awayStats?.recentPPG && awayStats?.ppgScored ? (awayStats.recentPPG - awayStats.ppgScored) : 0;
  const trendDiff = homeTrend - awayTrend;
  breakdown.scoringTrend = trendDiff > 6 ? 3 : trendDiff > 3 ? 2 : trendDiff < -6 ? -3 : trendDiff < -3 ? -2 : 0;
  const h2hDiff = (h2h?.homeWins ?? 0) - (h2h?.awayWins ?? 0);
  breakdown.headToHead = h2hDiff >= 2 ? 4 : h2hDiff >= 1 ? 2 : h2hDiff <= -2 ? -4 : h2hDiff <= -1 ? -2 : 0;
  const sosDiff = (homeStats?.strengthOfSchedule ?? 0.5) - (awayStats?.strengthOfSchedule ?? 0.5);
  breakdown.strengthOfSchedule = sosDiff > 0.05 ? 3 : sosDiff > 0.02 ? 1 : sosDiff < -0.05 ? -3 : sosDiff < -0.02 ? -1 : 0;
  const nrDiff = (homeStats?.netRating ?? 0) - (awayStats?.netRating ?? 0);
  breakdown.netRating = nrDiff > 8 ? 6 : nrDiff > 4 ? 4 : nrDiff > 2 ? 2 : nrDiff > 0 ? 1 : nrDiff > -2 ? -1 : nrDiff > -4 ? -2 : nrDiff > -8 ? -4 : -6;
  score += Object.values(breakdown).reduce((a, b) => a + b, 0);
  score = Math.max(0, Math.min(100, score));
  const pickHome = score >= 50;
  return {
    side: pickHome ? "home" : "away",
    team: pickHome ? game.homeTeam : game.awayTeam,
    spread: pickHome ? game.spread.homeSpread : game.spread.awaySpread,
    odds: pickHome ? game.spread.homeOdds : game.spread.awayOdds,
    confidence: pickHome ? score : 100 - score,
    breakdown,
  };
}

function scoreGameTotal(
  game: GameOdds, homeStats: TeamRecentStats | null, awayStats: TeamRecentStats | null
): { side: "over" | "under"; total: number; odds: number; confidence: number; breakdown: Record<string, number> } | null {
  if (!game.total) return null;
  let score = 50;
  const breakdown: Record<string, number> = {};
  const combinedPPG = (homeStats?.ppgScored ?? 0) + (awayStats?.ppgScored ?? 0);
  const combinedDefPPG = (homeStats?.ppgAllowed ?? 0) + (awayStats?.ppgAllowed ?? 0);
  const expectedTotal = (combinedPPG + combinedDefPPG) / 2;
  const totalEdge = expectedTotal - game.total.line;
  breakdown.totalEdge = totalEdge > 8 ? 10 : totalEdge > 4 ? 7 : totalEdge > 2 ? 4 : totalEdge > 0 ? 2 : totalEdge > -2 ? -2 : totalEdge > -4 ? -5 : -8;
  const avgPPG = ((homeStats?.ppgScored ?? 0) + (awayStats?.ppgScored ?? 0)) / 2;
  breakdown.pace = avgPPG > 115 ? 5 : avgPPG > 110 ? 3 : avgPPG < 105 ? -3 : avgPPG < 100 ? -5 : 0;
  const avgDefPPG = ((homeStats?.ppgAllowed ?? 0) + (awayStats?.ppgAllowed ?? 0)) / 2;
  breakdown.defense = avgDefPPG > 115 ? 5 : avgDefPPG > 112 ? 3 : avgDefPPG < 108 ? -3 : avgDefPPG < 105 ? -5 : 0;
  const homeTTrend = homeStats?.recentPPG && homeStats?.ppgScored ? (homeStats.recentPPG - homeStats.ppgScored) : 0;
  const awayTTrend = awayStats?.recentPPG && awayStats?.ppgScored ? (awayStats.recentPPG - awayStats.ppgScored) : 0;
  const combTrend = homeTTrend + awayTTrend;
  breakdown.scoringTrend = combTrend > 8 ? 5 : combTrend > 4 ? 3 : combTrend > 0 ? 1 : combTrend > -4 ? -1 : combTrend > -8 ? -3 : -5;
  const avgRest = ((homeStats?.restDays ?? 2) + (awayStats?.restDays ?? 2)) / 2;
  breakdown.restImpact = avgRest <= 1 ? -3 : avgRest >= 3 ? 2 : 0;
  const combPD = (homeStats?.pointDiff ?? 0) + (awayStats?.pointDiff ?? 0);
  breakdown.pointDiffTotal = combPD > 10 ? 3 : combPD > 5 ? 2 : combPD < -10 ? -3 : combPD < -5 ? -2 : 0;
  const combL10W = (homeStats?.l10Wins ?? 5) + (awayStats?.l10Wins ?? 5);
  breakdown.l10Scoring = combL10W >= 14 ? 3 : combL10W >= 12 ? 1 : combL10W <= 6 ? -3 : combL10W <= 8 ? -1 : 0;
  const avgSOS = ((homeStats?.strengthOfSchedule ?? 0.5) + (awayStats?.strengthOfSchedule ?? 0.5)) / 2;
  breakdown.scheduleStrength = avgSOS > 0.55 ? -2 : avgSOS < 0.45 ? 2 : 0;
  const combNR = (homeStats?.netRating ?? 0) + (awayStats?.netRating ?? 0);
  breakdown.netRatingTotal = combNR > 10 ? 3 : combNR > 5 ? 1 : combNR < -10 ? -3 : combNR < -5 ? -1 : 0;
  score += Object.values(breakdown).reduce((a, b) => a + b, 0);
  score = Math.max(0, Math.min(100, score));
  const pickOver = score >= 50;
  return {
    side: pickOver ? "over" : "under",
    total: game.total.line,
    odds: pickOver ? game.total.overOdds : game.total.underOdds,
    confidence: pickOver ? score : 100 - score,
    breakdown,
  };
}

async function getGameGeminiAnalysis(data: {
  pickType: string; homeTeam: string; awayTeam: string; pickSide: string;
  line: number; odds: number; confidence: number; breakdown: Record<string, number>;
  homeInjuries: string[]; awayInjuries: string[];
  teamStats?: { home: any; away: any; h2h?: { homeWins: number; awayWins: number } };
}): Promise<string | null> {
  const sideLabel = data.pickType === "spread"
    ? (data.pickSide === "home" ? data.homeTeam + " " + (data.line > 0 ? "+" : "") + data.line : data.awayTeam + " " + (data.line > 0 ? "+" : "") + (-data.line))
    : (data.pickSide === "over" ? "Over " + data.line : "Under " + data.line);
  const homeInjStr = data.homeInjuries.length > 0 ? data.homeInjuries.join(", ") : "None reported";
  const awayInjStr = data.awayInjuries.length > 0 ? data.awayInjuries.join(", ") : "None reported";
  // Build human-readable breakdown instead of raw JSON
  const bd = data.breakdown;
  const breakdownLines: string[] = [];
  if (bd.winPctDiff) breakdownLines.push("Win% edge: " + (bd.winPctDiff > 0 ? "home" : "away") + " (" + Math.abs(bd.winPctDiff) + " pts)");
  if (bd.spreadEdge) breakdownLines.push("Spread edge: " + (bd.spreadEdge > 0 ? "favors home" : "favors away") + " (" + bd.spreadEdge + ")");
  if (bd.l10Form) breakdownLines.push("L10 form: " + (bd.l10Form > 0 ? "home better" : "away better") + " (" + bd.l10Form + ")");
  if (bd.pointDiffEdge) breakdownLines.push("Point diff edge: " + (bd.pointDiffEdge > 0 ? "home" : "away") + " (" + bd.pointDiffEdge + ")");
  if (bd.restAdvantage) breakdownLines.push("Rest: " + (bd.restAdvantage > 0 ? "home rested" : "away rested") + " (" + bd.restAdvantage + ")");
  if (bd.injuryImpact) breakdownLines.push("Injury impact: " + (bd.injuryImpact > 0 ? "away more hurt" : "home more hurt") + " (" + bd.injuryImpact + ")");
  if (bd.totalEdge) breakdownLines.push("Total edge vs line: " + (bd.totalEdge > 0 ? "over" : "under") + " (" + bd.totalEdge + ")");
  if (bd.pace) breakdownLines.push("Pace factor: " + (bd.pace > 0 ? "fast" : "slow") + " (" + bd.pace + ")");
  if (bd.defense) breakdownLines.push("Combined defense: " + (bd.defense > 0 ? "porous" : "strong") + " (" + bd.defense + ")");
  const breakdownStr = breakdownLines.length > 0 ? breakdownLines.join(". ") : "No strong factors";

  // Build team data context
  const pickTypeLabel = data.pickType === "spread" ? "SPREAD" : "TOTAL";
  const ts = data.teamStats;
  let teamDataStr = "";
  if (ts) {
    const h = ts.home;
    const a = ts.away;
    const lines: string[] = [];
    if (h) lines.push(data.homeTeam + " (HOME): " + (h.wins ?? 0) + "-" + (h.losses ?? 0) + " | PPG: " + (h.ppgScored?.toFixed(1) ?? "?") + " | Opp PPG: " + (h.ppgAllowed?.toFixed(1) ?? "?") + " | L10: " + (h.l10Wins ?? "?") + "-" + (h.l10Losses ?? "?") + " | Home: " + (h.homeWins ?? "?") + "-" + (h.homeLosses ?? "?") + " | Pt Diff: " + (h.pointDiff?.toFixed(1) ?? "?") + " | Rest: " + (h.restDays ?? "?") + "d | Net Rtg: " + (h.netRating?.toFixed(1) ?? "?"));
    if (a) lines.push(data.awayTeam + " (AWAY): " + (a.wins ?? 0) + "-" + (a.losses ?? 0) + " | PPG: " + (a.ppgScored?.toFixed(1) ?? "?") + " | Opp PPG: " + (a.ppgAllowed?.toFixed(1) ?? "?") + " | L10: " + (a.l10Wins ?? "?") + "-" + (a.l10Losses ?? "?") + " | Away: " + (a.awayWins ?? "?") + "-" + (a.awayLosses ?? "?") + " | Pt Diff: " + (a.pointDiff?.toFixed(1) ?? "?") + " | Rest: " + (a.restDays ?? "?") + "d | Net Rtg: " + (a.netRating?.toFixed(1) ?? "?"));
    if (ts.h2h) lines.push("H2H this season: " + data.homeTeam + " " + (ts.h2h.homeWins ?? 0) + " - " + (ts.h2h.awayWins ?? 0) + " " + data.awayTeam);
    teamDataStr = lines.join("\n");
  }

  const prompt = "You are a sharp NBA analyst writing a 2-sentence " + pickTypeLabel + " betting note. Use ONLY the data below.\n\n" +
    "MATCHUP: " + data.awayTeam + " @ " + data.homeTeam + "\n" +
    "PICK: " + sideLabel + " (" + (data.odds > 0 ? "+" : "") + data.odds + ")\n\n" +
    "TEAM DATA:\n" + (teamDataStr || "No team data available.") + "\n\n" +
    "SCORING FACTORS: " + breakdownStr + "\n\n" +
    data.homeTeam + " INJURIES: " + homeInjStr + "\n" +
    data.awayTeam + " INJURIES: " + awayInjStr + "\n\n" +
    "Write exactly 2 sentences:\n\n" +
    "SENTENCE 1 — THE EDGE: " + (data.pickType === "spread"
      ? "Using the TEAM DATA above, explain WHY this side covers. Reference specific numbers — records, PPG differential, home/away splits, point differential, or rest advantage. Do NOT invent coaching schemes or stats not listed above."
      : "Using the TEAM DATA above, explain WHY this game goes over or under. Reference combined PPG, defensive PPG allowed, and recent scoring trends from the data. Do NOT invent stats not listed above.") + "\n\n" +
    "SENTENCE 2 — VERDICT: Name the single biggest risk, then end with TAKE, LEAN, or FADE.\n\n" +
    "RULES:\n" +
    "- ONLY cite numbers from the data above. Do NOT invent stats or coaching tendencies.\n" +
    "- Players suspended or out ALL SEASON are not factors.\n" +
    "- No markdown, no asterisks, no disclaimers.";
  const apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_API_KEY;
  const requestBody = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 200, temperature: 0.7 } };
  try {
    let res = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
    let text = await res.text();
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      const retry = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
      text = await retry.text();
      if (retry.status !== 200) return null;
    } else if (res.status !== 200) return null;
    const json = JSON.parse(text);
    const result = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    return result ? result.replace(/\*\*/g, "").replace(/\*/g, "").replace(/##/g, "").replace(/#/g, "").trim() : null;
  } catch (_e) { return null; }
}

// --- Template Analysis Engine (Sports Analyst Voice) ---

// D-397 (2026-06-03): NBA_COACHES hand-maintained dictionary REMOVED.
// Per D-396 SHIP 1 Finding B: the map was stale (Popovich listed as
// Spurs HC long after he stepped back due to his 2024-25 stroke), and
// the prompt at the game-side Sonnet path piped that stale name+style
// directly into the model as fact. Sonnet faithfully repeated bad data
// we handed it — SAME CLASS as the Rozier-suspension hallucination.
// Eliminating the data source at the root kills the entire class.
// Template fallback prose paths (generatePlayerAnalysis below, and the
// game-analysis generator after it) call getCoachInfo() and have
// existing null-handling branches (oppCoach ? "..." : "..." patterns);
// with the map gone, getCoachInfo() always returns null and those
// branches gracefully use their fallback prose ("the coaching staff's",
// "the opposing coach", etc.).

function getKeyInjuries(teamName: string): string[] {
  const key = teamName.toLowerCase();
  const injuries = bdlInjuriesByTeam.get(key) || [];
  return injuries
    .filter(inj => inj.status === "Out" || inj.status === "Day-To-Day")
    .map(inj => inj.playerName + " (" + inj.status + ")");
}

// D-397: kept the function signature for the template-fallback callers
// below. Always returns null now that NBA_COACHES is gone. Existing
// `oppCoach ? "..." : "fallback"` null-handling branches in callers
// will fire the fallback prose path automatically.
function getCoachInfo(_teamName: string): { name: string; style: string } | null {
  return null;
}

function generatePlayerAnalysis(result: PropAnalysisResult): string {
  const bd = result.breakdown || {};
  const pd = result.projectionData;
  const prop = result.propType.replace("player_", "");
  const side = result.pickSide;
  const line = result.line;
  const name = result.playerName.split(" ").pop() || result.playerName;
  const fullName = result.playerName;
  const opponent = result.opponent || "the opponent";
  const oppCoach = getCoachInfo(opponent);
  const oppDef = result.oppStats;
  const teamInjuries = getKeyInjuries(result.team || "");

  const projGap = pd?.projectedStat ? (side === "over" ? pd.projectedStat - line : line - pd.projectedStat) : 0;
  const projStat = pd?.projectedStat ?? 0;
  const projMins = pd?.projectedMinutes ?? 0;
  const floor = result.floor ?? 0;
  const ceiling = result.ceiling ?? 0;
  const floorScore = bd.floorCeiling ?? 0;
  const consistScore = bd.consistencyBonus ?? 0;
  // D-243 (2026-05-19): minutesFloorBonus deleted from scoring.ts (was dead code).
  // Rewire volatile-minutes warning UX to read minutesStabilityBonus (spread >= 15
  // produces stabilityBonus = -3, same condition that previously made minsFloorScore
  // negative via isVolatile).
  const minsFloorScore = bd.minutesStabilityBonus ?? 0;
  const staleScore = bd.staleDataPenalty ?? 0;
  const injuryScore = bd.playerInjuryPenalty ?? 0;
  const roleScore = bd.roleChangeBonus ?? 0;
  const regrScore = bd.regressionBonus ?? 0;
  const marketScore = bd.marketConfBonus ?? 0;
  const b2bScore = bd.backToBack ?? 0;
  const formScore = bd.recentForm ?? 0;

  // Build opponent context
  let oppContext = "";
  if (oppDef && oppDef.pointsAllowedPerGame > 0 && prop === "points") {
    const ppg = oppDef.pointsAllowedPerGame;
    const rank = ppg >= 116 ? "a bottom-tier defense" : ppg >= 112 ? "a middle-of-the-pack defense" : ppg <= 108 ? "one of the stingiest defenses in the league" : "a solid defensive unit";
    oppContext = oppCoach
      ? `against ${oppCoach.name}'s ${opponent}, ${rank} allowing ${ppg.toFixed(1)} PPG`
      : `against ${opponent}, ${rank} at ${ppg.toFixed(1)} PPG allowed`;
  } else if (oppDef && oppDef.reboundsAllowedPerGame > 0 && prop === "rebounds") {
    oppContext = `against ${opponent}, who allow ${oppDef.reboundsAllowedPerGame.toFixed(1)} RPG`;
  } else if (oppDef && oppDef.assistsAllowedPerGame > 0 && prop === "assists") {
    oppContext = `against ${opponent}, who surrender ${oppDef.assistsAllowedPerGame.toFixed(1)} APG`;
  } else if (oppCoach) {
    oppContext = `against ${oppCoach.name}'s ${opponent}`;
  } else {
    oppContext = `against ${opponent}`;
  }

  // Build injury impact note (side-aware: usage boost helps overs, hurts unders).
  // Strip trailing "(Status)" suffix from teamInjuries entries before inlining them
  // into prose — otherwise "Jalen Duren (Out)" + " out" renders as "Jalen Duren (Out) out".
  const injuryNames = teamInjuries.map(i => i.replace(/\s*\([^)]*\)\s*$/, "").trim()).filter(Boolean);
  let injuryNote = "";
  if (injuryNames.length >= 2) {
    if (side === "over") {
      injuryNote = ` With ${injuryNames.slice(0, 2).join(" and ")} sidelined, ${name} should see elevated usage — more touches, more opportunities.`;
    } else {
      injuryNote = ` The wrinkle: ${injuryNames.slice(0, 2).join(" and ")} being out could funnel more volume to ${name}, which works against the under.`;
    }
  } else if (injuryNames.length === 1) {
    if (side === "over") {
      injuryNote = ` With ${injuryNames[0]} out, ${name}'s role expands — more usage supports the over.`;
    } else {
      injuryNote = ` Keep an eye on ${injuryNames[0]} being out — ${name} could absorb extra volume, which adds risk to the under.`;
    }
  }

  // --- NARRATIVES (priority order) ---

  // LOCK: projection + consistency + floor
  if (projGap > 2.5 && consistScore >= 2 && floorScore >= 4) {
    if (side === "under") {
      return `${fullName} projects for just ${projStat.toFixed(1)} ${prop} in ${projMins.toFixed(0)} minutes ${oppContext} — that's ${projGap.toFixed(1)} points of cushion below the ${line} line. His consistency makes this one of the most bankable unders on the board — even on a good night, his ceiling doesn't threaten this number.${injuryNote} TAKE.`;
    } else {
      return `${fullName} projects for ${projStat.toFixed(1)} ${prop} ${oppContext}, with a floor of ${floor} that already flirts with the ${line} line — ${projGap.toFixed(1)} points of projection edge backed by rock-solid consistency.${injuryNote} TAKE.`;
    }
  }

  // AUTO-HIT: floor/ceiling dominates
  if (floorScore >= 10) {
    if (side === "over") {
      return `${name}'s worst game in his last 10 was ${floor} ${prop} — that already clears the ${line} line ${oppContext}. You're betting on him to NOT have the worst game of his recent stretch.${injuryNote} TAKE.`;
    } else {
      return `${name} has topped out at ${ceiling} ${prop} in his last 10 games ${oppContext} — he literally hasn't reached ${line} even on his best night.${injuryNote} TAKE.`;
    }
  }

  // PROJECTION GAP: strong projection, not a lock
  if (projGap > 2 && projStat > 0) {
    let riskLine = "";
    if (consistScore <= -3) riskLine = ` The concern is volatility — ${name} is boom-or-bust in this stat, so one big quarter could swing it.`;
    else if (regrScore <= -3) riskLine = ` The catch: he's been running hot, and regression could pull him back toward the line.`;
    else if (b2bScore <= -3) riskLine = ` Factor in back-to-back fatigue and this edge thins out.`;
    else if (minsFloorScore <= -3) riskLine = ` Volatile minutes are the wild card — a short night wipes out the projection.`;

    if (side === "under") {
      return `${fullName} projects for just ${projStat.toFixed(1)} ${prop} in ${projMins.toFixed(0)} minutes ${oppContext} — the model sees ${projGap.toFixed(1)} points of daylight below the ${line} line.${riskLine}${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    } else {
      return `The projection has ${fullName} at ${projStat.toFixed(1)} ${prop} ${oppContext}, clearing the ${line} line by ${projGap.toFixed(1)} — that's real edge, not noise.${riskLine}${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    }
  }

  // STALE: extended absence
  if (staleScore <= -15) {
    return `${fullName} is working his way back from an extended absence ${oppContext} — conditioning, role, and minutes are all question marks right now. ${side === "under" ? "The under makes sense as a hedge against a slow return" : "Banking on immediate production after a long layoff is risky"}. LEAN.`;
  }
  if (staleScore <= -5) {
    return `${name} just returned from a multi-week absence and draws ${opponent} tonight — the stats look good on paper, but early-return games are notoriously unpredictable. ${side === "under" ? "Lean under until he proves he's back to full speed" : "Give it another game before trusting the over"}. LEAN.`;
  }

  // INJURY: player on injury report
  if (injuryScore <= -15) {
    return `${fullName} is carrying a significant injury designation heading into tonight ${oppContext} — if he plays, expect limited minutes and a cautious approach. ${side === "under" ? "The under is the right side but game-time decisions add volatility" : "Chasing an over on a banged-up player is asking for trouble"}. LEAN.`;
  }

  // ROLE CHANGE
  if (roleScore >= 4) {
    return `${name}'s minutes have jumped 30%+ over the last three games ${oppContext} — that's not a blip, that's a role change. More court time means more ${prop} opportunities, and the line hasn't caught up yet.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
  }
  if (roleScore <= -4) {
    return `${name}'s minutes have dropped 30%+ recently — whether it's ${oppCoach ? oppCoach.name + "'s" : "the coaching staff's"} decision or matchup-based, the reduced role caps his ${prop} ceiling. ${side === "under" ? "The under benefits from the minutes squeeze." : "Hard to trust the over when court time is shrinking."} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
  }

  // REGRESSION
  if (regrScore >= 3) {
    if (side === "over") {
      return `${name} has been running cold in ${prop} — 20%+ below his season average — but the track record says bounce-back is coming ${oppContext}. The line hasn't adjusted for the expected regression.${injuryNote} LEAN.`;
    } else {
      return `${name}'s recent ${prop} production has dropped off significantly from his season norm ${oppContext} — regression says this slump continues, making the under the natural play.${injuryNote} LEAN.`;
    }
  }

  // MARKET TRAP
  if (marketScore <= -3) {
    return `The L5 hit rate on this ${prop} prop looks perfect, but don't get baited ${oppContext} — when a player hits 100% over five games, the line has already moved to price it in. FADE.`;
  }

  // COLD BUY
  if (marketScore >= 2) {
    return `${name}'s been cold recently in ${prop}, but his L10 track record is solid ${oppContext} — the line may be lagging behind, creating a value window.${injuryNote} LEAN.`;
  }

  // BACK TO BACK
  if (b2bScore <= -3) {
    return `Second night of a back-to-back on the road for ${name} ${oppContext} — fatigue suppresses production across the board, and ${oppCoach ? oppCoach.name : "the opposing coach"} will look to exploit tired legs. ${side === "under" ? "The under is the right lean in a fatigue spot." : "Risky to chase overs in B2B away games."} LEAN.`;
  }

  // FORM: hot or cold (side-aware)
  if (formScore >= 8) {
    if (side === "over") {
      const regrRisk = regrScore <= -3 ? ` The caveat: he's 20%+ above his season norm, and regression could pull him back.` : "";
      return `${name} is locked in right now — his recent ${prop} production is running well above his season average ${oppContext}, and that kind of momentum carries.${regrRisk}${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    } else {
      return `${name}'s recent ${prop} output has dropped off noticeably from his season pace ${oppContext} — the downward trend makes the under a natural play.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    }
  }
  if (formScore <= -8) {
    if (side === "under") {
      return `${name} has been in a funk — trending 15%+ below his season norm in ${prop} ${oppContext}. The cold stretch says lean under until he breaks out.${injuryNote} LEAN.`;
    } else {
      return `${name} has been struggling in ${prop} recently, but the season-long numbers support a bounce-back ${oppContext}.${injuryNote} LEAN.`;
    }
  }

  // CONSISTENCY PLAY
  if (consistScore >= 3 && floorScore >= 3) {
    return `${name} is one of the most consistent ${prop} producers in the league right now ${oppContext} — low variance, stable minutes, and a floor that supports the ${side}. This is a grind-it-out play, not a splash, but those are the ones that cash.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
  }

  // MATCHUP-DRIVEN
  if (oppDef) {
    if (prop === "points" && oppDef.pointsAllowedPerGame >= 116 && side === "over") {
      return `${name} draws ${oppContext} — an elevated-scoring environment where even average players can pop. The matchup confirms the over.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    }
    if (prop === "points" && oppDef.pointsAllowedPerGame <= 108 && side === "under") {
      return `${name} faces ${oppContext} tonight — scoring will be hard to come by. He'd need an outlier to clear ${line}.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    }
    if (prop === "rebounds" && oppDef.reboundsAllowedPerGame >= 45 && side === "over") {
      return `${name} draws ${oppContext} tonight — extra boards are there for the taking on the offensive glass.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    }
    if (prop === "assists" && oppDef.assistsAllowedPerGame >= 27 && side === "over") {
      return `${name} faces ${oppContext} tonight — the kind of breakdowns that create easy assist opportunities. ${name} should eat.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
    }
  }

  // GENERAL FALLBACK
  if (projStat > 0 && projGap > 0.5) {
    return `${fullName} projects for ${projStat.toFixed(1)} ${prop} ${oppContext} — modest edge on the ${side} at ${line}, with the projection in our favor.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
  }

  return `The algorithm likes the ${side} at ${line} ${prop} for ${fullName} ${oppContext}, driven by hit rate history and projection alignment.${injuryNote} ${result.confidence >= 80 ? "TAKE" : "LEAN"}.`;
}

function generateGameAnalysis(
  pickType: string, pickSide: string, line: number, confidence: number,
  breakdown: Record<string, number>,
  homeTeam: string, awayTeam: string,
  homeStats: any, awayStats: any,
  h2h?: { homeWins: number; awayWins: number }
): string {
  const bd = breakdown;
  const pickedTeam = pickSide === "home" ? homeTeam : (pickSide === "away" ? awayTeam : "");
  const otherTeam = pickSide === "home" ? awayTeam : (pickSide === "away" ? homeTeam : "");
  const pickedStats = pickSide === "home" ? homeStats : awayStats;
  const otherStats = pickSide === "home" ? awayStats : homeStats;
  const pickedCoach = getCoachInfo(pickedTeam);
  const otherCoach = getCoachInfo(otherTeam);
  const homeCoach = getCoachInfo(homeTeam);
  const awayCoach = getCoachInfo(awayTeam);

  if (pickType === "spread") {
    const pd = pickedStats?.pointDiff ?? 0;
    const opd = otherStats?.pointDiff ?? 0;
    const pWins = pickedStats?.l10Wins ?? 5;
    const pLosses = pickedStats?.l10Losses ?? 5;
    const oWins = otherStats?.l10Wins ?? 5;
    const oLosses = otherStats?.l10Losses ?? 5;
    const ppgEdge = (pickedStats?.ppgScored ?? 0) - (otherStats?.ppgScored ?? 0);
    const h2hWins = pickSide === "home" ? (h2h?.homeWins ?? 0) : (h2h?.awayWins ?? 0);
    const h2hLosses = pickSide === "home" ? (h2h?.awayWins ?? 0) : (h2h?.homeWins ?? 0);
    const restPicked = pickedStats?.restDays ?? 1;
    const restOther = otherStats?.restDays ?? 1;

    if (h2hWins >= 3 && (h2hWins + h2hLosses) >= 3 && h2hWins > h2hLosses * 2) {
      const coachNote = otherCoach ? ` ${otherCoach.name}'s ${otherCoach.style} hasn't had answers in this matchup.` : "";
      return `${pickedTeam} owns the season series ${h2hWins}-${h2hLosses} against ${otherTeam} — when one team dominates like that, the matchup advantages are real and repeatable.${coachNote} ${confidence >= 70 ? "LEAN" : "FADE"}.`;
    }

    if (pWins >= 7 && oWins <= 3) {
      const coachNote = pickedCoach ? ` ${pickedCoach.name}'s ${pickedCoach.style} is clicking right now.` : "";
      return `${pickedTeam} is ${pWins}-${pLosses} in their last 10 while ${otherTeam} is limping at ${oWins}-${oLosses} — that's a massive form gap the spread may not fully capture.${coachNote} ${confidence >= 70 ? "LEAN" : "FADE"}.`;
    }

    if (Math.abs(pd) > 0.1 && Math.abs(opd) > 0.1 && Math.abs(pd - opd) > 4 && pd > opd) {
      return `${pickedTeam} carries a ${pd > 0 ? "+" : ""}${pd.toFixed(1)} point differential vs ${otherTeam}'s ${opd > 0 ? "+" : ""}${opd.toFixed(1)} — they're winning games by wider margins, and that gap shows up on the scoreboard. ${restPicked > restOther + 1 ? `The ${restPicked}-day rest advantage adds another edge.` : ""} ${confidence >= 70 ? "LEAN" : "FADE"}.`;
    }

    if (restPicked >= restOther + 2) {
      const coachNote = pickedCoach ? ` ${pickedCoach.name} will have his squad prepared after ${restPicked} days off.` : "";
      return `${pickedTeam} has ${restPicked} days of rest vs ${otherTeam}'s ${restOther} — in the play-in, that freshness edge is even more pronounced.${coachNote} ${confidence >= 70 ? "LEAN" : "FADE"}.`;
    }

    if (ppgEdge > 3 && pickedStats?.ppgScored > 0 && otherStats?.ppgScored > 0) {
      return `${pickedTeam} averages ${pickedStats.ppgScored.toFixed(1)} PPG vs ${otherTeam}'s ${otherStats?.ppgScored?.toFixed(1) ?? "?"} — a ${ppgEdge.toFixed(1)}-point scoring advantage that gives them firepower to cover ${Math.abs(line)}. ${confidence >= 70 ? "LEAN" : "FADE"}.`;
    }

    return `${pickedTeam} gets the nod at ${line > 0 ? "+" : ""}${line} based on recent form (${pWins}-${pLosses} L10)${pd > 0.1 || pd < -0.1 ? ` and a ${pd > 0 ? "+" : ""}${pd.toFixed(1)} point differential` : ""}. ${h2hWins > h2hLosses ? `The ${h2hWins}-${h2hLosses} H2H edge helps, but no dominant factor stands out` : "No dominant edge here"} — this is a marginal play. ${confidence >= 70 ? "LEAN" : "FADE"}.`;

  } else {
    const combinedPPG = (homeStats?.ppgScored ?? 0) + (awayStats?.ppgScored ?? 0);
    const combinedDefPPG = (homeStats?.ppgAllowed ?? 0) + (awayStats?.ppgAllowed ?? 0);
    const homePPG = homeStats?.ppgScored ?? 0;
    const awayPPG = awayStats?.ppgScored ?? 0;
    const paceNote = homeCoach && awayCoach
      ? `${homeCoach.name}'s ${homeCoach.style.split(",")[0]} meets ${awayCoach.name}'s ${awayCoach.style.split(",")[0]}`
      : "";

    if (pickSide === "under") {
      if (combinedDefPPG > 100 && combinedDefPPG < 220) {
        return `Both defenses combine for just ${combinedDefPPG.toFixed(1)} PPG allowed — ${paceNote ? paceNote + ", and " : ""}that kind of defensive matchup keeps the pace slow and the score low. The ${line} total looks a tick high. ${confidence >= 60 ? "LEAN" : "FADE"}.`;
      }
      if (bd.scoringTrend && bd.scoringTrend <= -2) {
        return `Both ${homeTeam} and ${awayTeam} have been scoring below their season averages recently — ${paceNote ? paceNote + " in " : ""}a cold offensive stretch that makes the ${line} total look inflated. ${confidence >= 60 ? "LEAN" : "FADE"}.`;
      }
      if (homePPG > 0 && awayPPG > 0 && combinedPPG > line + 5) {
        return `The combined scoring average of ${combinedPPG.toFixed(1)} PPG sits well above the ${line} line — this under needs both defenses to step up significantly. ${paceNote ? paceNote + " — " : ""}a risky play without a clear defensive catalyst. FADE.`;
      }
      return `The model projects this game under ${line} — ${homePPG > 0 && awayPPG > 0 ? `${homeTeam} at ${homePPG.toFixed(1)} and ${awayTeam} at ${awayPPG.toFixed(1)} PPG combine for ${combinedPPG.toFixed(1)}, ${combinedPPG < line ? "already below the line" : "right around the number — defense and pace will decide this one"}` : "the defensive profiles suggest a lower-scoring affair"}. ${confidence >= 60 ? "LEAN" : "FADE"}.`;
    } else {
      if (combinedPPG > line + 5) {
        return `${homeTeam} and ${awayTeam} combine for ${combinedPPG.toFixed(1)} PPG — that's ${(combinedPPG - line).toFixed(1)} above the ${line} total. ${paceNote ? paceNote + " — " : ""}when both offenses fire at this rate, the over practically plays itself. ${confidence >= 60 ? "LEAN" : "TAKE"}.`;
      }
      if (bd.scoringTrend && bd.scoringTrend >= 2) {
        return `Both teams have been running hot lately — ${paceNote ? paceNote + " and " : ""}the momentum points to a ${line} total set too conservatively. ${confidence >= 60 ? "LEAN" : "FADE"}.`;
      }
      return `Combined offensive output of ${combinedPPG.toFixed(1)} PPG suggests this game clears ${line}. ${bd.restImpact && bd.restImpact > 0 ? "Well-rested legs typically mean faster pace and more possessions." : ""} ${confidence >= 60 ? "LEAN" : "FADE"}.`;
    }
  }
}

// --- Pick History Logging ---

async function logPickToHistory(result: PropAnalysisResult, prop: ExtractedProp, recommendationShown: boolean, aiAnalysis: string | null = null): Promise<void> {
  // D-253f: in dry-run, count what WOULD be written and skip the RPC POST.
  // Scoring + breakdown are already computed before this is called.
  if (_dryRun) {
    _dryRunCounts.pick_history++;
    return;
  }
  try {
    const now = new Date();
    // D-162 (May 14, 2026): DST-safe ET conversion. Pre-D-162 used raw -4h
    // offset which is correct only during EDT (Mar–Nov). EST (Nov 2+) would
    // produce off-by-one-day game_date in the 04:00–04:59 UTC window.
    const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const gameDate = eastern.toISOString().slice(0, 10).replace(/-/g, "");
    // D-560 — best-available same-line same-side primary (HRB kept within 5c).
    // pick_history.odds is then the OBTAINABLE price the bettor would face,
    // so D-543/D-548-style real-odds BE recomputations reflect real EV.
    const _phPrimary = selectBestSameLineBook(
      prop.availableBooks ?? null,
      result.line,
      result.pickSide,
      prop.bookmaker ?? "",
      result.odds,
    );
    const _phOdds = _phPrimary?.odds ?? result.odds;
    const pickHistoryRow = {
      player_name: result.playerName, team: result.team,
      opponent: normalizeTeamName(prop.homeTeam) === normalizeTeamName(result.team) ? prop.awayTeam : prop.homeTeam,
      game_time: formatGameTime(prop.gameTime), game_date: gameDate, is_home: result.isHome ?? null,
      prop_type: result.propType, line: result.line, pick_side: result.pickSide, odds: _phOdds,
      season_avg: result.seasonAvg ?? null, recent_avg: result.recentAvg ?? null,
      floor_val: result.floor ?? null, ceiling_val: result.ceiling ?? null,
      l5_hit_count: result.hitRatesRaw?.l5Hits ?? null, l10_hit_count: result.hitRatesRaw?.l10Hits ?? null,
      season_hit_pct: result.hitRatesRaw?.seasonRate ?? null,
      is_b2b: result.isBackToBack ?? false, rest_days: result.restDays ?? null,
      minutes_l5_avg: result.minutesTrend?.l5Avg ?? null, minutes_l10_avg: result.minutesTrend?.l10Avg ?? null,
      minutes_trend: result.minutesTrend?.direction ?? null,
      opp_ppg_allowed: result.oppStats?.pointsAllowedPerGame ?? null,
      opp_rpg_allowed: result.oppStats?.reboundsAllowedPerGame ?? null,
      opp_fg_pct_allowed: result.oppStats?.oppFieldGoalPct ?? null,
      opp_3pt_pct_allowed: result.oppStats?.oppThreePointPct ?? null,
      pace_opp_ppg: result.oppStats?.pointsAllowedPerGame ?? null,
      score_l5: result.breakdown?.l5HitRate ?? 0, score_l10: result.breakdown?.l10HitRate ?? 0,
      score_season: result.breakdown?.seasonHitRate ?? 0, score_floor_ceiling: result.breakdown?.floorCeiling ?? 0,
      score_recent_form: result.breakdown?.recentForm ?? 0, score_home_away: result.breakdown?.homeAway ?? 0,
      score_rest: result.breakdown?.restDays ?? 0, score_b2b: result.breakdown?.backToBack ?? 0,
      score_minutes_trend: result.breakdown?.minutesTrend ?? 0, score_pace: result.breakdown?.pace ?? 0,
      score_opp_defense: result.breakdown?.opponentDefense ?? 0, score_odds_value: result.breakdown?.oddsValue ?? 0,
      score_z_score: result.breakdown?.zScoreBonus ?? 0, score_role_change: result.breakdown?.roleChangeBonus ?? 0,
      score_vig_filter: result.breakdown?.vigFilterPenalty ?? 0, score_usg_rate: result.breakdown?.usgBonus ?? 0,
      score_regression: result.breakdown?.regressionBonus ?? 0, score_market_conf: result.breakdown?.marketConfBonus ?? 0,
      score_home_away_split: result.breakdown?.homeAwaySplitBonus ?? 0, score_minutes_floor: result.breakdown?.minutesFloorBonus ?? 0,
      score_consistency: result.breakdown?.consistencyBonus ?? 0, score_prop_type_penalty: result.breakdown?.propTypePenalty ?? 0,
      score_stale_data: result.breakdown?.staleDataPenalty ?? 0, score_player_injury: result.breakdown?.playerInjuryPenalty ?? 0, score_low_min_risk: result.breakdown?.lowMinRiskPenalty ?? 0, score_blowout_risk: result.breakdown?.blowoutRiskPenalty ?? 0, score_line_movement: result.breakdown?.lineMovementBonus ?? 0, unbettable_juice_flag: result.unbettableJuiceFlag ?? false, coin_flip_flag: result.coinFlipFlag ?? false, negative_stacking_flag: result.negativeStackingFlag ?? false, negative_factor_count: result.negativeFactorCount ?? 0,
      // May 4 megadeploy: trivialLinePenalty observability + minutes_floor decompose
      score_trivial_line_penalty: result.breakdown?.trivialLinePenalty ?? 0,
      score_trivial_line_cap: (result.breakdown?.trivialLineCapApplied ?? 0) > 0,
      score_minutes_volume: result.breakdown?.minutesVolumeBonus ?? 0,
      score_minutes_stability: result.breakdown?.minutesStabilityBonus ?? 0,
      projected_stat: result.projectionData?.projectedStat ?? null, stat_stdev: result.projectionData?.statStdDev ?? null,
      z_score: result.projectionData?.zScore ?? null, per_minute_rate: result.projectionData?.perMinRate ?? null,
      projected_minutes: result.projectionData?.projectedMinutes ?? null,
      teammate_injuries_count: result.projectionData?.teammateInjuriesCount ?? null,
      usage_boost: result.projectionData?.usageBoost ?? null,
      confidence: result.confidence, verdict: result.verdict, ai_analysis: aiAnalysis,
      // D-198 (May 17, 2026): tier-aware audit column. Equals confidence when
      // tier modifiers are identity (1.0); diverges once §19.3 tunes multipliers.
      confidence_pre_tier_aware: result.confidence_pre_tier_aware ?? result.confidence,
      // D-406: pre-cap confidence (Layer-2 D-140) for cap-modification analysis.
      // Fallback to confidence (pre-cap == final when no cap fires).
      confidence_pre_cap: result.confidence_pre_cap ?? result.confidence,
      source: "process-games", recommendation_shown: recommendationShown,
      // D-487 SHIP 2: explicit sport='nba' for the canonical writer's
      // validation. Previously omitted; the RPC's COALESCE(rec.sport,'nba')
      // default produced the same final row. Adding the explicit field is
      // byte-identical at the DB level but lets the unified writer's required-
      // field validation pass without special-case logic.
      sport: "nba",
      // D-586 (2026-06-19) — write the full breakdown JSONB to pick_history
      // so NBA per-factor work (D-549 harness, D-541/D-551 rebuilds,
      // D-585 variance audits) can run on NBA picks. Pre-D-586: every
      // per-factor `score_X` column above was a denormalized PEEK at
      // result.breakdown but the JSONB itself was discarded — 100% NULL
      // on 9,341 NBA picks last 90d. MLB writes this at process-games-mlb:
      // 1474 (hist_payload.breakdown). The shape mirrors MLB: rich
      // per-factor map produced by scoreOneSide → calculateConfidenceScore
      // in _shared/scoring.ts (includes l5/l10/season hit rates, recent
      // form, home/away split, rest/b2b, minutes trend, pace, opponent
      // defense, USG, role change, market confirmation, regression,
      // injury, blowout risk, line movement, trivial-line penalties,
      // and the full bonus/penalty layer). Forward-only fix; historical
      // NBA picks can't be backfilled.
      breakdown: result.breakdown ?? {},
    };
    // D-487 SHIP 2: route NBA writes through the canonical helper
    // (_shared/pick_history_writer.ts). Helper validates BEFORE the RPC call
    // (catches D-480-class at hour 0). The same upsert_pick_history RPC is
    // still invoked under the hood (D-446 ON CONFLICT logic preserved server-
    // side). Failure handling unchanged: validation_failed AND rpc_failed
    // both flow through logErrorStructured + trackFailureRate + notify
    // escalation — same alerting surface as the pre-D-487 path.
    //
    // D-529 (T2): the pre-D-529 call wrapped `pickHistoryRow` in
    // `as unknown as Parameters<typeof writePickHistory>[0]` — a double-cast
    // that defeated TS type narrowing on every NBA pick write. Removed in
    // favor of `as PickHistoryPayload` which TS will narrow against the
    // declared field types. The literal at :2519 carries the union of every
    // pick_history column the NBA writer populates (~60+ fields) — these
    // extra columns are accepted by the PickHistoryPayload index signature
    // `[k: string]: unknown` (writer.ts:74) and pass through to the RPC
    // unchanged. The runtime defense for primitive-type drift moved to
    // pick_history_writer.ts validatePayload (D-529 SHIP 1a).
    const writeResult = await writePickHistory(pickHistoryRow as PickHistoryPayload, {
      supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
      supabaseKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    });
    if (!writeResult.ok) {
      // Map the helper's typed result onto the existing structured-error
      // pattern. CLIENT_VALIDATION = hour-0 catch (the D-480 defense);
      // RPC_FAILED = hour-1 catch (Postgres rejected — the pre-D-487 path).
      const isValidation = writeResult.code === "CLIENT_VALIDATION";
      const errType = isValidation ? "pick_history_validation_failed" : "rpc_upsert_failed";
      const responseExcerpt = isValidation
        ? `validation_errors: ${writeResult.errors.join("; ")}`
        : writeResult.body.slice(0, 300);
      const status = isValidation ? 0 : writeResult.status;
      await logErrorStructured("warning", {
        function_name: "process-games",
        phase: "log-pick-history",
        error_type: errType,
        message: isValidation
          ? `pick_history client-side validation rejected payload (D-487 helper)`
          : `upsert_pick_history RPC returned status=${status}`,
        payload: {
          player_name: pickHistoryRow.player_name,
          prop_type: pickHistoryRow.prop_type,
          line: pickHistoryRow.line,
          game_date: pickHistoryRow.game_date,
          response_excerpt: responseExcerpt,
        },
      });
      // Failure-rate tracking + notify escalation: preserved per existing
      // pattern. RPC failures use the existing 'rpc_upsert_failed' bucket
      // (so D-481's rpc_failed_rate health-check continues to alert).
      // Validation failures use a distinct bucket for D-481 sibling check.
      const rate = await trackFailureRate(errType, 5);
      if (rate.tripped) {
        await captureWithContext(new Error(`${errType} rate=${rate.count} in 30min`), {
          function: "process-games",
          phase: "log-pick-history",
          failure_count: rate.count,
          last_response_excerpt: responseExcerpt,
        });
        await notify({
          severity: "critical",
          title: "process-games pick_history writes failing",
          message: `${rate.count} ${errType} in last 30 min. Last response: ${responseExcerpt.slice(0, 200)}`,
          metadata: { failure_count: rate.count, status, kind: errType },
        });
      }
    }
  } catch (e) {
    // C41 refactor (May 10, 2026): upgraded May 9 mini-fix to full pattern.
    await logErrorStructured("warning", {
      function_name: "process-games",
      phase: "log-pick-history",
      error_type: "rpc_upsert_threw",
      message: `upsert_pick_history fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      payload: {
        player_name: pickHistoryRow.player_name,
        prop_type: pickHistoryRow.prop_type,
        line: pickHistoryRow.line,
      },
    });
    const rate = await trackFailureRate("rpc_upsert_threw", 5);
    if (rate.tripped) {
      await captureWithContext(e, {
        function: "process-games",
        phase: "log-pick-history",
        failure_count: rate.count,
      });
    }
  }
}

// --- Recommendations Cache Logging (NEW) ---

async function logToRecommendationsCache(result: PropAnalysisResult, prop: ExtractedProp, gameDate: string, gameId: string): Promise<void> {
  // D-253f: in dry-run, count what WOULD be written and skip the POST.
  if (_dryRun) {
    _dryRunCounts.recommendations_cache++;
    return;
  }
  try {
    // D-560 — choose best-available same-line same-side primary (Hard Rock
    // kept when within 5 cents of best). `result.odds` reflects the
    // scored-with HRB price; we want pick_history + rec_cache to record
    // the actual obtainable EV.
    const _primary = selectBestSameLineBook(
      prop.availableBooks ?? null,
      result.line,
      result.pickSide,
      prop.bookmaker ?? "",
      result.odds,
    );
    const primaryOdds = _primary?.odds ?? result.odds;
    const primaryBook = _primary?.bookmaker ?? (prop.bookmaker ?? null);
    const row = {
      game_date: gameDate, game_id: gameId,
      game_time: formatGameTime(prop.gameTime),
      player_name: result.playerName, team: result.team,
      opponent: normalizeTeamName(prop.homeTeam) === normalizeTeamName(result.team) ? prop.awayTeam : prop.homeTeam,
      is_home: result.isHome ?? null,
      prop_type: result.propType, line: result.line, pick_side: result.pickSide,
      odds: primaryOdds, confidence: result.confidence, verdict: result.verdict,
      ai_analysis: result.aiAnalysis ?? null,
      season_avg: result.seasonAvg ?? null, recent_avg: result.recentAvg ?? null,
      floor_val: result.floor ?? null, ceiling_val: result.ceiling ?? null,
      l5_hit_count: result.hitRatesRaw?.l5Hits ?? null, l10_hit_count: result.hitRatesRaw?.l10Hits ?? null,
      season_hit_pct: result.hitRatesRaw?.seasonRate ?? null,
      is_b2b: result.isBackToBack ?? false, rest_days: result.restDays ?? null,
      minutes_l5_avg: result.minutesTrend?.l5Avg ?? null, minutes_l10_avg: result.minutesTrend?.l10Avg ?? null,
      minutes_trend: result.minutesTrend?.direction ?? null,
      opp_ppg_allowed: result.oppStats?.pointsAllowedPerGame ?? null,
      opp_rpg_allowed: result.oppStats?.reboundsAllowedPerGame ?? null,
      opp_fg_pct_allowed: result.oppStats?.oppFieldGoalPct ?? null,
      opp_3pt_pct_allowed: result.oppStats?.oppThreePointPct ?? null,
      pace_opp_ppg: result.oppStats?.pointsAllowedPerGame ?? null,
      score_l5: result.breakdown?.l5HitRate ?? 0, score_l10: result.breakdown?.l10HitRate ?? 0,
      score_season: result.breakdown?.seasonHitRate ?? 0, score_floor_ceiling: result.breakdown?.floorCeiling ?? 0,
      score_recent_form: result.breakdown?.recentForm ?? 0, score_home_away: result.breakdown?.homeAway ?? 0,
      score_rest: result.breakdown?.restDays ?? 0, score_b2b: result.breakdown?.backToBack ?? 0,
      score_minutes_trend: result.breakdown?.minutesTrend ?? 0, score_pace: result.breakdown?.pace ?? 0,
      score_opp_defense: result.breakdown?.opponentDefense ?? 0,
      score_z_score: result.breakdown?.zScoreBonus ?? 0, score_role_change: result.breakdown?.roleChangeBonus ?? 0,
      score_vig_filter: result.breakdown?.vigFilterPenalty ?? 0, score_usg_rate: result.breakdown?.usgBonus ?? 0,
      score_regression: result.breakdown?.regressionBonus ?? 0, score_market_conf: result.breakdown?.marketConfBonus ?? 0,
      score_home_away_split: result.breakdown?.homeAwaySplitBonus ?? 0, score_minutes_floor: result.breakdown?.minutesFloorBonus ?? 0,
      score_consistency: result.breakdown?.consistencyBonus ?? 0, score_prop_type_penalty: result.breakdown?.propTypePenalty ?? 0,
      score_stale_data: result.breakdown?.staleDataPenalty ?? 0, score_player_injury: result.breakdown?.playerInjuryPenalty ?? 0, score_low_min_risk: result.breakdown?.lowMinRiskPenalty ?? 0, score_blowout_risk: result.breakdown?.blowoutRiskPenalty ?? 0, score_line_movement: result.breakdown?.lineMovementBonus ?? 0, unbettable_juice_flag: result.unbettableJuiceFlag ?? false, coin_flip_flag: result.coinFlipFlag ?? false, negative_stacking_flag: result.negativeStackingFlag ?? false, negative_factor_count: result.negativeFactorCount ?? 0,
      // May 4 megadeploy: trivialLinePenalty observability + minutes_floor decompose
      score_trivial_line_penalty: result.breakdown?.trivialLinePenalty ?? 0,
      score_trivial_line_cap: (result.breakdown?.trivialLineCapApplied ?? 0) > 0,
      score_minutes_volume: result.breakdown?.minutesVolumeBonus ?? 0,
      score_minutes_stability: result.breakdown?.minutesStabilityBonus ?? 0,
      projected_stat: result.projectionData?.projectedStat ?? null, stat_stdev: result.projectionData?.statStdDev ?? null,
      z_score: result.projectionData?.zScore ?? null, per_minute_rate: result.projectionData?.perMinRate ?? null,
      projected_minutes: result.projectionData?.projectedMinutes ?? null,
      teammate_injuries_count: result.projectionData?.teammateInjuriesCount ?? null,
      usage_boost: result.projectionData?.usageBoost ?? null,
      hit_rates_display: result.hitRates,
      last5_values: result.last5Values ?? [],
      breakdown: result.breakdown ?? {},
      absence_info: result.absenceInfo ?? null,
      // D-560 — primaryBook is best-available same-line same-side (HRB
      // preserved within 5c). Falls back to the original prop.bookmaker.
      bookmaker: primaryBook,
      available_books: prop.availableBooks ?? null,
    };
    const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    // on_conflict matches the unique constraint
    // `recommendations_cache_game_date_player_name_prop_type_pick__key`. Without this
    // URL param, PostgREST can't reconcile the conflict and returns 409 — the POST
    // silently fails and the old row's ai_analysis / confidence / scores stick.
    const cacheRes = await fetch(SUPA_URL + "/rest/v1/recommendations_cache?on_conflict=game_date,player_name,prop_type,pick_side", {
      method: "POST",
      headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(row),
    });
    // C41 refactor (May 10, 2026): formerly `catch (_e) { /* non-critical */ }`.
    // 4xx from PostgREST now surfaces to error_log + escalates to notifications_log
    // when failure rate trips threshold. Pattern matches logPickToHistory at line
    // ~2941 (May 9 mini-fix). Caller logic continues unchanged — single-row write
    // failure doesn't block subsequent picks.
    if (!cacheRes.ok) {
      const errText = await cacheRes.text();
      await logErrorStructured("warning", {
        function_name: "process-games",
        phase: "log-recommendations-cache",
        error_type: "recs_cache_write_failed",
        message: `recommendations_cache POST returned status=${cacheRes.status}`,
        payload: {
          player_name: result.playerName,
          prop_type: result.propType,
          line: result.line,
          pick_side: result.pickSide,
          response_excerpt: errText.slice(0, 300),
        },
      });
      const rate = await trackFailureRate("recs_cache_write_failed", 5);
      if (rate.tripped) {
        // 5+ failures in 30 min — surface to Sentry + send critical notification.
        // notifications_log is rate-limited per title at 15min/60min severity-
        // specific windows, so this won't spam.
        await captureWithContext(new Error(`recs_cache_write_failed rate=${rate.count} in 30min`), {
          function: "process-games",
          phase: "log-recommendations-cache",
          failure_count: rate.count,
          last_response_excerpt: errText.slice(0, 300),
        });
        await notify({
          severity: "critical",
          title: "process-games recs_cache writes failing",
          message: `${rate.count} recs_cache_write_failed in last 30 min. Last response: ${errText.slice(0, 200)}`,
          metadata: { failure_count: rate.count, status: cacheRes.status },
        });
      }
    }
  } catch (e) {
    // C41 refactor (May 10, 2026): the fetch itself threw (network error, env-missing,
    // etc). Formerly silent — now structured. captureError so genuinely-broken writers
    // are visible. Don't re-throw — main scoring loop continues to next pick.
    await logErrorStructured("warning", {
      function_name: "process-games",
      phase: "log-recommendations-cache",
      error_type: "recs_cache_write_threw",
      message: `recommendations_cache fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      payload: {
        player_name: result.playerName,
        prop_type: result.propType,
        line: result.line,
      },
    });
    const rate = await trackFailureRate("recs_cache_write_threw", 5);
    if (rate.tripped) {
      await captureWithContext(e, {
        function: "process-games",
        phase: "log-recommendations-cache",
        failure_count: rate.count,
      });
    }
  }
}

// ============================================================
// scoreSlateForDate — score a slate of games for a given date and sport
// ============================================================
//
// CANONICAL USE CASE: Historical backfill mode (Option C re-scoring of
// pre-megadeploy pick_history through the post-megadeploy algorithm).
// Validated on 12,497 synthetic picks across Feb 1 - May 3, 2026.
//
// MODES:
// - 'backfill' (NBA): fully implemented. See backfill-historical edge
//   function for orchestration.
// - 'production' (NBA): NOT IMPLEMENTED. Production NBA scoring continues
//   to use the Deno.serve handler in this same file (~620 LoC of
//   cron_progress orchestration, recommendations_cache writes, Sonnet AI,
//   multi-cache writers, time-gate logic). Per Phase 3b γ decision
//   (May 6, 2026), production-mode delegation is intentionally NOT
//   implemented — multi-sport launch (MLB June, NFL Sep, NHL Oct) will
//   use per-sport functions (process-games-mlb, process-games-nfl,
//   process-games-nhl) sharing _shared/ helpers (cron_progress
//   orchestration, BDL injury fetch, scoreProp math) instead of a unified
//   entry point with sport switches.
// - Other sports (mlb): documentation-only routing — actual MLB scoring
//   will live in a parallel process-games-mlb function with MLB-specific
//   scoring helpers (Ks/hits/runs vs points/assists), data sources
//   (MLB Stats API vs BDL), and opp stats (pitcher matchups vs team
//   def_rating).
//
// For sport='nba' + mode='backfill' implementation detail:
//   - Caller supplies pickHistoryRows as the props to score (from historical
//     pick_history rows pre-megadeploy)
//   - Function fetches CURRENT BDL/ESPN data and uses it to score via the
//     existing scoreProp helper. Note: this is "post-megadeploy algorithm
//     applied to current player baselines" — not "scored with the data that
//     existed at the original game date". For Option C calibration purposes
//     this is acceptable (we want post-megadeploy algorithm × resolved
//     historical outcomes, not historical-data-time-machine accuracy).
//   - Returns scored results plus optionally writes them to pick_history
//     with is_synthetic=true and the supplied backfillRunId.
async function scoreSlateForDate(
  targetDate: string, // 'YYYY-MM-DD'
  sport: "nba" | "mlb",
  options: {
    mode: "production" | "backfill";
    backfillRunId?: string;
    algorithmVersion?: string;
    pickHistoryRows?: Array<{
      player_name: string;
      prop_type: string;
      line: number;
      pick_side: string;
      opponent?: string;
      team?: string;
      game_time?: string;
      game_date?: string;
      // Tier 0 #12 Phase 2 Fix #3: real historical odds from the organic
      // pick_history row being replayed. NULL falls back to -110 (legacy).
      odds?: number;
    }>;
    writeToPickHistory?: boolean;
    skipInjuryFetch?: boolean;
  },
): Promise<{
  success: boolean;
  date: string;
  sport: string;
  mode: string;
  picks_scored: number;
  picks_written: number;
  picks_skipped: number;
  errors: string[];
  results: Array<{
    player_name: string;
    prop_type: string;
    line: number;
    pick_side: string;
    confidence: number;
    verdict: string;
  }>;
}> {
  const errors: string[] = [];
  const results: Array<{ player_name: string; prop_type: string; line: number; pick_side: string; confidence: number; verdict: string; }> = [];
  let picksScored = 0;
  let picksWritten = 0;
  let picksSkipped = 0;

  if (sport === "mlb") {
    return {
      success: false, date: targetDate, sport, mode: options.mode,
      picks_scored: 0, picks_written: 0, picks_skipped: 0,
      errors: [
        "MLB scoring requires process-games-mlb function (June 2026 build). " +
        "scoreSlateForDate sport-routing is documentation-only — actual " +
        "MLB scoring will live in parallel function with MLB-specific " +
        "scoring helpers."
      ],
      results: [],
    };
  }

  if (options.mode === "production") {
    return {
      success: false, date: targetDate, sport, mode: options.mode,
      picks_scored: 0, picks_written: 0, picks_skipped: 0,
      errors: [
        "scoreSlateForDate production-mode is intentionally not " +
        "implemented per Phase 3b γ decision (framework v2.27, May 6 2026). " +
        "Production NBA scoring uses Deno.serve handler in this file. " +
        "Multi-sport launch (June 2026 onward) will use per-sport " +
        "functions sharing _shared/ helpers, not unified entry point."
      ],
      results: [],
    };
  }

  if (!options.pickHistoryRows || options.pickHistoryRows.length === 0) {
    return {
      success: true, date: targetDate, sport, mode: options.mode,
      picks_scored: 0, picks_written: 0, picks_skipped: 0,
      errors: [], results: [],
    };
  }

  // D-155: loadWeightsFromDB now returns weights instead of mutating module state.
  const weights = await loadWeightsFromDB();
  // D-155: helpers object wraps process-games' local state for scoreOneSide.
  // getPlayerInjury delegates to imported getPlayerInjuryStatus with local bdlInjuriesByTeam.
  // getGameLine reads from per-cron-tick gameLineCache (pre-warmed elsewhere in this file).
  // asOfDate threads the Tier 0 #12 Phase 2 backfill override into staleData factor.
  const helpers: ScoreOneSideHelpers = {
    getTeamInjuries: (team) => getTeamInjuries(team),
    getGameLine: (homeTeam, awayTeam, gameDate) =>
      gameLineCache.get(`${homeTeam}|${awayTeam}|${gameDate}`) ?? null,
    getPlayerInjury: (player, team) =>
      getPlayerInjuryStatus(player, team, bdlInjuriesByTeam, _backfillAsOfDate ?? undefined),
    asOfDate: _backfillAsOfDate ?? undefined,
  };

  // Convert pickHistoryRows → ExtractedProp shape
  const propsToScore: ExtractedProp[] = [];
  for (const row of options.pickHistoryRows) {
    // pick_history.prop_type is stored with "player_" prefix already
    // (e.g., "player_points"). For spread/game_total rows, skip — those
    // are scored via scoreGameSide / scoreGameTotal, not scoreProp.
    if (row.prop_type === "spread" || row.prop_type === "game_total") {
      picksSkipped++;
      continue;
    }
    const propType = row.prop_type.startsWith("player_") ? row.prop_type : "player_" + row.prop_type;
    // We don't have homeTeam/awayTeam in pick_history; reconstruct from team + opponent.
    // For scoreProp, the homeTeam/awayTeam are used to determine isHome — we'll
    // fall back to defaults if missing.
    const homeTeam = row.team || "";
    const awayTeam = row.opponent || "";
    propsToScore.push({
      playerName: row.player_name,
      propType,
      line: row.line,
      // Tier 0 #12 Phase 2 Fix #3: use real historical odds when caller passes
      // them (backfill-historical now selects pick_history.odds and forwards
      // it). Fallback to -110 only when truly NULL (legacy backfill rows
      // written before the fix don't have real odds — those replay neutrally).
      odds: typeof row.odds === "number" ? row.odds : -110,
      homeTeam,
      awayTeam,
      gameTime: row.game_time || "",
    });
  }

  if (propsToScore.length === 0) {
    return {
      success: true, date: targetDate, sport, mode: options.mode,
      picks_scored: 0, picks_written: 0, picks_skipped: picksSkipped,
      errors: [], results: [],
    };
  }

  // Group props by player (one fetch per unique player)
  const propsByPlayer = new Map<string, ExtractedProp[]>();
  for (const prop of propsToScore) {
    const key = prop.playerName.toLowerCase();
    if (!propsByPlayer.has(key)) propsByPlayer.set(key, []);
    propsByPlayer.get(key)!.push(prop);
  }
  const uniquePlayers = Array.from(propsByPlayer.keys());

  // Load BDL injuries unless caller skips (for backfill, current injuries
  // don't reflect targetDate's state — caller may want to skip for cleaner
  // synthetic data).
  //
  // Tier 0 #12 Phase 3 Fix #5 (May 11, 2026 night): when skipInjuryFetch=true,
  // CLEAR bdlInjuriesByTeam first. Otherwise a warm Deno isolate that ran a
  // live cron tick earlier has the map already populated with today's BDL
  // data → getPlayerInjuryStatus returns today's injuries on every player
  // even though we never called loadBdlInjuries here. Phase 3a verification
  // surfaced this: P3a player_injury drift was byte-identical to P2 because
  // the map persisted from a prior live invocation. Clearing here ensures
  // synthetic gets "no injury" baseline as designed.
  if (options.skipInjuryFetch) {
    bdlInjuriesByTeam.clear();
  } else {
    try { await loadBdlInjuries(); } catch (e) {
      errors.push("loadBdlInjuries failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // Fetch player data in batches — reuses existing fetchPlayerDataCached helper
  const playerDataCache = new Map<string, CachedPlayerData | null>();
  for (let i = 0; i < uniquePlayers.length; i += PLAYER_BATCH_SIZE) {
    const batch = uniquePlayers.slice(i, i + PLAYER_BATCH_SIZE);
    const fetched = await Promise.all(batch.map(async (playerKey) => {
      const playerProps = propsByPlayer.get(playerKey)!;
      const playerName = playerProps[0].playerName;
      try {
        const data = await fetchPlayerDataCached(playerName);
        return { playerKey, data };
      } catch (e) {
        errors.push("fetchPlayerDataCached(" + playerName + ") failed: " + (e instanceof Error ? e.message : String(e)));
        return { playerKey, data: null };
      }
    }));
    for (const { playerKey, data } of fetched) playerDataCache.set(playerKey, data);
  }

  // Filter each player's gameLog to entries strictly before targetDate so
  // backfill scoring uses only data that was available "as of" the target date.
  // GameLogEntry.date format is variable across helpers — we accept any
  // ISO-like prefix and lexically compare YYYY-MM-DD.
  const targetDateStr = targetDate;
  for (const [playerKey, data] of playerDataCache) {
    if (!data) continue;
    const filteredLog = data.gameLog.filter((g) => {
      const iso = toIsoDate(g.date);
      return iso !== null && iso < targetDateStr;
    });
    playerDataCache.set(playerKey, { ...data, gameLog: filteredLog });
  }

  // Per-team opponent stats — gather unique team / opp pairs, fetch via BDL
  const uniqueTeams = new Set<string>();
  for (const [, playerData] of playerDataCache) {
    if (playerData) uniqueTeams.add(playerData.player.team);
  }
  // Fetch scoreboard once for opp ID resolution
  let scoreboardData: ScoreboardData | null = null;
  try { scoreboardData = await fetchScoreboard(); } catch (e) {
    errors.push("fetchScoreboard failed: " + (e instanceof Error ? e.message : String(e)));
  }

  // Tier 0 #12 Phase 3 Fix #4 placement fix (May 11, 2026 night): the
  // `_backfillAsOfDate` override must be SET before any helper that reads
  // it runs. Original Phase 2 placement (Fix #1 commit bef3163) only
  // wrapped the scoring loop, but checkBackToBack runs in the
  // teamEdgeCache loop BEFORE the scoring loop. Move assignment earlier
  // and widen the try/finally to cover both loops. Same single override,
  // same reset semantics — just placed correctly.
  //
  // Override covers:
  //   - checkBackToBack (Fix #4) — teamEdgeCache loop, b2b + rest_days
  //   - scoreOneSide's staleDataPenalty (Fix #1) — scoring loop, stale data calc
  //
  // Tier 0 #12 Phase 3 Fix #5 amendment-2: _suppressInjuryFetch flag
  // covers loadBdlInjuries called implicitly from scoreOneSide's
  // getTeamInjuries chain. Combined with bdlInjuriesByTeam.clear() above,
  // synthetic gets clean "no injury" baseline regardless of warm-isolate
  // residue or scoring-loop re-fetches.
  //
  // Live cron path leaves both overrides null/false → all callers fall
  // through to default behavior → identical pre-Phase-3 production.
  _backfillAsOfDate = new Date(targetDate + "T20:00:00Z"); // 8pm UTC of game day
  if (options.skipInjuryFetch) _suppressInjuryFetch = true;
  const scoredRows: Array<{ result: PropAnalysisResult; prop: ExtractedProp }> = [];
  try {
    // Build a map of normalized team → opp stats. For backfill, the "current"
    // opponent for a player isn't necessarily the targetDate opponent. We use
    // the pickHistoryRows.opponent field passed in.
    const teamEdgeCache = new Map<string, { b2b: { isBackToBack: boolean; restDays: number }; oppStats: OpponentStats | null }>();
    for (const teamName of uniqueTeams) {
      let oppStats: OpponentStats | null = null;
      let b2b = { isBackToBack: false, restDays: 1 };
      try {
        // Find any pickHistoryRow for this team to know who the opponent was
        const opponentName = options.pickHistoryRows
          .find((r) => normalizeTeamName(r.team || "") === normalizeTeamName(teamName))?.opponent;
        if (opponentName && scoreboardData) {
          const oppId = fetchOpponentTeamIdFromScoreboard(opponentName, scoreboardData);
          if (oppId) {
            // Fix #2: pass targetDate so cache_opponent_defensive_stats lookup
            // selects the snapshot for the historical date being replayed.
            //
            // STRUCTURAL CEILING (Tier 0 #12 Phase 3, May 11 2026):
            // ESPN's sports.core.api endpoint returns current-season averages
            // only — no as-of-date historical endpoint exists. Synthetic
            // backfill replays will use today's ESPN values for the
            // ESPN-derived portion of score_opp_defense (the first
            // attemptFetch path inside fetchOpponentDefensiveStats).
            // BDL teamseasonaverages/advanced has the same limitation —
            // returns current season averages only. Phase 1 measured ~4pp
            // mean abs drift on this factor; Phase 3 verification confirmed
            // unchanged after the cache-snapshot fix because that fix only
            // addresses the C26-B BDL aggregate override layer, not the
            // base ESPN portion. ESPN-derived drift cannot be eliminated
            // without rebuilding the data layer (e.g., daily snapshots
            // going forward via a new cron writing cache rows for ALL
            // current-season-averages fields, not just rpg/apg_bdl).
            // Accept as bounded noise floor. See /tmp/engine_drift_phase3_may11.md.
            oppStats = await fetchOpponentDefensiveStats(oppId, opponentName, targetDate);
          }
        }
        // Fix #4: checkBackToBack now reads _backfillAsOfDate (set above
        // before this loop) → scans backward from targetDate, not today.
        b2b = await checkBackToBack(teamName);
      } catch (e) {
        errors.push("opp/b2b fetch failed for " + teamName + ": " + (e instanceof Error ? e.message : String(e)));
      }
      teamEdgeCache.set(normalizeTeamName(teamName), { b2b, oppStats });
    }

    // Score each prop via existing scoreProp helper. staleDataPenalty in
    // scoreOneSide (line ~2026) reads the same _backfillAsOfDate override.
    for (const [playerKey, playerProps] of propsByPlayer) {
      const playerData = playerDataCache.get(playerKey);
      if (!playerData) {
        picksSkipped += playerProps.length;
        continue;
      }
      const teamKey = normalizeTeamName(playerData.player.team);
      const edgeData = teamEdgeCache.get(teamKey) ?? { b2b: { isBackToBack: false, restDays: 1 }, oppStats: null };
      for (const prop of playerProps) {
        try {
          const result = await scoreProp(playerData, prop, edgeData, weights, helpers);
          if (result) {
            scoredRows.push({ result, prop });
            picksScored++;
            results.push({
              player_name: result.playerName,
              prop_type: result.propType,
              line: result.line,
              pick_side: result.pickSide,
              confidence: result.confidence,
              verdict: getScoreLabel(result.confidence),
            });
          } else {
            picksSkipped++;
          }
        } catch (e) {
          picksSkipped++;
          errors.push("scoreProp(" + prop.playerName + "/" + prop.propType + ") failed: " + (e instanceof Error ? e.message : String(e)));
        }
      }
    }
  } finally {
    _backfillAsOfDate = null;
    _suppressInjuryFetch = false;
  }

  // Optional: write to pick_history with is_synthetic markers
  if (options.writeToPickHistory && scoredRows.length > 0) {
    const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const gameDateYYYYMMDD = targetDate.replace(/-/g, "");
    const algoVersion = options.algorithmVersion || "2026-05-04-megadeploy";
    const backdatedCreatedAt = new Date(targetDate + "T20:00:00Z").toISOString(); // 8pm UTC of game day

    const synthRows = scoredRows.map(({ result, prop }) => {
      // Mirror logPickToHistory row shape exactly so synthetic rows are
      // schema-compatible with production rows. Only differences: explicit
      // backdated created_at, source='backfill', is_synthetic=true,
      // backfill_run_id, algorithm_version. Everything else uses the same
      // result.* + result.breakdown.* + result.hitRatesRaw.* + result.minutesTrend.*
      // + result.oppStats.* + result.projectionData.* projections.
      const opponent = normalizeTeamName(prop.homeTeam) === normalizeTeamName(result.team)
        ? prop.awayTeam : prop.homeTeam;
      return {
        player_name: result.playerName, team: result.team, opponent,
        game_time: formatGameTime(prop.gameTime), game_date: gameDateYYYYMMDD, is_home: result.isHome ?? null,
        prop_type: result.propType, line: result.line, pick_side: result.pickSide, odds: result.odds,
        season_avg: result.seasonAvg ?? null, recent_avg: result.recentAvg ?? null,
        floor_val: result.floor ?? null, ceiling_val: result.ceiling ?? null,
        l5_hit_count: result.hitRatesRaw?.l5Hits ?? null, l10_hit_count: result.hitRatesRaw?.l10Hits ?? null,
        season_hit_pct: result.hitRatesRaw?.seasonRate ?? null,
        is_b2b: result.isBackToBack ?? false, rest_days: result.restDays ?? null,
        minutes_l5_avg: result.minutesTrend?.l5Avg ?? null, minutes_l10_avg: result.minutesTrend?.l10Avg ?? null,
        minutes_trend: result.minutesTrend?.direction ?? null,
        opp_ppg_allowed: result.oppStats?.pointsAllowedPerGame ?? null,
        opp_rpg_allowed: result.oppStats?.reboundsAllowedPerGame ?? null,
        opp_fg_pct_allowed: result.oppStats?.oppFieldGoalPct ?? null,
        opp_3pt_pct_allowed: result.oppStats?.oppThreePointPct ?? null,
        pace_opp_ppg: result.oppStats?.pointsAllowedPerGame ?? null,
        score_l5: result.breakdown?.l5HitRate ?? 0, score_l10: result.breakdown?.l10HitRate ?? 0,
        score_season: result.breakdown?.seasonHitRate ?? 0, score_floor_ceiling: result.breakdown?.floorCeiling ?? 0,
        score_recent_form: result.breakdown?.recentForm ?? 0, score_home_away: result.breakdown?.homeAway ?? 0,
        score_rest: result.breakdown?.restDays ?? 0, score_b2b: result.breakdown?.backToBack ?? 0,
        score_minutes_trend: result.breakdown?.minutesTrend ?? 0, score_pace: result.breakdown?.pace ?? 0,
        score_opp_defense: result.breakdown?.opponentDefense ?? 0, score_odds_value: result.breakdown?.oddsValue ?? 0,
        score_z_score: result.breakdown?.zScoreBonus ?? 0, score_role_change: result.breakdown?.roleChangeBonus ?? 0,
        score_vig_filter: result.breakdown?.vigFilterPenalty ?? 0, score_usg_rate: result.breakdown?.usgBonus ?? 0,
        score_regression: result.breakdown?.regressionBonus ?? 0, score_market_conf: result.breakdown?.marketConfBonus ?? 0,
        score_home_away_split: result.breakdown?.homeAwaySplitBonus ?? 0, score_minutes_floor: result.breakdown?.minutesFloorBonus ?? 0,
        score_consistency: result.breakdown?.consistencyBonus ?? 0, score_prop_type_penalty: result.breakdown?.propTypePenalty ?? 0,
        score_stale_data: result.breakdown?.staleDataPenalty ?? 0, score_player_injury: result.breakdown?.playerInjuryPenalty ?? 0, score_low_min_risk: result.breakdown?.lowMinRiskPenalty ?? 0, score_blowout_risk: result.breakdown?.blowoutRiskPenalty ?? 0, score_line_movement: result.breakdown?.lineMovementBonus ?? 0, unbettable_juice_flag: result.unbettableJuiceFlag ?? false, coin_flip_flag: result.coinFlipFlag ?? false, negative_stacking_flag: result.negativeStackingFlag ?? false, negative_factor_count: result.negativeFactorCount ?? 0,
        score_trivial_line_penalty: result.breakdown?.trivialLinePenalty ?? 0,
        score_trivial_line_cap: (result.breakdown?.trivialLineCapApplied ?? 0) > 0,
        score_minutes_volume: result.breakdown?.minutesVolumeBonus ?? 0,
        score_minutes_stability: result.breakdown?.minutesStabilityBonus ?? 0,
        projected_stat: result.projectionData?.projectedStat ?? null, stat_stdev: result.projectionData?.statStdDev ?? null,
        z_score: result.projectionData?.zScore ?? null, per_minute_rate: result.projectionData?.perMinRate ?? null,
        projected_minutes: result.projectionData?.projectedMinutes ?? null,
        teammate_injuries_count: result.projectionData?.teammateInjuriesCount ?? null,
        usage_boost: result.projectionData?.usageBoost ?? null,
        confidence: result.confidence, verdict: result.verdict, ai_analysis: null,
        actual_value: null, hit: null, resolved_at: null,
        source: "backfill", recommendation_shown: false,
        is_synthetic: true,
        backfill_run_id: options.backfillRunId || null,
        algorithm_version: algoVersion,
        created_at: backdatedCreatedAt,
      };
    });

    // Batch insert. on_conflict include backfill_run_id so backfill rows
    // for the same (player,prop,line,date) across runs don't collide with
    // the production unique constraint and don't collide with each other
    // unless same run.
    try {
      const insertRes = await fetch(
        SUPA_URL + "/rest/v1/pick_history",
        {
          method: "POST",
          headers: {
            "apikey": SUPA_KEY,
            "Authorization": "Bearer " + SUPA_KEY,
            "Content-Type": "application/json",
            "Prefer": "resolution=ignore-duplicates,return=minimal",
          },
          body: JSON.stringify(synthRows),
        },
      );
      if (insertRes.ok) {
        picksWritten = synthRows.length;
      } else {
        const errText = await insertRes.text();
        errors.push("pick_history POST failed status=" + insertRes.status + " " + errText.slice(0, 200));
      }
    } catch (e) {
      errors.push("pick_history POST threw: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  return {
    success: errors.length === 0 || picksScored > 0,
    date: targetDate, sport, mode: options.mode,
    picks_scored: picksScored,
    picks_written: picksWritten,
    picks_skipped: picksSkipped,
    errors,
    results,
  };
}

// ============================================================
// MAIN HANDLER — Progressive Cron
// Processes 1-2 games per invocation
// ============================================================

Deno.serve(async (req) => {
  // D-253f: reset module-scope dry-run state at the top of every request.
  _dryRun = false;
  _resetDryRunCounts();
  // D-155: weights captured per-request from imported loadWeightsFromDB.
  const weights = await loadWeightsFromDB();
  // D-155: helpers object same shape as scoreSlateForDate site above.
  const helpers: ScoreOneSideHelpers = {
    getTeamInjuries: (team) => getTeamInjuries(team),
    getGameLine: (homeTeam, awayTeam, gameDate) =>
      gameLineCache.get(`${homeTeam}|${awayTeam}|${gameDate}`) ?? null,
    getPlayerInjury: (player, team) =>
      getPlayerInjuryStatus(player, team, bdlInjuriesByTeam, _backfillAsOfDate ?? undefined),
    asOfDate: _backfillAsOfDate ?? undefined,
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startTime = Date.now();
  resetRunStats();

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  // BACKFILL ROUTE — additive entry point for scoreSlateForDate (Phase 3a).
  // Production cron behavior unchanged unless `mode: 'backfill'` is in body.
  // backfill-historical orchestrator (Phase 4) is the only caller — auth is
  // gated on service-role key in the request body so anon callers can't
  // invoke this path.
  // D-253f: also parse `dry_run` from the same body. When set, the module-scope
  // _dryRun flag suppresses every DB write below. Auth is REQUIRED for dry-run
  // (same service-role gate as backfill mode) since dry-run is intended for
  // CEO/operator smoke testing, not anon traffic.
  let _dryRunBody: Record<string, unknown> = {};
  if (req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (_e) { /* ignore — fall through to production cron path */ }
    _dryRunBody = body;
    // D-253f: gate dry-run on the same service-role / BACKFILL_AUTH_TOKEN
    // header check used by backfill mode. Set the module flag, then fall
    // through to either the backfill sub-handler or the production cron path.
    if (body && body.dry_run === true) {
      const auth = req.headers.get("authorization") || "";
      const legacyServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      const newSecretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "";
      const newSecretKeys = newSecretKeysRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const customToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
      const matchedLegacy = legacyServiceKey && auth.includes(legacyServiceKey);
      const matchedNew = newSecretKeys.some((k) => auth.includes(k));
      const matchedCustom = customToken && auth.includes(customToken);
      if (!matchedLegacy && !matchedNew && !matchedCustom) {
        return jsonResponse({ dry_run: true, success: false, error: "dry_run requires service_role key in Authorization header" }, 401);
      }
      _dryRun = true;
    }
    if (body && body.mode === "backfill") {
      // Accept legacy service_role JWT, any new-format secret key, or the
      // custom BACKFILL_AUTH_TOKEN (settable via `supabase secrets set` —
      // unlike SUPABASE_* names which the CLI refuses to overwrite). Mirror
      // backfill-historical's gate so the orchestrator's downstream call here
      // works after CEO sets BACKFILL_AUTH_TOKEN.
      const auth = req.headers.get("authorization") || "";
      const legacyServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      const newSecretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "";
      const newSecretKeys = newSecretKeysRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      const customToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
      const matchedLegacy = legacyServiceKey && auth.includes(legacyServiceKey);
      const matchedNew = newSecretKeys.some((k) => auth.includes(k));
      const matchedCustom = customToken && auth.includes(customToken);
      if (!matchedLegacy && !matchedNew && !matchedCustom) {
        return jsonResponse({ success: false, error: "backfill mode requires service_role key (set BACKFILL_AUTH_TOKEN env)" }, 401);
      }
      const targetDate = String(body.targetDate || "");
      const sport = String(body.sport || "nba") as "nba" | "mlb";
      const backfillRunId = body.backfillRunId ? String(body.backfillRunId) : undefined;
      const pickHistoryRows = Array.isArray(body.pickHistoryRows) ? body.pickHistoryRows as Array<Record<string, unknown>> : [];
      const writeToPickHistory = body.writeToPickHistory === true;
      const skipInjuryFetch = body.skipInjuryFetch === true;
      const algorithmVersion = body.algorithmVersion ? String(body.algorithmVersion) : "2026-05-04-megadeploy";
      if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        return jsonResponse({ success: false, error: "targetDate required as YYYY-MM-DD" }, 400);
      }
      const result = await scoreSlateForDate(targetDate, sport, {
        mode: "backfill",
        backfillRunId,
        algorithmVersion,
        pickHistoryRows: pickHistoryRows as Array<{
          player_name: string; prop_type: string; line: number; pick_side: string;
          opponent?: string; team?: string; game_time?: string; game_date?: string;
          odds?: number;
        }>,
        writeToPickHistory,
        skipInjuryFetch,
      });
      return jsonResponse(result, result.success ? 200 : 500);
    }
  }

  try {
    console.log("\n========================================");
    console.log("=== PROCESS-GAMES (Progressive Cron) ===");
    console.log("========================================\n");

    // Time gate: only run noon-7pm ET (allow wider window, cron schedule controls frequency)
    // D-253f: dry-run bypasses the time gate so operators can smoke-test off-hours.
    if (!force && !_dryRun) {
      const now = new Date();
      const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const hour = eastern.getHours();
      if (hour < 10 || hour >= 19) {
        // D-112 fix (May 9): write run_log row on skip path so health-monitor's
        // run_log freshness check sees the cron tick. Paired with health-monitor
        // filter relaxation status=in.(success,skipped).
        runStats.notes.push(`skipped: outside cron window 10am-7pm ET (hour=${hour})`);
        await logRun("skipped");
        return jsonResponse({ success: true, message: "Outside processing window (noon-7pm ET)", hour, skipped: true });
      }
    }

    // Get today's date in Eastern
    const EDT_OFFSET_MS = 4 * 60 * 60 * 1000;
    const easternNow = new Date(Date.now() - EDT_OFFSET_MS);
    const gameDate = easternNow.toISOString().slice(0, 10).replace(/-/g, "");

    const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    // Step 0.5: Daily cleanup — delete cron_progress rows older than 3 days.
    // Prevents the table from growing indefinitely with old game dates.
    // D-253f: skip DELETE in dry-run (still a write, even if it's cleanup).
    if (!_dryRun) {
      try {
        const cutoff = new Date(Date.now() - EDT_OFFSET_MS - 3 * 24 * 60 * 60 * 1000);
        const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, "");
        const cleanRes = await fetch(
          SUPA_URL + "/rest/v1/cron_progress?game_date=lt." + cutoffStr,
          { method: "DELETE", headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Prefer": "return=minimal" } }
        );
        console.log("[cron] Cleaned cron_progress rows older than " + cutoffStr + " status=" + cleanRes.status);
      } catch (err) {
        console.log("[cron] cron_progress cleanup failed (non-fatal): " + String(err));
      }
    }

    // Step 1: Check cron_progress for today
    const progressRes = await fetch(
      SUPA_URL + "/rest/v1/cron_progress?game_date=eq." + gameDate + "&select=*&order=game_time.asc",
      { headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY } }
    );
    let progressRows = progressRes.ok ? await progressRes.json() : [];

    // Step 2: If no rows for today, seed from props_cache events
    if (progressRows.length === 0) {
      console.log("[cron] No games seeded for " + gameDate + " — reading props_cache...");
      const cacheRes = await fetch(
        // D-229 Fix 1 — sport filter required. Without it, MLB events from
        // fetch-odds-mlb pollute cron_progress and the NBA-only Odds API
        // call at line 3546 returns 404 for every MLB event_id, blocking
        // the queue indefinitely (root cause of "Games Today 0" on 2026-05-18).
        SUPA_URL + "/rest/v1/props_cache?game_date=eq." + gameDate + "&sport=eq.nba&select=event_id,home_team,away_team,game_time",
        { headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY } }
      );
      if (cacheRes.ok) {
        const cacheRows = await cacheRes.json();
        const eventMap = new Map<string, any>();
        for (const row of cacheRows) {
          if (row.event_id && !eventMap.has(row.event_id)) {
            eventMap.set(row.event_id, {
              game_date: gameDate, game_id: row.event_id,
              home_team: row.home_team, away_team: row.away_team,
              game_time: row.game_time, status: "pending"
            });
          }
        }
        if (eventMap.size > 0) {
          const seedRows = Array.from(eventMap.values());
          console.log("[cron] Seeding " + seedRows.length + " games into cron_progress");
          // D-253f: in dry-run, count rows that WOULD be seeded but use the
          // already-built eventMap as the synthetic progressRows so the rest
          // of the pipeline still exercises a real code path.
          if (_dryRun) {
            _dryRunCounts.cron_progress += seedRows.length;
            progressRows = seedRows;
          } else {
            await fetch(SUPA_URL + "/rest/v1/cron_progress", {
              method: "POST",
              headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json", "Prefer": "resolution=ignore-duplicates" },
              body: JSON.stringify(seedRows),
            });
            const refetch = await fetch(
              SUPA_URL + "/rest/v1/cron_progress?game_date=eq." + gameDate + "&select=*&order=game_time.asc",
              { headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY } }
            );
            progressRows = refetch.ok ? await refetch.json() : [];
          }
        } else {
          console.log("[cron] No events in props_cache for " + gameDate);
          // D-112 fix (May 9): write run_log row on skip path so health-monitor sees the tick.
          runStats.notes.push(`skipped: no events in props_cache for ${gameDate}`);
          await logRun("skipped");
          if (_dryRun) {
            return jsonResponse({ dry_run: true, success: true, message: "No games in props_cache for today", skipped: true, would_write: _dryRunCounts, elapsed_ms: Date.now() - startTime });
          }
          return jsonResponse({ success: true, message: "No games in props_cache for today", skipped: true });
        }
      }
    }

    // Step 3: Find first pending game
    const pendingGame = progressRows.find((r: any) => r.status === "pending");
    if (!pendingGame) {
      const completed = progressRows.filter((r: any) => r.status === "complete").length;
      console.log("[cron] All " + completed + "/" + progressRows.length + " games processed");
      // D-112 fix (May 9): write run_log row on skip path so health-monitor sees the tick.
      // This is the most-common skip path during active cron windows — fires every 15 min
      // after the day's slate is fully processed.
      runStats.gamesFound = progressRows.length;
      runStats.notes.push(`skipped: all ${completed}/${progressRows.length} games already complete for ${gameDate}`);
      await logRun("skipped");
      if (_dryRun) {
        return jsonResponse({
          dry_run: true, success: true, message: "All games processed",
          gamesTotal: progressRows.length, gamesCompleted: completed, skipped: true,
          would_write: _dryRunCounts, elapsed_ms: Date.now() - startTime,
        });
      }
      return jsonResponse({
        success: true, message: "All games processed",
        gamesTotal: progressRows.length, gamesCompleted: completed, skipped: true,
      });
    }

    // Step 4: Mark as processing
    // D-253f: skip the PATCH in dry-run (counts as cron_progress write).
    if (_dryRun) {
      _dryRunCounts.cron_progress++;
    } else {
      await fetch(SUPA_URL + "/rest/v1/cron_progress?id=eq." + pendingGame.id, {
        method: "PATCH",
        headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "processing", started_at: new Date().toISOString() }),
      });
    }

    console.log("[cron] === Processing: " + pendingGame.away_team + " @ " + pendingGame.home_team + " ===");

    // C32 fix (May 5): runStats.gamesFound was dead code post-cron_progress
    // refactor — declared/reset/read in logRun but never incremented after
    // process-games became single-game-per-invocation. Set it to the slate
    // size so each run_log row carries the day's game count for visibility.
    // Each cron tick processes 1 game, so all run_log rows for the same
    // slate share the same gamesFound value (= total games on the slate).
    runStats.gamesFound = progressRows.length;

    // Step 4.5: Clear stale cache rows for this game_id (supports re-processing)
    // Without this, merge-duplicates on POST silently keeps old ai_analysis/confidence.
    // D-253f: skip recommendations_cache DELETE in dry-run.
    if (!_dryRun) {
      try {
        const delRes = await fetch(
          SUPA_URL + "/rest/v1/recommendations_cache?game_id=eq." + pendingGame.game_id,
          { method: "DELETE", headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Prefer": "return=minimal" } }
        );
        console.log("[cron] Cleared stale cache rows for game_id=" + pendingGame.game_id + " status=" + delRes.status);
      } catch (err) {
        console.log("[cron] Cache clear failed (non-fatal): " + String(err));
      }
    }

    // Step 5: Load BDL injuries once
    await loadBdlInjuries();

    // D-052 Phase 2: cache writes — team metadata + injuries snapshot. Both
    // are derived from the just-loaded BDL feed so this is the natural moment.
    // Snapshot date is today's ET game_date in YYYY-MM-DD form.
    const snapshotDateIso = easternNow.toISOString().slice(0, 10);
    await writeCacheTeamMetadata();
    await writeCacheTeamInjuries(snapshotDateIso);

    // Step 6: Fetch props from props_cache for this game
    const propsRes = await fetch(
      SUPA_URL + "/rest/v1/props_cache?game_date=eq." + gameDate + "&event_id=eq." + pendingGame.game_id + "&select=*",
      { headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY } }
    );

    const gameProps: ExtractedProp[] = [];
    if (propsRes.ok) {
      const propsData = await propsRes.json();
      const BOOK_PRIORITY: Record<string, number> = { hardrockbet: 0, draftkings: 1, fanduel: 2, betmgm: 3, bovada: 4, pointsbet: 5 };
      // Dedup key includes pick_side so over and under rows survive the priority filter
      // separately. After Step 2's schema change, propsData carries both sides per book; without
      // pick_side in the key the over and under rows collided and one was dropped arbitrarily.
      const bestByProp = new Map<string, any>();
      for (const row of propsData) {
        const key = row.player_name + "|" + row.prop_type + "|" + row.pick_side;
        const existing = bestByProp.get(key);
        const rowPriority = BOOK_PRIORITY[row.bookmaker] ?? 99;
        if (!existing || rowPriority < (BOOK_PRIORITY[existing.bookmaker] ?? 99)) bestByProp.set(key, row);
      }
      const now = new Date();
      for (const [, row] of bestByProp) {
        const gameTime = row.game_time || "";
        if (gameTime && new Date(gameTime) < now) continue;
        // Snapshot every book offering this (player, prop_type) — both sides — so the cache row
        // can power line-shopping in the UI without re-querying props_cache.
        const availableBooks = propsData
          .filter((r: any) => r.player_name === row.player_name && r.prop_type === row.prop_type)
          .map((r: any) => ({
            bookmaker: r.bookmaker,
            line: parseFloat(r.line),
            odds: r.odds || -110,
            pick_side: r.pick_side,
          }));
        gameProps.push({
          playerName: row.player_name, propType: "player_" + row.prop_type,
          line: parseFloat(row.line), odds: row.odds || -110,
          homeTeam: row.home_team || "", awayTeam: row.away_team || "", gameTime,
          bookmaker: row.bookmaker,
          availableBooks,
        });
      }
      console.log("[cron] " + gameProps.length + " props (deduped from " + propsData.length + " rows)");
    }
    runStats.propsFetched = gameProps.length;

    // Step 7: Group by player, fetch ESPN data, score
    const propsByPlayer = new Map<string, ExtractedProp[]>();
    for (const prop of gameProps) {
      const key = prop.playerName.toLowerCase();
      if (!propsByPlayer.has(key)) propsByPlayer.set(key, []);
      propsByPlayer.get(key)!.push(prop);
    }

    const uniquePlayers = Array.from(propsByPlayer.keys());
    console.log("[cron] " + uniquePlayers.length + " unique players to fetch");

    const playerDataCache = new Map<string, CachedPlayerData | null>();
    let playersLoaded = 0, playersSkipped = 0;

    for (let i = 0; i < uniquePlayers.length; i += PLAYER_BATCH_SIZE) {
      if (Date.now() - startTime > MAX_PROCESSING_MS) {
        console.log("[cron] Timeout approaching at player " + i + "/" + uniquePlayers.length);
        break;
      }
      const batch = uniquePlayers.slice(i, i + PLAYER_BATCH_SIZE);
      const results = await Promise.all(batch.map(async (playerKey) => {
        const playerProps = propsByPlayer.get(playerKey)!;
        const playerName = playerProps[0].playerName;
        try {
          const data = await fetchPlayerDataCached(playerName);
          playerDataCache.set(playerKey, data);
          return !!data;
        } catch (_e) { playerDataCache.set(playerKey, null); return false; }
      }));
      for (const r of results) { if (r) playersLoaded++; else playersSkipped++; }
    }
    runStats.playersLoaded = playersLoaded;
    runStats.playersSkipped = playersSkipped;
    console.log("[cron] ESPN: loaded " + playersLoaded + ", skipped " + playersSkipped);

    // D-052 Phase 2: cache writes — player metadata + per-player game logs.
    // Fired after the player batch finishes so we don't slow ESPN fetches.
    // Each writer is independently try/catched; failures don't abort the cron.
    for (const [, playerData] of playerDataCache) {
      if (!playerData) continue;
      await writeCachePlayerMetadata(playerData.player, "basketball");
      await writeCachePlayerGameLogs(playerData.player.id, playerData.player.displayName, "basketball", playerData.gameLog);
    }

    // Fetch team edge data
    const scoreboardData = await fetchScoreboard();
    // D-052 Phase 2: cache the full ESPN scoreboard (not just this game).
    await writeCacheGameScoreboard(scoreboardData);
    const teams = [pendingGame.home_team, pendingGame.away_team];
    const b2bResults = await Promise.all(teams.map(t => checkBackToBack(t)));
    const oppIdResults = teams.map(t => scoreboardData ? fetchOpponentTeamIdFromScoreboard(t, scoreboardData) : null);
    // May 5 BDL rewire: build oppId → oppName map so fetchOpponentDefensiveStats
    // can resolve BDL team_id from name (BDL doesn't index by ESPN team ID).
    // teams[i]'s opponent is teams[1-i] when both sides scored.
    const oppIdToName = new Map<string, string>();
    for (let i = 0; i < teams.length; i++) {
      const oppId = oppIdResults[i];
      if (oppId) oppIdToName.set(oppId, teams[1 - i]);
    }
    const uniqueOppIds = [...new Set(oppIdResults.filter(id => id !== null) as string[])];
    const oppStatsResults = await Promise.all(uniqueOppIds.map(id => fetchOpponentDefensiveStats(id, oppIdToName.get(id))));
    const oppIdToStats = new Map<string, OpponentStats | null>();
    for (let i = 0; i < uniqueOppIds.length; i++) oppIdToStats.set(uniqueOppIds[i], oppStatsResults[i]);

    // D-137 Tier 2 #6 V0-B: pre-warm gameLineCache for this game ONCE per
    // per-pending-game cron iteration. scoreOneSide reads via module-level
    // gameLineCache.get() with no further DB hits. Graceful degradation: if
    // cache_game_lines hasn't been populated by fetch-odds yet (first tick of
    // a new event, or fetch-odds outage), loadGameLineFromCache returns null
    // and the blowout_risk factor defaults to 0. NOT applied to the
    // scoreSlateForDate backfill path (L3589 teamEdgeCache) — backfill is
    // synthetic; cache_game_lines has no historical rows, factor stays 0.
    {
      const gd = (pendingGame.game_date ?? "").length >= 10
        ? pendingGame.game_date.slice(0, 10)
        : (pendingGame.game_date || "");
      await loadGameLineFromCache(pendingGame.home_team, pendingGame.away_team, gd);
    }
    const teamEdgeCache = new Map<string, { b2b: { isBackToBack: boolean; restDays: number }; oppStats: OpponentStats | null }>();
    for (let i = 0; i < teams.length; i++) {
      const normalizedTeam = normalizeTeamName(teams[i]);
      const oppId = oppIdResults[i];
      const oppStats = oppId ? oppIdToStats.get(oppId) ?? null : null;
      teamEdgeCache.set(normalizedTeam, { b2b: b2bResults[i], oppStats });
      if (oppStats) runStats.oppStatsFound++; else runStats.oppStatsFailed++;
      // D-052 Phase 2: snapshot the OPPONENT's defensive stats. teams[i]'s
      // opponent is teams[1-i] in this 2-team home/away pairing.
      if (oppStats) {
        const opponentName = teams[1 - i];
        await writeCacheOpponentDefensiveStats(opponentName, snapshotDateIso, oppStats);
      }
    }

    // Score all props
    const allResults: Array<{ result: PropAnalysisResult; prop: ExtractedProp }> = [];
    for (const [playerKey, playerProps] of propsByPlayer) {
      const playerData = playerDataCache.get(playerKey);
      if (!playerData) continue;
      const rawTeam = playerData.player.team;
      const teamKey = normalizeTeamName(rawTeam);
      const edgeData = teamEdgeCache.get(teamKey) ?? { b2b: { isBackToBack: false, restDays: 1 }, oppStats: null };
      for (const prop of playerProps) {
        const result = await scoreProp(playerData, prop, edgeData, weights, helpers);
        if (result) allResults.push({ result, prop });
      }
    }
    runStats.propsScored = allResults.length;
    console.log("[cron] Scored " + allResults.length + " props");

    // === GAME SIDES & TOTALS ===
    // Track whether spread AND total were both successfully written to recommendations_cache.
    // If either is false at the end, the game stays 'pending' so the next cron run retries.
    let spreadWritten = false;
    let totalWritten = false;
    try {
      console.log("[cron-game] Fetching spreads/totals for " + pendingGame.home_team + " vs " + pendingGame.away_team);
      // Circuit breaker: skip the Odds API call if credits are low. spreadWritten/totalWritten
      // stay false so Step 10 reverts status to 'pending' and the next cron (after reset) retries.
      const cbOk = await checkCircuitBreaker({ game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team });
      if (!cbOk) {
        console.log("[cron-game] Circuit breaker tripped — skipping game-odds fetch; game will stay pending for retry");
      }
      const gameOddsUrl = "https://api.the-odds-api.com/v4/sports/basketball_nba/events/" + pendingGame.game_id + "/odds?apiKey=" + ODDS_API_KEY + "&regions=us,us2&markets=spreads,totals&oddsFormat=american";
      let gameOddsRes: { ok: boolean; status: number; text: string } = { ok: false, status: 0, text: "" };
      if (cbOk) {
        try {
          const rawRes = await fetch(gameOddsUrl);
          const rawText = await rawRes.text();
          gameOddsRes = { ok: rawRes.ok, status: rawRes.status, text: rawText };
          await logApiUsage("event_odds_game_lines", rawRes.status, rawRes.headers, { game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team });
        } catch (fetchErr) {
          console.log("[cron-game] fetch threw: " + fetchErr);
          await logApiUsage("event_odds_game_lines", 0, null, { game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team, error: String(fetchErr) });
        }
      }
      if (cbOk && (!gameOddsRes.ok || !gameOddsRes.text)) {
        console.log("[cron-game] Odds API FAILED for " + pendingGame.game_id + " status=" + gameOddsRes.status);
        await logError("game-odds", "api_failure", "Odds API returned status=" + gameOddsRes.status + " for event " + pendingGame.game_id, { game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team, status: gameOddsRes.status });
      }
      if (gameOddsRes.ok && gameOddsRes.text) {
        const gameOddsData = JSON.parse(gameOddsRes.text);
        const hrb = (gameOddsData.bookmakers ?? []).find((b: any) => b.key === "hardrockbet") || (gameOddsData.bookmakers ?? [])[0];
        if (!hrb) {
          console.log("[cron-game] No bookmaker found for " + pendingGame.game_id + " | bookmakers count=" + (gameOddsData.bookmakers?.length ?? 0));
          await logError("game-odds", "no_bookmaker", "No bookmaker data for event " + pendingGame.game_id, { game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team, bookmakers_count: gameOddsData.bookmakers?.length ?? 0 });
        }
        if (hrb) {
          let spreadLine = 0, spreadOdds = -110, totalLine = 0, totalOverOdds = -110, totalUnderOdds = -110;
          for (const mkt of hrb.markets ?? []) {
            if (mkt.key === "spreads") {
              const home = (mkt.outcomes ?? []).find((o: any) => o.name === pendingGame.home_team);
              if (home) { spreadLine = home.point; spreadOdds = home.price; }
            }
            if (mkt.key === "totals") {
              const over = (mkt.outcomes ?? []).find((o: any) => o.name === "Over");
              const under = (mkt.outcomes ?? []).find((o: any) => o.name === "Under");
              if (over) { totalLine = over.point; totalOverOdds = over.price; }
              if (under) { totalUnderOdds = under.price; }
            }
          }
          console.log("[cron-game] spread=" + spreadLine + " total=" + totalLine);
          if (spreadLine === 0) {
            console.log("[cron-game] WARNING: No spread line found for " + pendingGame.game_id + " | bookmaker=" + hrb.key);
            await logError("game-odds", "no_spread", "Spread line=0 for " + pendingGame.home_team + " vs " + pendingGame.away_team, { game_id: pendingGame.game_id, bookmaker: hrb.key, markets: hrb.markets?.map((m: any) => m.key) ?? [] });
          }
          if (totalLine === 0) {
            console.log("[cron-game] WARNING: No total line found for " + pendingGame.game_id + " | bookmaker=" + hrb.key);
            await logError("game-odds", "no_total", "Total line=0 for " + pendingGame.home_team + " vs " + pendingGame.away_team, { game_id: pendingGame.game_id, bookmaker: hrb.key, markets: hrb.markets?.map((m: any) => m.key) ?? [] });
          }

          const homeStats = await fetchTeamRecentStats(pendingGame.home_team);
          const awayStats = await fetchTeamRecentStats(pendingGame.away_team);
          if (!homeStats) {
            console.log("[cron-game] WARNING: homeStats null for " + pendingGame.home_team);
            await logError("game-odds", "no_team_stats", "fetchTeamRecentStats returned null for " + pendingGame.home_team, { team: pendingGame.home_team, game_id: pendingGame.game_id });
          }
          if (!awayStats) {
            console.log("[cron-game] WARNING: awayStats null for " + pendingGame.away_team);
            await logError("game-odds", "no_team_stats", "fetchTeamRecentStats returned null for " + pendingGame.away_team, { team: pendingGame.away_team, game_id: pendingGame.game_id });
          }

          // H2H
          let h2hHomeWins = 0, h2hAwayWins = 0;
          try {
            const homeBdlId = bdlTeamNameToId.get(pendingGame.home_team.toLowerCase());
            const awayBdlId = bdlTeamNameToId.get(pendingGame.away_team.toLowerCase());
            if (homeBdlId && awayBdlId && BALLDONTLIE_API_KEY) {
              const h2hUrl = "https://api.balldontlie.io/v1/games?team_ids[]=" + homeBdlId + "&team_ids[]=" + awayBdlId + "&seasons[]=2025&per_page=10";
              const h2hRes = await fetch(h2hUrl, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
              if (h2hRes.ok) {
                const h2hData = await h2hRes.json();
                for (const g of (h2hData.data || []).filter((g: any) => g.status === "Final")) {
                  const homeWon = g.home_team?.id === homeBdlId ? g.home_team_score > g.visitor_team_score : g.visitor_team_score > g.home_team_score;
                  if (homeWon) h2hHomeWins++; else h2hAwayWins++;
                }
              }
            }
          } catch (_e) { /* ignore */ }

          const homeInj = (bdlInjuriesByTeam.get(pendingGame.home_team.toLowerCase()) || []).filter(i => i.status === "Out" || i.status === "Day-To-Day").map(i => i.playerName + ": " + i.status);
          const awayInj = (bdlInjuriesByTeam.get(pendingGame.away_team.toLowerCase()) || []).filter(i => i.status === "Out" || i.status === "Day-To-Day").map(i => i.playerName + ": " + i.status);

          const SUPA_URL_G = Deno.env.get("SUPABASE_URL") || "";
          const SUPA_KEY_G = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

          if (spreadLine !== 0 && homeStats && awayStats) {
            const sideResult = scoreGameSide(
              { eventId: pendingGame.game_id, homeTeam: pendingGame.home_team, awayTeam: pendingGame.away_team, gameTime: pendingGame.game_time || "",
                spread: { homeSpread: spreadLine, homeOdds: spreadOdds, awaySpread: -spreadLine, awayOdds: -spreadOdds } },
              homeStats, awayStats, homeInj, awayInj, { homeWins: h2hHomeWins, awayWins: h2hAwayWins }
            );
            if (sideResult) {
              // Sonnet analysis (template fallback)
              const sideAISonnet = await getSonnetGameAnalysis(
                "spread", sideResult.side, sideResult.spread, sideResult.confidence,
                sideResult.breakdown, pendingGame.home_team, pendingGame.away_team,
                homeStats, awayStats, { homeWins: h2hHomeWins, awayWins: h2hAwayWins }
              );
              const sideAI = sideAISonnet || generateGameAnalysis(
                "spread", sideResult.side, sideResult.spread, sideResult.confidence,
                sideResult.breakdown, pendingGame.home_team, pendingGame.away_team,
                homeStats, awayStats, { homeWins: h2hHomeWins, awayWins: h2hAwayWins }
              );
              // D-171 (May 14, 2026): game-path verdict reconciliation. Mirror of
              // D-168 player-path but for spread picks. Logs ai_verdict_mismatch_game
              // when AI's TAKE/LEAN/FADE diverges from the algorithm tier.
              await reconcileAndLogVerdict(
                sideAI,
                sideResult.confidence,
                getScoreLabel(sideResult.confidence),
                "ai_verdict_mismatch_game",
                {
                  prop: "spread",
                  line: sideResult.spread,
                  pickSide: sideResult.side,
                  engine: "sonnet-game-spread",
                  matchup: pendingGame.away_team + " @ " + pendingGame.home_team,
                },
              );
              const sbd = sideResult.breakdown || {};
              // Log to pick_history
              const spreadRow = {
                player_name: sideResult.team, team: sideResult.team,
                opponent: sideResult.side === "home" ? pendingGame.away_team : pendingGame.home_team,
                game_time: formatGameTime(pendingGame.game_time || ""), game_date: gameDate,
                prop_type: "spread", line: sideResult.spread, pick_side: sideResult.side,
                // D-560 — odds patched below to best-available same-line price.
                odds: sideResult.odds, confidence: sideResult.confidence, verdict: getScoreLabel(sideResult.confidence),
                ai_analysis: sideAI, source: "process-games", recommendation_shown: sideResult.confidence >= 70,
                score_l10_form: sbd.l10Form ?? null, score_ha_record: sbd.homeAwayRecord ?? null,
                score_point_diff: sbd.pointDiffEdge ?? null, score_rest_advantage: sbd.restAdvantage ?? null,
                score_scoring_trend: sbd.scoringTrend ?? null, score_h2h: sbd.headToHead ?? null,
                score_sos: sbd.strengthOfSchedule ?? null, score_net_rating: sbd.netRating ?? null,
              };
              // D-560 — hoist spreadAvailableBooks BEFORE the pick_history write
              // so we can compute best-available same-line same-side primary
              // and patch spreadRow.odds + recommendations_cache bookmaker.
              const spreadAvailableBooks: Array<{ bookmaker: string; line: number; odds: number; pick_side: string }> = [];
              for (const bk of (gameOddsData.bookmakers ?? [])) {
                const mkt = (bk.markets ?? []).find((m: any) => m.key === "spreads");
                if (!mkt) continue;
                const homeOutcome = (mkt.outcomes ?? []).find((o: any) => o.name === pendingGame.home_team);
                const awayOutcome = (mkt.outcomes ?? []).find((o: any) => o.name === pendingGame.away_team);
                if (homeOutcome && typeof homeOutcome.point === "number") {
                  spreadAvailableBooks.push({ bookmaker: bk.key, line: homeOutcome.point, odds: homeOutcome.price ?? -110, pick_side: "home" });
                }
                if (awayOutcome && typeof awayOutcome.point === "number") {
                  spreadAvailableBooks.push({ bookmaker: bk.key, line: awayOutcome.point, odds: awayOutcome.price ?? -110, pick_side: "away" });
                }
              }
              const _spPrimary = selectBestSameLineBook(
                spreadAvailableBooks, sideResult.spread, sideResult.side, hrb.key, sideResult.odds,
              );
              const _spOdds = _spPrimary?.odds ?? sideResult.odds;
              const _spBook = _spPrimary?.bookmaker ?? hrb.key;
              spreadRow.odds = _spOdds;
              // D-253f: skip spread pick_history POST in dry-run.
              if (_dryRun) {
                _dryRunCounts.pick_history++;
              } else {
                await fetch(SUPA_URL_G + "/rest/v1/pick_history", {
                  method: "POST", headers: { "apikey": SUPA_KEY_G, "Authorization": "Bearer " + SUPA_KEY_G, "Content-Type": "application/json", "Prefer": "resolution=ignore-duplicates" },
                  body: JSON.stringify(spreadRow),
                });
              }
              // Log to recommendations_cache
              const { source: _s1, recommendation_shown: _r1, ...spreadCacheRow } = spreadRow as any;
              // D-253f: skip recommendations_cache POST in dry-run; synthesize success.
              if (_dryRun) {
                _dryRunCounts.recommendations_cache++;
                spreadWritten = true;
                console.log("[cron-game] [dry-run] SPREAD WOULD WRITE: " + sideResult.team + " " + sideResult.spread + " conf=" + sideResult.confidence);
              } else {
                const spreadCacheRes = await fetch(SUPA_URL_G + "/rest/v1/recommendations_cache?on_conflict=game_date,player_name,prop_type,pick_side", {
                  method: "POST", headers: { "apikey": SUPA_KEY_G, "Authorization": "Bearer " + SUPA_KEY_G, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
                  body: JSON.stringify({
                    ...spreadCacheRow, game_id: pendingGame.game_id,
                    hit_rates_display: { l5: "", l10: "", season: "" },
                    breakdown: sideResult.breakdown,
                    team_stats: { home: homeStats, away: awayStats, h2h: { homeWins: h2hHomeWins, awayWins: h2hAwayWins } },
                    // D-560 — primary bookmaker = best-available same-line book (HRB kept w/in 5c).
                    bookmaker: _spBook,
                    available_books: spreadAvailableBooks,
                  }),
                });
                spreadWritten = spreadCacheRes.ok;
                if (!spreadCacheRes.ok) {
                  await logError("game-odds", "cache_write_failed", "recommendations_cache POST failed for spread (status=" + spreadCacheRes.status + ")", { game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team });
                }
                console.log("[cron-game] SPREAD: " + sideResult.team + " " + sideResult.spread + " conf=" + sideResult.confidence + " cache=" + spreadCacheRes.status);
              }
            }
          }

          if (totalLine > 0 && homeStats && awayStats) {
            const totalResult = scoreGameTotal(
              { eventId: pendingGame.game_id, homeTeam: pendingGame.home_team, awayTeam: pendingGame.away_team, gameTime: pendingGame.game_time || "",
                total: { line: totalLine, overOdds: totalOverOdds, underOdds: totalUnderOdds } },
              homeStats, awayStats
            );
            if (totalResult) {
              const totalAISonnet = await getSonnetGameAnalysis(
                "total", totalResult.side, totalResult.total, totalResult.confidence,
                totalResult.breakdown, pendingGame.home_team, pendingGame.away_team,
                homeStats, awayStats, { homeWins: h2hHomeWins, awayWins: h2hAwayWins }
              );
              const totalAI = totalAISonnet || generateGameAnalysis(
                "total", totalResult.side, totalResult.total, totalResult.confidence,
                totalResult.breakdown, pendingGame.home_team, pendingGame.away_team,
                homeStats, awayStats, { homeWins: h2hHomeWins, awayWins: h2hAwayWins }
              );
              const matchup = pendingGame.home_team + " vs " + pendingGame.away_team;
              // D-171 (May 14, 2026): game-path verdict reconciliation for totals.
              await reconcileAndLogVerdict(
                totalAI,
                totalResult.confidence,
                getScoreLabel(totalResult.confidence),
                "ai_verdict_mismatch_game",
                {
                  prop: "total",
                  line: totalResult.total,
                  pickSide: totalResult.side,
                  engine: "sonnet-game-total",
                  matchup,
                },
              );
              const tbd = totalResult.breakdown || {};
              // D-560 — hoist totalAvailableBooks BEFORE the row construction so
              // we can patch odds + pick the best-available bookmaker.
              const totalAvailableBooks: Array<{ bookmaker: string; line: number; odds: number; pick_side: string }> = [];
              for (const bk of (gameOddsData.bookmakers ?? [])) {
                const mkt = (bk.markets ?? []).find((m: any) => m.key === "totals");
                if (!mkt) continue;
                const overOutcome = (mkt.outcomes ?? []).find((o: any) => o.name === "Over");
                const underOutcome = (mkt.outcomes ?? []).find((o: any) => o.name === "Under");
                if (overOutcome && typeof overOutcome.point === "number") {
                  totalAvailableBooks.push({ bookmaker: bk.key, line: overOutcome.point, odds: overOutcome.price ?? -110, pick_side: "over" });
                }
                if (underOutcome && typeof underOutcome.point === "number") {
                  totalAvailableBooks.push({ bookmaker: bk.key, line: underOutcome.point, odds: underOutcome.price ?? -110, pick_side: "under" });
                }
              }
              const _totPrimary = selectBestSameLineBook(
                totalAvailableBooks, totalResult.total, totalResult.side, hrb.key, totalResult.odds,
              );
              const _totOdds = _totPrimary?.odds ?? totalResult.odds;
              const _totBook = _totPrimary?.bookmaker ?? hrb.key;
              const totalRow = {
                player_name: matchup, team: pendingGame.home_team, opponent: pendingGame.away_team,
                game_time: formatGameTime(pendingGame.game_time || ""), game_date: gameDate,
                prop_type: "game_total", line: totalResult.total, pick_side: totalResult.side,
                odds: _totOdds, confidence: totalResult.confidence, verdict: getScoreLabel(totalResult.confidence),
                ai_analysis: totalAI, source: "process-games", recommendation_shown: totalResult.confidence >= 70,
                score_l10_form: tbd.l10Scoring ?? null, score_point_diff: tbd.pointDiffTotal ?? null,
                score_rest_advantage: tbd.restImpact ?? null, score_scoring_trend: tbd.scoringTrend ?? null,
                score_sos: tbd.scheduleStrength ?? null, score_net_rating: tbd.netRatingTotal ?? null,
              };
              // D-253f: skip total pick_history POST in dry-run.
              if (_dryRun) {
                _dryRunCounts.pick_history++;
              } else {
                await fetch(SUPA_URL_G + "/rest/v1/pick_history", {
                  method: "POST", headers: { "apikey": SUPA_KEY_G, "Authorization": "Bearer " + SUPA_KEY_G, "Content-Type": "application/json", "Prefer": "resolution=ignore-duplicates" },
                  body: JSON.stringify(totalRow),
                });
              }
              const { source: _s2, recommendation_shown: _r2, ...totalCacheRow } = totalRow as any;
              // D-253f: skip recommendations_cache POST in dry-run; synthesize success.
              if (_dryRun) {
                _dryRunCounts.recommendations_cache++;
                totalWritten = true;
                console.log("[cron-game] [dry-run] TOTAL WOULD WRITE: " + matchup + " " + totalResult.side + " " + totalResult.total + " conf=" + totalResult.confidence);
              } else {
                const totalCacheRes = await fetch(SUPA_URL_G + "/rest/v1/recommendations_cache?on_conflict=game_date,player_name,prop_type,pick_side", {
                  method: "POST", headers: { "apikey": SUPA_KEY_G, "Authorization": "Bearer " + SUPA_KEY_G, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
                  body: JSON.stringify({
                    ...totalCacheRow, game_id: pendingGame.game_id,
                    hit_rates_display: { l5: "", l10: "", season: "" },
                    breakdown: totalResult.breakdown,
                    team_stats: { home: homeStats, away: awayStats, h2h: { homeWins: h2hHomeWins, awayWins: h2hAwayWins } },
                    // D-560 — primary bookmaker = best-available same-line book (HRB kept w/in 5c).
                    bookmaker: _totBook,
                    available_books: totalAvailableBooks,
                  }),
                });
                totalWritten = totalCacheRes.ok;
                if (!totalCacheRes.ok) {
                  await logError("game-odds", "cache_write_failed", "recommendations_cache POST failed for total (status=" + totalCacheRes.status + ")", { game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team });
                }
                console.log("[cron-game] TOTAL: " + matchup + " " + totalResult.side + " " + totalResult.total + " conf=" + totalResult.confidence + " cache=" + totalCacheRes.status);
              }
            }
          }
        }
      }
    } catch (gameErr) {
      console.log("[cron-game] FATAL Error: " + String(gameErr));
      await logError("game-odds", "fatal", "Game scoring crashed: " + String(gameErr), { game_id: pendingGame.game_id, home: pendingGame.home_team, away: pendingGame.away_team });
    }

    // Step 8: AI analysis for 70+ confidence picks
    // Add opponent to each result (scoreOneSide doesn't set it)
    for (const { result, prop } of allResults) {
      if (!result.opponent) {
        result.opponent = normalizeTeamName(prop.homeTeam) === normalizeTeamName(result.team) ? prop.awayTeam : prop.homeTeam;
      }
    }

    const highConf = allResults.filter(({ result }) => result.confidence >= 70);
    highConf.sort((a, b) => b.result.confidence - a.result.confidence);
    console.log("[cron] " + highConf.length + " picks >= 70 for AI analysis");

    // Generate Sonnet analysis (template fallback if API fails or time runs out)
    let aiCompleted = 0;
    for (const { result } of highConf) {
      if (Date.now() - startTime > MAX_PROCESSING_MS - 15000) {
        try { result.aiAnalysis = generatePlayerAnalysis(result); } catch (_e) { result.aiAnalysis = "Analysis unavailable"; }
        aiCompleted++;
        continue;
      }
      try {
        const sonnetResult = await getSonnetAnalysis(result, gameDate);
        result.aiAnalysis = sonnetResult || generatePlayerAnalysis(result);
      } catch (_e) {
        try { result.aiAnalysis = generatePlayerAnalysis(result); } catch (_e2) { result.aiAnalysis = "Analysis unavailable"; }
      }
      // D-168 (May 14, 2026): post-hoc reconcile AI verdict vs algorithm.
      // D-171 (May 14, 2026): refactored to shared reconcileAndLogVerdict.
      // Subscriber text is unchanged — observability-only logging.
      await reconcileAndLogVerdict(
        result.aiAnalysis,
        result.confidence,
        result.verdict || "Pass",
        "ai_verdict_mismatch",
        {
          player: result.playerName,
          prop: result.propType,
          line: result.line,
          pickSide: result.pickSide,
          engine: "sonnet-player",
        },
      );
      aiCompleted++;
      await new Promise(r => setTimeout(r, 300));
    }
    runStats.aiGenerated = aiCompleted;
    console.log("[cron] Sonnet analysis: " + aiCompleted + "/" + highConf.length);

    // Step 9: Write to pick_history AND recommendations_cache
    for (const { result, prop } of allResults) {
      const isRecommended = result.confidence >= 70;
      // D-169 (May 14, 2026): final safety net for AI coverage. Diagnostic
      // showed historical 1.1% null-rate on >=70 picks (2 rows, both Apr 29).
      // Current code already chains Sonnet → template → "Analysis unavailable"
      // literal, but in case any path reaches the write loop with null/empty
      // aiAnalysis on a recommended pick, fill via template + log to error_log
      // so CEO sees the coverage gap. Closes framework §15.1 open issue.
      if (isRecommended && (!result.aiAnalysis || !result.aiAnalysis.trim())) {
        try {
          const lastResortTemplate = generatePlayerAnalysis(result);
          result.aiAnalysis = (lastResortTemplate && lastResortTemplate.trim())
            ? lastResortTemplate
            : `Algorithm confidence ${result.confidence}/100 (${result.verdict || "ranked"}). See factor breakdown for detail.`;
        } catch {
          result.aiAnalysis = `Algorithm confidence ${result.confidence}/100. Analysis unavailable.`;
        }
        await logErrorStructured("warning", {
          function_name: "process-games",
          phase: "ai-coverage-safety-net",
          error_type: "ai_analysis_missing_at_write",
          message: ">=70 pick reached write loop with null/empty aiAnalysis — safety-net fill applied",
          payload: {
            player: result.playerName,
            prop: result.propType,
            confidence: result.confidence,
            verdict: result.verdict,
          },
        });
      }
      await logPickToHistory(result, prop, isRecommended, result.aiAnalysis ?? null);
      await logToRecommendationsCache(result, prop, gameDate, pendingGame.game_id);
    }
    console.log("[cron] Logged " + allResults.length + " to pick_history + recommendations_cache");

    // Step 10: Mark complete only if spread AND total both wrote to recommendations_cache.
    // Any failure path in the game-odds block (api_failure, no_bookmaker, no_spread, no_total,
    // no_team_stats, cache_write_failed, fatal) leaves one of the flags false, so we revert to
    // 'pending' and the next cron run retries. Props + pick_history writes above are idempotent
    // (ignore-duplicates / merge-duplicates) so re-running is safe.
    const recsCount = allResults.filter(r => r.result.confidence >= 70).length;
    const gameOddsComplete = spreadWritten && totalWritten;
    // D-253f: skip the final cron_progress PATCH in dry-run; just count it.
    if (_dryRun) {
      _dryRunCounts.cron_progress++;
    } else if (gameOddsComplete) {
      await fetch(SUPA_URL + "/rest/v1/cron_progress?id=eq." + pendingGame.id, {
        method: "PATCH",
        headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "complete", completed_at: new Date().toISOString(),
          props_scored: allResults.length, picks_recommended: recsCount,
        }),
      });
    } else {
      console.log("[cron] Game-odds incomplete (spread=" + spreadWritten + " total=" + totalWritten + ") — reverting to pending for retry");
      await fetch(SUPA_URL + "/rest/v1/cron_progress?id=eq." + pendingGame.id, {
        method: "PATCH",
        headers: { "apikey": SUPA_KEY, "Authorization": "Bearer " + SUPA_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "pending", started_at: null,
          props_scored: allResults.length, picks_recommended: recsCount,
        }),
      });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const completedGames = progressRows.filter((r: any) => r.status === "complete").length + (gameOddsComplete ? 1 : 0);
    const totalGames = progressRows.length;

    console.log("[cron] === DONE: " + pendingGame.away_team + " @ " + pendingGame.home_team + " | " + allResults.length + " props | " + elapsed + "s | status=" + (gameOddsComplete ? "complete" : "pending-retry") + " ===");
    console.log("[cron] Progress: " + completedGames + "/" + totalGames + " games");

    runStats.recommendations = recsCount;
    await logRun("success");

    // D-253f: include a sample of the first scored pick so dry-run callers
    // can sanity-check the scoring pipeline.
    const samplePick = allResults.length > 0 ? {
      player: allResults[0].result.playerName,
      prop: allResults[0].result.propType,
      line: allResults[0].result.line,
      pick_side: allResults[0].result.pickSide,
      confidence: allResults[0].result.confidence,
      verdict: allResults[0].result.verdict,
      breakdown: allResults[0].result.breakdown,
    } : null;

    if (_dryRun) {
      return jsonResponse({
        dry_run: true,
        success: true,
        game: pendingGame.away_team + " @ " + pendingGame.home_team,
        propsScored: allResults.length,
        picksRecommended: recsCount,
        aiGenerated: aiCompleted,
        elapsed: elapsed + "s",
        progress: completedGames + "/" + totalGames + " games",
        would_write: _dryRunCounts,
        sample_pick: samplePick,
        elapsed_ms: Date.now() - startTime,
      });
    }

    // D-272-INF-2: heartbeat success.
    await writeHeartbeat({ jobName: "process-games", status: "success", durationMs: Date.now() - startTime });
    return jsonResponse({
      success: true,
      game: pendingGame.away_team + " @ " + pendingGame.home_team,
      propsScored: allResults.length,
      picksRecommended: recsCount,
      aiGenerated: aiCompleted,
      elapsed: elapsed + "s",
      progress: completedGames + "/" + totalGames + " games",
    });

  } catch (err) {
    console.error("[process-games] FATAL:", err);
    await logError("fatal", "crash", err instanceof Error ? err.message : String(err));
    // OBS-02: surface fatal handler errors to Sentry. Non-blocking; existing
    // error_log + run_log + notify paths preserved.
    await captureError(err, {
      function: "process-games",
      phase: "top-level-handler",
      run_stats: {
        gamesFound: runStats.gamesFound,
        propsScored: runStats.propsScored,
        recommendations: runStats.recommendations,
        errorsCount: runStats.errorsCount,
      },
    });
    await logRun("failed");
    // D-272-INF-2: heartbeat error.
    await writeHeartbeat({ jobName: "process-games", status: "error", durationMs: Date.now() - startTime, error: err instanceof Error ? err.message : String(err) });
    return jsonResponse({ success: false, error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
