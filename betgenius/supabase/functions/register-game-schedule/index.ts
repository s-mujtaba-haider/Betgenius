declare const Deno: any;
// D-331 Phase C — register-game-schedule.
//
// Reads today + tomorrow's MLB schedule from MLB Stats API, computes 3 touch
// run_at timestamps per game (T-12h, T-3h, T-30min before first pitch), and
// INSERTs to scheduled_jobs with ON CONFLICT DO UPDATE.
//
// Cadence: HOURLY via cron '15 * * * *' (per D-328 FLAG 1). Each invocation
// is idempotent — late-added games / postponements get caught at next hour
// boundary. ON CONFLICT guard ensures completed/running/failed/skipped jobs
// are NOT mutated; only pending jobs get run_at updates (D-328 FLAG 3).
//
// Special cases:
//   - Skipped games (status final/cancelled): not registered. resolve-picks
//     handles post-final settlement.
//   - Late-added (game_time < T-X from now): run_at = now() + 1 min so the
//     job fires on the next dispatcher tick (~1 min).
//
// AUTH: service-role or BACKFILL_AUTH_TOKEN (vault-based via cron).
// Failure handling: MLB API fetch failure → log + return 200 with summary
// showing 0 games processed. Subsequent hourly cron firings will catch up.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

const TOUCH_OFFSETS_HOURS: Record<string, number> = {
  "T-12h": 12,
  "T-3h": 3,
  "T-30min": 0.5,
};

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

interface ScheduleGame {
  gamePk: number;
  gameDate: string;          // ISO datetime UTC
  status: { abstractGameState: string; detailedState?: string };
  teams: {
    home: { team: { name: string } };
    away: { team: { name: string } };
  };
}

async function fetchScheduleForDate(isoDate: string): Promise<ScheduleGame[]> {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&date=${isoDate}&hydrate=probablePitcher,venue`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) {
      console.error(`[register-game-schedule] MLB schedule fetch failed status=${r.status}`);
      return [];
    }
    const data = await r.json() as { dates?: Array<{ games: ScheduleGame[] }> };
    return data.dates?.[0]?.games ?? [];
  } catch (e) {
    console.error(`[register-game-schedule] MLB schedule fetch threw: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function normalizeStatus(g: ScheduleGame): string {
  const detailed = (g.status?.detailedState ?? "").toLowerCase();
  const abstract = (g.status?.abstractGameState ?? "Preview").toLowerCase();
  if (detailed === "postponed") return "postponed";
  if (detailed === "suspended") return "suspended";
  if (detailed === "cancelled" || detailed === "canceled") return "cancelled";
  return abstract; // 'preview' | 'live' | 'final' typically
}

function computeRunAt(gameTimeUtc: Date, offsetHours: number, nowMs: number): Date {
  const target = new Date(gameTimeUtc.getTime() - offsetHours * 3600 * 1000);
  // Late-added catch-up: if computed run_at is in the past, fire 60s from now
  // so the next dispatcher tick catches it.
  if (target.getTime() < nowMs) return new Date(nowMs + 60 * 1000);
  return target;
}

interface UpsertRow {
  function_name: string;
  payload: { game_id: string; touch_label: string };
  run_at: string;
  retryable?: boolean;
  retry_deadline?: string;
}

// Bulk upsert using PostgREST's on_conflict + Prefer:resolution=merge-duplicates.
// natural_key is a generated column on the table — merge-duplicates resolves
// to UPDATE when a row with same natural_key exists. To honor "WHERE status =
// 'pending'", we follow with a single UPDATE that resets run_at on conflicts
// where the row was already non-pending — easiest path: a stored procedure.
//
// Simpler approach: do row-at-a-time INSERT and check the response. For ~45
// rows/day this is fine. Use PostgREST Prefer:return=representation + handle
// the 409/uniqueness response per row.
//
// Cleanest: stored procedure `register_scheduled_job` that does the proper
// ON CONFLICT DO UPDATE...WHERE in a single SQL statement. Defined via
// migration 20260526000006_d331_register_job_rpc.sql.
async function callRegisterJob(row: UpsertRow): Promise<"inserted" | "updated" | "unchanged" | "error"> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/register_scheduled_job`, {
    method: "POST",
    headers: sH(),
    body: JSON.stringify({
      p_function_name: row.function_name,
      p_payload: row.payload,
      p_run_at: row.run_at,
      p_retryable: row.retryable ?? false,
      p_retry_deadline: row.retry_deadline ?? null,
    }),
  });
  if (!r.ok) {
    console.error(`[register-game-schedule] register_scheduled_job failed status=${r.status} for ${row.payload.game_id}/${row.payload.touch_label}`);
    return "error";
  }
  const result = await r.json() as string;
  if (result === "inserted" || result === "updated" || result === "unchanged") return result;
  return "error";
}

interface RegisterResponseShape {
  success: boolean;
  duration_ms: number;
  dates_fetched: string[];
  games_seen: number;
  games_eligible: number;
  jobs_inserted: number;
  jobs_updated: number;
  jobs_unchanged: number;
  jobs_errors: number;
  skipped_games: Array<{ game_id: number; status: string; reason: string }>;
  dry_run: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const t0 = Date.now();

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== SUPABASE_KEY && bearer !== BACKFILL_TOKEN)) {
    return j({ error: "unauthorized" }, 401);
  }

  let body: { dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* tolerant */ }
  const dryRun = body.dry_run === true;

  // Compute today + tomorrow ISO dates in ET (slate boundary). ET is UTC-4
  // in summer (May-Oct). Conservative: use UTC-4 always for now; daylight
  // savings boundary is a known small edge case not in D-331 scope.
  const nowMs = Date.now();
  const etOffsetMs = 4 * 3600 * 1000;
  const todayEt = new Date(nowMs - etOffsetMs).toISOString().slice(0, 10);
  const tomorrowEt = new Date(nowMs - etOffsetMs + 24 * 3600 * 1000).toISOString().slice(0, 10);

  const dates = [todayEt, tomorrowEt];
  let gamesSeen = 0;
  let gamesEligible = 0;
  const skipped: Array<{ game_id: number; status: string; reason: string }> = [];
  const upserts: UpsertRow[] = [];

  for (const isoDate of dates) {
    const games = await fetchScheduleForDate(isoDate);
    gamesSeen += games.length;

    for (const g of games) {
      const status = normalizeStatus(g);
      // Skip already-terminal or unscheduled-but-not-played games
      if (status === "final" || status === "cancelled" || status === "postponed") {
        skipped.push({ game_id: g.gamePk, status, reason: `terminal_or_skipped_status` });
        continue;
      }
      if (!g.gameDate) {
        skipped.push({ game_id: g.gamePk, status, reason: "missing_game_time" });
        continue;
      }
      const gameTimeUtc = new Date(g.gameDate);
      if (!Number.isFinite(gameTimeUtc.getTime())) {
        skipped.push({ game_id: g.gamePk, status, reason: "invalid_game_time" });
        continue;
      }
      gamesEligible++;
      for (const [touchLabel, offsetHours] of Object.entries(TOUCH_OFFSETS_HOURS)) {
        const runAt = computeRunAt(gameTimeUtc, offsetHours, nowMs);
        const retryDeadline = new Date(gameTimeUtc.getTime() - 10 * 60 * 1000);
        upserts.push({
          function_name: "process-single-game-mlb",
          payload: { game_id: String(g.gamePk), touch_label: touchLabel },
          run_at: runAt.toISOString(),
          retryable: true,
          retry_deadline: retryDeadline.toISOString(),
        });
      }
    }
  }

  let jobsInserted = 0;
  let jobsUpdated = 0;
  let jobsUnchanged = 0;
  let jobsErrors = 0;

  if (!dryRun) {
    // Serial RPC calls — at ~45 rows/day this is fast enough (~50ms × 45 = 2.3s).
    for (const row of upserts) {
      const outcome = await callRegisterJob(row);
      if (outcome === "inserted") jobsInserted++;
      else if (outcome === "updated") jobsUpdated++;
      else if (outcome === "unchanged") jobsUnchanged++;
      else jobsErrors++;
    }
  }

  return j({
    success: true,
    duration_ms: Date.now() - t0,
    dates_fetched: dates,
    games_seen: gamesSeen,
    games_eligible: gamesEligible,
    jobs_inserted: jobsInserted,
    jobs_updated: jobsUpdated,
    jobs_unchanged: jobsUnchanged,
    jobs_errors: jobsErrors,
    skipped_games: skipped,
    dry_run: dryRun,
  } satisfies RegisterResponseShape);
});
