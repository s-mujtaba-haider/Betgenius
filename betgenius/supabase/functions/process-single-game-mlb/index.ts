// D-329 Phase A — process-single-game-mlb.
//
// Standalone edge function that scores ALL 7 MLB markets for ONE game_id.
// Entry guards (per D-328 flag answers):
//   1. Auth: Bearer SUPABASE_SERVICE_ROLE_KEY or BACKFILL_AUTH_TOKEN
//   2. Game-status guard: skip if cache_mlb_game_scoreboard.status in
//      {live, final, cancelled, postponed, suspended} — let resolve-picks
//      handle in-progress / finished games
//   3. props_cache freshness guard: skip + return re-queue signal if
//      MAX(last_seen) for event_id is >45 min stale
//
// Scoring delegation (Phase A approach):
//   After guards pass, this function POSTs to process-games-mlb with
//   `game_ids_filter: [gamePk]` in the body. process-games-mlb (modified
//   in D-329 SHIP 1a) filters its slate to that single game and runs all
//   7 markets. Per-game scoring completes in ~10-20s vs ~150s for slate.
//
//   Why delegate instead of duplicate the scorers: the 7 market scorers
//   (~600 LOC) + buildCaches (~300 LOC) + helper types (~200 LOC) total
//   >800 LOC of inline code in process-games-mlb. Pure duplication
//   violates D-329 spec; clean extraction to _shared/ is a separate
//   refactor (proposed as Phase A.5 if needed). Delegation via the
//   game_ids_filter hook preserves the source-of-truth scorers while
//   isolating the per-game invocation path. process-games-mlb's
//   production cron behavior is preserved (filter is null when
//   jobid=21 invokes with empty body).
//
// AUTH: service-role or BACKFILL_AUTH_TOKEN.
// Mutex: NONE (per D-326 finally{}-doesn't-run-on-SIGKILL learning;
//        per-game functions are ~20s so 150s SIGKILL is extremely
//        unlikely, and dispatcher pattern in Phase B naturally prevents
//        concurrent invocations for the same game).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const ODDS_STALENESS_MINUTES = 45;

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

interface ResponseShape {
  success: boolean;
  game_id: string | number;
  touch_label: string | null;
  skipped: boolean;
  skip_reason: string | null;
  markets_scored: number;
  picks_written: number;
  duration_ms: number;
  error?: string;
}

interface ScoreboardRow {
  game_id: number;
  game_date: string;
  home_team: string;
  away_team: string;
  status: string;
  umpire_name: string | null;
}

async function fetchScoreboardRow(gamePk: number): Promise<ScoreboardRow | null> {
  const url = `${SUPABASE_URL}/rest/v1/cache_mlb_game_scoreboard?game_id=eq.${gamePk}&select=game_id,game_date,home_team,away_team,status,umpire_name&limit=1`;
  const r = await fetch(url, { headers: sH() });
  if (!r.ok) return null;
  const rows = await r.json() as ScoreboardRow[];
  return rows[0] ?? null;
}

// Returns minutes since last_seen for this game's props, or null if no rows exist.
// IMPORTANT: props_cache.event_id is the Odds API event hash (e.g., MD5 string),
// NOT the MLB Stats API gamePk. We can't look up by MLB gamePk directly. The
// reliable cross-source key is (home_team, away_team, game_date_YYYYMMDD) — both
// cache_mlb_game_scoreboard and props_cache use MLB-canonical team names.
async function fetchOddsAgeMinutes(homeTeam: string, awayTeam: string, gameDateISO: string): Promise<{ ageMinutes: number | null; rowCount: number }> {
  const gameDateYmd = gameDateISO.replace(/-/g, "");
  const qs = new URLSearchParams({
    sport: "eq.mlb",
    home_team: `eq.${homeTeam}`,
    away_team: `eq.${awayTeam}`,
    game_date: `eq.${gameDateYmd}`,
    select: "last_seen",
    order: "last_seen.desc.nullslast",
    limit: "1",
  });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/props_cache?${qs.toString()}`, { headers: sH() });
  if (!r.ok) return { ageMinutes: null, rowCount: 0 };
  const rows = await r.json() as Array<{ last_seen: string | null }>;
  if (!rows.length) return { ageMinutes: null, rowCount: 0 };
  const last = rows[0].last_seen;
  if (!last) return { ageMinutes: null, rowCount: rows.length };
  const ageMs = Date.now() - new Date(last).getTime();
  return { ageMinutes: Math.round(ageMs / 60000), rowCount: rows.length };
}

interface ProcessGamesMlbResponse {
  success?: boolean;
  skipped?: boolean;
  reason?: string;
  total_picks_written?: number;
  recommendations_written?: number;
  hist_written_cum?: number;
  duration_ms?: number;
  d288_deploy_marker?: string;
  // Permissive — we forward whatever the upstream returns.
  [k: string]: unknown;
}

async function delegateScoringToProcessGamesMlb(gamePk: number, gameDate: string, dryRun: boolean): Promise<ProcessGamesMlbResponse> {
  const url = `${SUPABASE_URL}/functions/v1/process-games-mlb`;
  const body = {
    game_date: gameDate.replace(/-/g, ""), // YYYYMMDD per process-games-mlb expectation
    game_ids_filter: [gamePk],
    dry_run: dryRun,
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { ...sH(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    return { success: false, error_status: r.status, error_text: errText.slice(0, 300) };
  }
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const t0 = Date.now();

  // Guard 1 — auth
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== SUPABASE_KEY && bearer !== BACKFILL_TOKEN)) {
    return j({ success: false, game_id: "?", touch_label: null, skipped: false, skip_reason: null, markets_scored: 0, picks_written: 0, duration_ms: Date.now() - t0, error: "unauthorized" } satisfies ResponseShape, 401);
  }

  // Parse body
  let body: { game_id?: number | string; touch_label?: string; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* tolerant */ }
  const gamePk = typeof body.game_id === "number" ? body.game_id : Number(body.game_id);
  const touchLabel = body.touch_label ?? null;
  const dryRun = body.dry_run === true;

  if (!Number.isFinite(gamePk) || gamePk <= 0) {
    return j({ success: false, game_id: body.game_id ?? "?", touch_label: touchLabel, skipped: false, skip_reason: null, markets_scored: 0, picks_written: 0, duration_ms: Date.now() - t0, error: "missing_or_invalid_game_id" } satisfies ResponseShape, 400);
  }

  // Guard 2 — game-status guard
  const sb = await fetchScoreboardRow(gamePk);
  if (!sb) {
    return j({ success: true, game_id: gamePk, touch_label: touchLabel, skipped: true, skip_reason: "scoreboard_row_not_found", markets_scored: 0, picks_written: 0, duration_ms: Date.now() - t0 } satisfies ResponseShape);
  }
  const statusLower = (sb.status ?? "").toLowerCase();
  const TERMINAL_OR_LIVE_STATUSES = new Set(["live", "final", "cancelled", "canceled", "postponed", "suspended"]);
  if (TERMINAL_OR_LIVE_STATUSES.has(statusLower)) {
    return j({
      success: true,
      game_id: gamePk,
      touch_label: touchLabel,
      skipped: true,
      skip_reason: `game_status_${statusLower}`,
      markets_scored: 0,
      picks_written: 0,
      duration_ms: Date.now() - t0,
    } satisfies ResponseShape);
  }

  // Guard 3 — props_cache freshness guard
  const odds = await fetchOddsAgeMinutes(sb.home_team, sb.away_team, sb.game_date);
  if (odds.rowCount === 0) {
    return j({
      success: true,
      game_id: gamePk,
      touch_label: touchLabel,
      skipped: true,
      skip_reason: "odds_no_rows_for_game",
      markets_scored: 0,
      picks_written: 0,
      duration_ms: Date.now() - t0,
    } satisfies ResponseShape);
  }
  if (odds.ageMinutes !== null && odds.ageMinutes > ODDS_STALENESS_MINUTES) {
    return j({
      success: true,
      game_id: gamePk,
      touch_label: touchLabel,
      skipped: true,
      skip_reason: `odds_stale_${odds.ageMinutes}min`,
      markets_scored: 0,
      picks_written: 0,
      duration_ms: Date.now() - t0,
    } satisfies ResponseShape);
  }

  // All guards passed — delegate scoring to process-games-mlb with filter.
  const upstream = await delegateScoringToProcessGamesMlb(gamePk, sb.game_date, dryRun);
  if (upstream.success === false) {
    return j({
      success: false,
      game_id: gamePk,
      touch_label: touchLabel,
      skipped: false,
      skip_reason: null,
      markets_scored: 0,
      picks_written: 0,
      duration_ms: Date.now() - t0,
      error: `delegate_failed: ${String((upstream as { error_text?: string }).error_text ?? "unknown")}`.slice(0, 300),
    } satisfies ResponseShape, 502);
  }

  // Best-effort extraction of metrics from upstream payload. process-games-mlb's
  // response shape doesn't include per-game pick counts directly — we infer
  // "markets_scored" as 7 if non-skipped (all markets attempted) else 0, and
  // picks_written from any reasonable field exposed.
  const upstreamSkipped = upstream.skipped === true;
  const picksWritten = typeof upstream.recommendations_written === "number"
    ? upstream.recommendations_written
    : typeof upstream.hist_written_cum === "number"
      ? upstream.hist_written_cum
      : 0;

  return j({
    success: true,
    game_id: gamePk,
    touch_label: touchLabel,
    skipped: upstreamSkipped,
    skip_reason: upstreamSkipped ? String(upstream.reason ?? "upstream_skipped") : null,
    markets_scored: upstreamSkipped ? 0 : 7,
    picks_written: picksWritten,
    duration_ms: Date.now() - t0,
  } satisfies ResponseShape);
});
