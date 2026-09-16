// fetch-team-advanced-stats — D-186 Phase 1 (May 15, 2026, CEO §19.3).
//
// Daily snapshot writer for BDL GOAT-tier /v1/stats/advanced. Produces:
//   1) per-team team-level GOAT advanced metrics → UPSERT into
//      cache_opponent_defensive_stats (extension columns added by migration
//      20260515000004_d186_cache_team_advanced_stats.sql).
//   2) per-team per-opposing-position advanced metrics → UPSERT into
//      cache_team_advanced_stats_by_position (new table same migration).
//
// METHOD:
//   • Pull /v1/stats/advanced for the last N=10 NBA game dates ending on
//     snapshot_date (skips empty days automatically via dates[]= query).
//   • Each row contains player.position, team.id, game.{id, home_team_id,
//     visitor_team_id}, and 12 advanced metrics (defensive_rating,
//     offensive_rating, net_rating, pace, pie, true_shooting_percentage,
//     assist_percentage, offensive_rebound_percentage,
//     defensive_rebound_percentage, effective_field_goal_percentage,
//     usage_percentage, assist_to_turnover).
//   • Phase A aggregate: per-team average of OWN players' advanced
//     metrics (the team's "self" rating set).
//   • Phase B aggregate: per (opponent_team, opp_position) average — i.e.
//     "what team Y allowed to opposing position X this window".
//
// RATE LIMIT: BDL GOAT is documented at 600 req/min but task observation
//   was sustained empties at higher rates. Conservative 1100ms gap (~55/min)
//   matches snapshot-opp-stats and stays well under any plausible cap.
//
// AUTH: service-role gated via BACKFILL_AUTH_TOKEN || SUPABASE_SERVICE_ROLE_KEY.
//
// IDEMPOTENT: full UPSERT keyed on (team_name, snapshot_date, sport) for
//   cache_opponent_defensive_stats and (team_abbr, position, snapshot_date,
//   sport) for the per-position table. Re-running for the same date overwrites
//   without conflict.
//
// REQUEST BODY:
//   { snapshot_date?: "YYYY-MM-DD" }   // defaults to today ET (matches
//                                       // snapshot-opp-stats convention).
//   { date_range_end?: "YYYY-MM-DD", lookback_days?: number }  // historical
//                                                               // backfill mode
//                                                               // (D-186 Phase 3).
//
// COMPANION: scheduled via pg_cron at 13:00 UTC daily, before process-games'
//   14:00 UTC tick (so today's slate scores against today's GOAT snapshot).
//   Schedule SQL applied via /tmp/d186_phase1_schedule_cron.sql.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const BDL_API_BASE = "https://api.balldontlie.io/v1";
const LOOKBACK_DAYS_DEFAULT = 10;
const MIN_CALL_GAP_MS = 1100;
let lastBdlCallMs = 0;

interface BdlTeam { id: number; full_name: string; abbreviation: string; }
interface BdlAdvancedRow {
  player: { id: number; first_name: string; last_name: string; position: string | null };
  team:   { id: number; abbreviation: string };
  game:   { id: number; date: string; home_team_id: number; visitor_team_id: number };
  defensive_rating?:                number | null;
  offensive_rating?:                number | null;
  net_rating?:                      number | null;
  pace?:                            number | null;
  pie?:                             number | null;
  true_shooting_percentage?:        number | null;
  assist_percentage?:               number | null;
  offensive_rebound_percentage?:    number | null;
  defensive_rebound_percentage?:    number | null;
  effective_field_goal_percentage?: number | null;
  usage_percentage?:                number | null;
  assist_to_turnover?:              number | null;
}

const ADV_FIELDS = [
  "defensive_rating", "offensive_rating", "net_rating", "pace", "pie",
  "true_shooting_percentage", "assist_percentage",
  "offensive_rebound_percentage", "defensive_rebound_percentage",
  "effective_field_goal_percentage", "usage_percentage", "assist_to_turnover",
] as const;
type AdvField = typeof ADV_FIELDS[number];

async function fetchBdl<T>(path: string, key: string): Promise<{ data: T | null; status: number; bodyHint: string }> {
  const now = Date.now();
  const sinceLast = now - lastBdlCallMs;
  if (sinceLast < MIN_CALL_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_CALL_GAP_MS - sinceLast));
  }
  lastBdlCallMs = Date.now();
  try {
    const res = await fetch(`${BDL_API_BASE}${path}`, { headers: { Authorization: key } });
    const text = await res.text();
    if (!res.ok) return { data: null, status: res.status, bodyHint: text.slice(0, 200) };
    try { return { data: JSON.parse(text) as T, status: res.status, bodyHint: "" }; }
    catch (_e) { return { data: null, status: res.status, bodyHint: "json parse failed" }; }
  } catch (e) {
    return { data: null, status: 0, bodyHint: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchTeams(key: string): Promise<BdlTeam[]> {
  // D-186 Phase 3 hardening: BDL /v1/teams is intermittently empty during
  // sustained orchestration (~80% fail rate observed at 5s inter-date sleep).
  // Three retries with exponential backoff, then DB fallback in caller.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
    const r = await fetchBdl<{ data: BdlTeam[] }>("/teams", key);
    if (r.data && Array.isArray(r.data.data)) {
      const filtered = r.data.data.filter((t) => t.id >= 1 && t.id <= 30);
      if (filtered.length > 0) return filtered;
    }
  }
  return [];
}

// D-186 hardening fallback: hardcoded 30 NBA teams. Mirrors BDL /v1/teams
// canonical full_name + abbreviation. Used when BDL /v1/teams returns empty
// across all retries (intermittent issue observed in sustained orchestration).
// IDs match BDL's stable 1-30 numbering. This list does NOT need to track
// future relocations/rebrands frequently — these values are stable for years.
const STATIC_NBA_TEAMS: readonly BdlTeam[] = [
  { id: 1,  full_name: "Atlanta Hawks",          abbreviation: "ATL" },
  { id: 2,  full_name: "Boston Celtics",         abbreviation: "BOS" },
  { id: 3,  full_name: "Brooklyn Nets",          abbreviation: "BKN" },
  { id: 4,  full_name: "Charlotte Hornets",      abbreviation: "CHA" },
  { id: 5,  full_name: "Chicago Bulls",          abbreviation: "CHI" },
  { id: 6,  full_name: "Cleveland Cavaliers",    abbreviation: "CLE" },
  { id: 7,  full_name: "Dallas Mavericks",       abbreviation: "DAL" },
  { id: 8,  full_name: "Denver Nuggets",         abbreviation: "DEN" },
  { id: 9,  full_name: "Detroit Pistons",        abbreviation: "DET" },
  { id: 10, full_name: "Golden State Warriors",  abbreviation: "GSW" },
  { id: 11, full_name: "Houston Rockets",        abbreviation: "HOU" },
  { id: 12, full_name: "Indiana Pacers",         abbreviation: "IND" },
  { id: 13, full_name: "LA Clippers",            abbreviation: "LAC" },
  { id: 14, full_name: "Los Angeles Lakers",     abbreviation: "LAL" },
  { id: 15, full_name: "Memphis Grizzlies",      abbreviation: "MEM" },
  { id: 16, full_name: "Miami Heat",             abbreviation: "MIA" },
  { id: 17, full_name: "Milwaukee Bucks",        abbreviation: "MIL" },
  { id: 18, full_name: "Minnesota Timberwolves", abbreviation: "MIN" },
  { id: 19, full_name: "New Orleans Pelicans",   abbreviation: "NOP" },
  { id: 20, full_name: "New York Knicks",        abbreviation: "NYK" },
  { id: 21, full_name: "Oklahoma City Thunder",  abbreviation: "OKC" },
  { id: 22, full_name: "Orlando Magic",          abbreviation: "ORL" },
  { id: 23, full_name: "Philadelphia 76ers",     abbreviation: "PHI" },
  { id: 24, full_name: "Phoenix Suns",           abbreviation: "PHX" },
  { id: 25, full_name: "Portland Trail Blazers", abbreviation: "POR" },
  { id: 26, full_name: "Sacramento Kings",       abbreviation: "SAC" },
  { id: 27, full_name: "San Antonio Spurs",      abbreviation: "SAS" },
  { id: 28, full_name: "Toronto Raptors",        abbreviation: "TOR" },
  { id: 29, full_name: "Utah Jazz",              abbreviation: "UTA" },
  { id: 30, full_name: "Washington Wizards",     abbreviation: "WAS" },
];

// Build the date list to query. We use a fixed-window LOOKBACK of N days,
// ending on `endDate` inclusive, formatted as YYYY-MM-DD.
function buildDateList(endDate: string, lookbackDays: number): string[] {
  const end = new Date(`${endDate}T12:00:00Z`);
  const dates: string[] = [];
  for (let i = 0; i < lookbackDays; i++) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// Pull advanced rows across the date window with cursor pagination.
async function fetchAdvancedRows(key: string, dates: string[]): Promise<{ rows: BdlAdvancedRow[]; calls: number; lastError: string | null }> {
  const datesQ = dates.map((d) => `dates[]=${d}`).join("&");
  const rows: BdlAdvancedRow[] = [];
  let cursor = "";
  let safety = 0;
  let calls = 0;
  let lastError: string | null = null;
  while (safety++ < 50) {
    const cursorParam = cursor ? `&cursor=${cursor}` : "";
    const r = await fetchBdl<{ data: BdlAdvancedRow[]; meta?: { next_cursor?: string | null } }>(
      `/stats/advanced?${datesQ}&per_page=100${cursorParam}`,
      key,
    );
    calls++;
    if (r.status !== 200) {
      lastError = `status=${r.status} hint=${r.bodyHint}`;
      break;
    }
    if (!r.data || !Array.isArray(r.data.data)) {
      lastError = "status=200 but no data array";
      break;
    }
    for (const row of r.data.data) rows.push(row);
    const next = r.data.meta?.next_cursor;
    if (!next) break;
    cursor = String(next);
  }
  return { rows, calls, lastError };
}

// Position normalizer — BDL feed has "G", "F", "C", "G-F", "F-C" etc. Pick
// the FIRST listed token and map to canonical PG/SG/SF/PF/C bucket. For
// generic G or F, we bucket to SG and SF respectively as best guess (these
// rows still aggregate into a usable per-opp-position signal).
function normalizePosition(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const head = raw.trim().split("-")[0].toUpperCase();
  if (head === "PG") return "PG";
  if (head === "SG") return "SG";
  if (head === "SF") return "SF";
  if (head === "PF") return "PF";
  if (head === "C")  return "C";
  if (head === "G")  return "SG";  // best-effort fallback
  if (head === "F")  return "SF";  // best-effort fallback
  return null;
}

function safeNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Running mean accumulator
class Accumulator {
  private sums = new Map<AdvField, number>();
  private counts = new Map<AdvField, number>();
  private rowCount = 0;
  add(row: BdlAdvancedRow) {
    this.rowCount++;
    for (const f of ADV_FIELDS) {
      const v = safeNum(row[f]);
      if (v === null) continue;
      this.sums.set(f, (this.sums.get(f) ?? 0) + v);
      this.counts.set(f, (this.counts.get(f) ?? 0) + 1);
    }
  }
  count(): number { return this.rowCount; }
  averages(): Record<AdvField, number | null> {
    const out = {} as Record<AdvField, number | null>;
    for (const f of ADV_FIELDS) {
      const c = this.counts.get(f) ?? 0;
      out[f] = c > 0 ? (this.sums.get(f) as number) / c : null;
    }
    return out;
  }
}

async function logRunRow(
  url: string, key: string, snapshotDate: string,
  teamsProcessed: number, byPositionRows: number, apiCalls: number, errors: number, durationMs: number,
  status: string, notes: string,
): Promise<void> {
  try {
    await fetch(`${url}/rest/v1/run_log`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        function_name: "fetch-team-advanced-stats",
        duration_ms: durationMs,
        games_found: teamsProcessed,
        props_fetched: byPositionRows,
        errors_count: errors,
        status,
        notes: `snapshot_date=${snapshotDate} ${notes}`.slice(0, 1000),
      }),
    });
  } catch (_e) { /* silent */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startMs = Date.now();
  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  // D-366 SHIP 5 — separate the OUTGOING PostgREST apikey from the INCOMING auth gate.
  //   restApiKey must be a real Supabase service-role key (JWT or sb_secret_-format)
  //   because PostgREST validates it. BACKFILL_AUTH_TOKEN can be a UUID that
  //   PostgREST will 401 — only safe as an incoming-bearer alias.
  const restApiKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const customToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
  const supaKey = restApiKey; // alias for downstream code that still calls it supaKey.
  const bdlKey = Deno.env.get("BALLDONTLIE_API_KEY") || "";

  if (!supaUrl || !restApiKey) return jsonResponse({ success: false, error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  if (!bdlKey) return jsonResponse({ success: false, error: "BALLDONTLIE_API_KEY not set" }, 500);

  // Incoming auth gate accepts either the service-role key or the BACKFILL handshake token.
  const auth = req.headers.get("authorization") || "";
  const matches = (restApiKey && auth.includes(restApiKey)) || (customToken && auth.includes(customToken));
  if (!matches) return jsonResponse({ success: false, error: "service_role key required" }, 401);

  // Parse body
  let body: { snapshot_date?: string; date_range_end?: string; lookback_days?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }

  // D-262 dry-run gate: short-circuit BEFORE BDL /v1/stats/advanced API call.
  // The function makes ~5-15 BDL calls per invocation and writes to 2 cache
  // tables + run_log. In dry-run we skip everything (BDL quota + writes).
  const dryRun = body.dry_run === true;

  // Default snapshot_date = today ET (matches snapshot-opp-stats convention).
  const easternNow = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const snapshotDate = body.snapshot_date || body.date_range_end || easternNow.toISOString().slice(0, 10);
  const lookbackDays = body.lookback_days ?? LOOKBACK_DAYS_DEFAULT;

  // Build window
  const dateList = buildDateList(snapshotDate, lookbackDays);

  if (dryRun) {
    return jsonResponse({
      dry_run: true,
      snapshot_date: snapshotDate,
      lookback_days: lookbackDays,
      dates_queried: dateList,
      would_write: {
        cache_opponent_defensive_stats: null,  // up to 30 teams (BDL skipped, unknown)
        cache_team_advanced_stats_by_position: null,  // up to 30 × 5 positions
        run_log: 0,  // logRunRow suppressed
        notifications_log: 0,  // notify() suppressed
      },
      note: "fetch-team-advanced-stats skipped BDL API + writes entirely",
      elapsed_ms: Date.now() - startMs,
    });
  }

  // Pull teams (for abbreviation map + full_name → team_name UPSERT key).
  // D-186 Phase 3 hardening: fall back to STATIC_NBA_TEAMS when BDL refuses
  // (canonical full_name + abbreviation hardcoded — values stable for years).
  let teams = await fetchTeams(bdlKey);
  let teamsSource = "bdl";
  if (teams.length === 0) {
    teams = [...STATIC_NBA_TEAMS];
    teamsSource = "static_fallback";
  }
  const teamById = new Map<number, BdlTeam>();
  for (const t of teams) teamById.set(t.id, t);

  // Pull all advanced rows across the date window.
  const { rows, calls, lastError } = await fetchAdvancedRows(bdlKey, dateList);
  if (rows.length === 0) {
    const msg = `0 advanced rows over ${dateList.length} dates (${dateList[dateList.length - 1]}..${dateList[0]}): ${lastError ?? "empty"}`;
    await logRunRow(supaUrl, supaKey, snapshotDate, 0, 0, calls + 1, 1, Date.now() - startMs, "failed", msg);
    return jsonResponse({ success: false, error: msg, dates_queried: dateList, bdl_calls: calls + 1 }, 200);
  }

  // Phase A: per-team self accumulator (team_id → Accumulator)
  const perTeam = new Map<number, Accumulator>();
  // Phase B: per (opp_team_id, position) accumulator
  const perTeamPosition = new Map<string, { teamId: number; position: string; acc: Accumulator; games: Set<number>; players: Set<number> }>();
  const perTeamGames = new Map<number, Set<number>>();
  const perTeamPlayers = new Map<number, Set<number>>();

  for (const row of rows) {
    const teamId = row.team?.id;
    if (!teamId || !teamById.has(teamId)) continue;
    // Team-self
    if (!perTeam.has(teamId)) perTeam.set(teamId, new Accumulator());
    perTeam.get(teamId)!.add(row);
    if (!perTeamGames.has(teamId)) perTeamGames.set(teamId, new Set());
    perTeamGames.get(teamId)!.add(row.game?.id);
    if (!perTeamPlayers.has(teamId)) perTeamPlayers.set(teamId, new Set());
    perTeamPlayers.get(teamId)!.add(row.player?.id);

    // Opp-position aggregate: this row's player belongs to teamId; the
    // opponent in this game (home or visitor opposite) defended against
    // this player. Bucket the row under (oppTeamId, this player's position).
    const home = row.game?.home_team_id;
    const visitor = row.game?.visitor_team_id;
    const oppTeamId = teamId === home ? visitor : (teamId === visitor ? home : null);
    if (!oppTeamId || !teamById.has(oppTeamId)) continue;
    const pos = normalizePosition(row.player?.position);
    if (!pos) continue;
    const k = `${oppTeamId}|${pos}`;
    let bucket = perTeamPosition.get(k);
    if (!bucket) {
      bucket = { teamId: oppTeamId, position: pos, acc: new Accumulator(), games: new Set(), players: new Set() };
      perTeamPosition.set(k, bucket);
    }
    bucket.acc.add(row);
    if (row.game?.id) bucket.games.add(row.game.id);
    if (row.player?.id) bucket.players.add(row.player.id);
  }

  // UPSERT Phase A — cache_opponent_defensive_stats (extension columns).
  let teamsProcessed = 0;
  let teamsFailed = 0;
  const teamErrors: string[] = [];
  for (const [teamId, acc] of perTeam.entries()) {
    const t = teamById.get(teamId);
    if (!t) continue;
    const avg = acc.averages();
    const upsertRes = await fetch(
      `${supaUrl}/rest/v1/cache_opponent_defensive_stats?on_conflict=team_name,snapshot_date,sport`,
      {
        method: "POST",
        headers: {
          apikey: supaKey, Authorization: `Bearer ${supaKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          team_name: t.full_name,
          snapshot_date: snapshotDate,
          bdl_team_id: t.id,
          // OVERWRITE the legacy team-level metrics with GOAT values (more authoritative)
          def_rating: avg.defensive_rating,
          pace: avg.pace,
          net_rating: avg.net_rating,
          // New GOAT extension columns
          offensive_rating:                avg.offensive_rating,
          pie:                             avg.pie,
          true_shooting_percentage:        avg.true_shooting_percentage,
          assist_percentage:               avg.assist_percentage,
          offensive_rebound_percentage:    avg.offensive_rebound_percentage,
          defensive_rebound_percentage:    avg.defensive_rebound_percentage,
          effective_field_goal_percentage: avg.effective_field_goal_percentage,
          usage_percentage:                avg.usage_percentage,
          assist_to_turnover:              avg.assist_to_turnover,
          goat_stats_source: "bdl_goat_stats_advanced",
          sport: "nba",
        }),
      },
    );
    if (upsertRes.ok) teamsProcessed++;
    else {
      teamsFailed++;
      const txt = await upsertRes.text();
      teamErrors.push(`${t.full_name}: ${upsertRes.status} ${txt.slice(0, 120)}`);
    }
  }

  // UPSERT Phase B — cache_team_advanced_stats_by_position.
  // Insert in batches of 50 for efficiency.
  let byPositionRows = 0;
  const byPositionRowsErrors: string[] = [];
  const bpBatch: Record<string, unknown>[] = [];
  for (const bucket of perTeamPosition.values()) {
    const t = teamById.get(bucket.teamId);
    if (!t) continue;
    const avg = bucket.acc.averages();
    bpBatch.push({
      team_abbr: t.abbreviation,
      position: bucket.position,
      snapshot_date: snapshotDate,
      games_sampled: bucket.games.size,
      players_sampled: bucket.players.size,
      defensive_rating: avg.defensive_rating,
      offensive_rating: avg.offensive_rating,
      net_rating: avg.net_rating,
      pace: avg.pace,
      pie: avg.pie,
      true_shooting_percentage: avg.true_shooting_percentage,
      assist_percentage: avg.assist_percentage,
      offensive_rebound_percentage: avg.offensive_rebound_percentage,
      defensive_rebound_percentage: avg.defensive_rebound_percentage,
      effective_field_goal_percentage: avg.effective_field_goal_percentage,
      usage_percentage: avg.usage_percentage,
      assist_to_turnover: avg.assist_to_turnover,
      sport: "nba",
    });
  }
  const BATCH_SIZE = 50;
  for (let i = 0; i < bpBatch.length; i += BATCH_SIZE) {
    const slice = bpBatch.slice(i, i + BATCH_SIZE);
    const upsertRes = await fetch(
      `${supaUrl}/rest/v1/cache_team_advanced_stats_by_position?on_conflict=team_abbr,position,snapshot_date,sport`,
      {
        method: "POST",
        headers: {
          apikey: supaKey, Authorization: `Bearer ${supaKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(slice),
      },
    );
    if (upsertRes.ok) byPositionRows += slice.length;
    else {
      const txt = await upsertRes.text();
      byPositionRowsErrors.push(`batch i=${i}: ${upsertRes.status} ${txt.slice(0, 160)}`);
    }
  }

  const durationMs = Date.now() - startMs;
  const errorCount = teamsFailed + byPositionRowsErrors.length;
  const status = errorCount === 0 ? "success" : (teamsProcessed > 0 || byPositionRows > 0 ? "partial" : "failed");
  const notes = `teams=${teamsProcessed} bypos=${byPositionRows} fail=${teamsFailed} bpos_err=${byPositionRowsErrors.length} rows=${rows.length} bdl_calls=${calls + 1}`;
  await logRunRow(supaUrl, supaKey, snapshotDate, teamsProcessed, byPositionRows, calls + 1, errorCount, durationMs, status, notes);

  if (errorCount > 5) {
    await notify({
      severity: "warning",
      title: "fetch-team-advanced-stats elevated failures",
      message: `teamsFailed=${teamsFailed} bposErrors=${byPositionRowsErrors.length}`,
      metadata: { teams_processed: teamsProcessed, by_position_rows: byPositionRows },
    });
  }

  return jsonResponse({
    success: status !== "failed",
    snapshot_date: snapshotDate,
    lookback_days: lookbackDays,
    dates_queried: dateList,
    bdl_advanced_rows: rows.length,
    bdl_calls: calls + 1,
    teams_source: teamsSource,
    teams_processed: teamsProcessed,
    teams_failed: teamsFailed,
    by_position_rows: byPositionRows,
    by_position_errors: byPositionRowsErrors.slice(0, 5),
    team_errors: teamErrors.slice(0, 5),
    duration_ms: durationMs,
    status,
  });
});
