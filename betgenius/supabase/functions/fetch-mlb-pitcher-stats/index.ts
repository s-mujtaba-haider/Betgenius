// fetch-mlb-pitcher-stats — D-204 Batch 3 Task 3.0.
//
// Daily snapshot writer for cache_pitcher_game_logs. For each pitcher
// scheduled to start in the next 24h, pull their gameLog from MLB
// Stats API and UPSERT recent starts. Cron: jobid 18, daily 12:00 UTC.
//
// SOURCES:
//   - MLB Stats API /v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher
//   - MLB Stats API /v1/people/{id}/stats?stats=gameLog&group=pitching&season=YYYY
//
// AUTH: service-role gated via BACKFILL_AUTH_TOKEN || SUPABASE_SERVICE_ROLE_KEY.
//
// REQUEST BODY (optional):
//   { snapshot_date?: "YYYY-MM-DD" }  // defaults to today ET
//   { pitcher_ids?: number[] }        // optional explicit list (test mode)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
const PER_CALL_TIMEOUT_MS = 20_000;
const INTER_CALL_GAP_MS = 600; // MLB Stats API is free + lenient — 600ms is safe
let lastCallMs = 0;

async function mlbFetch<T>(path: string): Promise<{ data: T | null; status: number; err?: string }> {
  const now = Date.now();
  const since = now - lastCallMs;
  if (since < INTER_CALL_GAP_MS) await new Promise((r) => setTimeout(r, INTER_CALL_GAP_MS - since));
  lastCallMs = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${MLB_API}${path}`, { signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) return { data: null, status: res.status, err: text.slice(0, 200) };
    try { return { data: JSON.parse(text) as T, status: res.status }; }
    catch { return { data: null, status: res.status, err: "json parse failed" }; }
  } catch (e) {
    return { data: null, status: 0, err: e instanceof Error ? e.message : String(e) };
  } finally { clearTimeout(timer); }
}

function inningsToDecimal(ip: number | string | null | undefined): number {
  if (ip == null) return 0;
  const s = String(ip);
  const i = s.indexOf(".");
  if (i < 0) return Number(s) || 0;
  return (Number(s.slice(0, i)) || 0) + (Number(s.slice(i + 1)) || 0) / 3;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

  // D-214 Fix 2 — error_log instrumentation.
  async function elog(phase: string, errorType: string, message: string, context: Record<string, unknown> = {}) {
    try {
      if (!SUPA_URL || !SUPA_KEY) return;
      await fetch(`${SUPA_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ function_name: "fetch-mlb-pitcher-stats", phase, error_type: errorType, error_message: message, context }),
      });
    } catch { /* swallow */ }
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL_TOKEN && bearer !== SUPA_KEY)) {
    await elog("auth", "unauthorized", "missing or wrong Bearer token", { bearer_prefix: bearer.slice(0, 8) });
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (!SUPA_URL || !SUPA_KEY) return jsonResponse({ error: "missing supabase env" }, 500);

  let body: { snapshot_date?: string; pitcher_ids?: number[]; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  // D-262 dry-run gate: short-circuit BEFORE the MLB Stats API loop so we
  // don't burn external API calls. Writes to cache_pitcher_game_logs +
  // error_log are also suppressed.
  const dryRun = body.dry_run === true;

  const today = new Date();
  const easternMs = today.getTime() - 4 * 60 * 60 * 1000;
  const easternDate = new Date(easternMs).toISOString().slice(0, 10);
  const snapshotDate = body.snapshot_date || easternDate;

  const t0 = Date.now();

  if (dryRun) {
    return jsonResponse({
      dry_run: true,
      snapshot_date: snapshotDate,
      would_write: {
        cache_pitcher_game_logs: null,  // unknown without hitting MLB Stats API
        error_log: 0,
      },
      note: "fetch-mlb-pitcher-stats skipped MLB Stats API + writes entirely",
      elapsed_ms: Date.now() - t0,
    });
  }

  let pitcherIds: number[] = body.pitcher_ids ?? [];

  // If no explicit list: pull probable pitchers for today from schedule.
  if (pitcherIds.length === 0) {
    const sched = await mlbFetch<{ dates: Array<{ games: Array<{ teams: { home: { probablePitcher?: { id: number } }; away: { probablePitcher?: { id: number } } } }> }> }>(
      `/schedule?sportId=1&date=${snapshotDate}&hydrate=probablePitcher`,
    );
    if (sched.data) {
      const set = new Set<number>();
      for (const d of sched.data.dates ?? []) {
        for (const g of d.games ?? []) {
          if (g.teams?.home?.probablePitcher?.id) set.add(g.teams.home.probablePitcher.id);
          if (g.teams?.away?.probablePitcher?.id) set.add(g.teams.away.probablePitcher.id);
        }
      }
      pitcherIds = [...set];
    }
  }

  const season = new Date(snapshotDate + "T12:00:00Z").getFullYear();
  const rowsToUpsert: Array<Record<string, unknown>> = [];
  let pitchersProcessed = 0;
  const pitchersFailed: number[] = [];

  for (const pid of pitcherIds) {
    const log = await mlbFetch<{ stats: Array<{ splits: Array<{ date: string; opponent?: { name?: string }; stat: Record<string, unknown> }> }> }>(
      `/people/${pid}/stats?stats=gameLog&group=pitching&season=${season}`,
    );
    if (!log.data || !log.data.stats?.[0]?.splits) { pitchersFailed.push(pid); continue; }
    const splits = log.data.stats[0].splits;
    // Take last 10 starts
    const recent = splits.slice(-10);
    for (const s of recent) {
      const ip = inningsToDecimal(s.stat?.inningsPitched as number | string);
      // Only count actual starts (≥3 IP heuristic; MLB Stats API doesn't always
      // flag GS in gameLog)
      if (ip < 3) continue;
      rowsToUpsert.push({
        pitcher_id: pid,
        snapshot_date: snapshotDate,
        game_date: s.date,
        opponent_team: s.opponent?.name ?? "",
        innings_pitched: ip,
        hits: Number(s.stat?.hits ?? 0),
        earned_runs: Number(s.stat?.earnedRuns ?? 0),
        strikeouts: Number(s.stat?.strikeOuts ?? 0),
        walks: Number(s.stat?.baseOnBalls ?? 0),
        pitch_count: s.stat?.pitchesThrown !== undefined ? Number(s.stat.pitchesThrown) : null,
        stats_json: s.stat,
      });
    }
    pitchersProcessed++;
  }

  let upserts = 0;
  if (rowsToUpsert.length > 0) {
    const res = await fetch(`${SUPA_URL}/rest/v1/cache_pitcher_game_logs?on_conflict=pitcher_id,snapshot_date,game_date`, {
      method: "POST",
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rowsToUpsert),
    });
    if (res.ok) upserts = rowsToUpsert.length;
    else {
      const errBody = await res.text();
      await elog("upsert", "http_error", `cache_pitcher_game_logs POST status=${res.status}: ${errBody.slice(0, 300)}`, { snapshot_date: snapshotDate, rows_attempted: rowsToUpsert.length });
    }
  }
  if (pitcherIds.length > 0 && pitchersProcessed === 0) {
    await elog("scoring", "zero_processed", `attempted ${pitcherIds.length} pitchers, processed 0`, { snapshot_date: snapshotDate, failed: pitchersFailed });
  }

  return jsonResponse({
    snapshot_date: snapshotDate,
    pitchers_attempted: pitcherIds.length,
    pitchers_processed: pitchersProcessed,
    pitchers_failed: pitchersFailed,
    rows_upserted: upserts,
    wall_clock_ms: Date.now() - t0,
  });
});
