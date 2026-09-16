// D-289 PHASE 3 — historical MLB odds backfill (D-768 extended).
//
// Iterates cache_mlb_historical_events where odds_backfill_status matches
// status_filter (default 'pending'). For each event, pulls 3 snapshots
// (T-6h, T-1h, T-15min) with the configured markets in ONE API call (per
// market is 10 credits; batched call is N × 10).
//
// Markets (D-768): h2h, spreads, totals, batter_hits, batter_total_bases,
// batter_home_runs, batter_rbis, pitcher_strikeouts, pitcher_outs.
//
// Cost per event with full 9-market default: 3 × 9 × 10 = 270 credits.
// Cost per event with `markets_override="pitcher_outs"`: 3 × 1 × 10 = 30.
//
// D-768 ADDITIONS — targeted single-market re-backfill:
//   - body.markets_override (string) overrides ALL_MARKETS for this run
//   - body.status_filter (string) overrides default 'pending'
//   Together they let CEO close the warehouse pitcher_outs gap discovered in
//   D-767 (cache_mlb_historical_odds has 0 pitcher_outs rows because the
//   pre-D-768 ALL_MARKETS string never included it).
//
// Chunkable via body.max_events. Checkpoints odds_backfill_status after each
// successful event. When markets_override is set the function does NOT mark
// already-complete events back to anything else — it only INSERTs new rows.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { tryAcquireLock, releaseLock } from "../_shared/function_lock.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
const ODDS_KEY = Deno.env.get("ODDS_API_KEY_5M") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const supaHeaders = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

// D-768 — pitcher_outs added so going-forward backfills capture it (the
// one-line root-cause fix that closes the gap D-767 found).
// D-785 — batter_runs_scored added. D-783 audit found 0 historical odds for
// runs_scored (same never-captured break as pitcher_outs pre-D-768). The
// Odds API supports this market key (verified live in fetch-odds-mlb at
// line 31 — same underlying provider, same key name).
const ALL_MARKETS = "h2h,spreads,totals,batter_hits,batter_total_bases,batter_home_runs,batter_rbis,batter_runs_scored,pitcher_strikeouts,pitcher_outs";
const SNAPSHOT_OFFSETS_HOURS = [-6, -1, -0.25];  // T-6h, T-1h, T-15min before commence_time

interface OddsBookmaker {
  key?: string;
  title?: string;
  markets?: Array<{
    key?: string;
    outcomes?: Array<{ name?: string; description?: string; price?: number; point?: number }>;
  }>;
}

interface OddsResponse {
  data?: {
    id?: string;
    home_team?: string;
    away_team?: string;
    commence_time?: string;
    bookmakers?: OddsBookmaker[];
  };
}

function parseSnapshotToRows(
  eventId: string,
  snapshotTs: string,
  commenceTime: string,
  homeTeam: string,
  awayTeam: string,
  json: OddsResponse,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const bookmakers = json?.data?.bookmakers ?? [];
  for (const bm of bookmakers) {
    const bmKey = bm.key ?? "";
    const bmTitle = bm.title ?? null;
    if (!bmKey) continue;
    for (const m of bm.markets ?? []) {
      const marketKey = m.key ?? "";
      if (!marketKey) continue;
      const outcomes = m.outcomes ?? [];
      // Game-level markets (h2h, spreads, totals): outcomes typed by name
      if (marketKey === "h2h" || marketKey === "spreads") {
        for (const o of outcomes) {
          if (o.name === undefined || o.price === undefined) continue;
          // h2h: name = team name; spreads: name = team + point
          const isHome = o.name === homeTeam;
          const line = o.point ?? 0;
          // Encode: player_name='' for game-level; use 'name' as side encoded in line sign
          rows.push({
            event_id: eventId, snapshot_timestamp: snapshotTs, commence_time: commenceTime,
            home_team: homeTeam, away_team: awayTeam,
            bookmaker_key: bmKey, bookmaker_title: bmTitle,
            market_key: `${marketKey}__${isHome ? "home" : "away"}`,
            player_name: "", line,
            over_odds: o.price, under_odds: null,
          });
        }
      } else if (marketKey === "totals") {
        // outcomes: 2 rows (Over + Under) sharing same point
        let overPrice: number | null = null;
        let underPrice: number | null = null;
        let line = 0;
        for (const o of outcomes) {
          if (o.point !== undefined) line = o.point;
          if (o.name === "Over") overPrice = o.price ?? null;
          else if (o.name === "Under") underPrice = o.price ?? null;
        }
        rows.push({
          event_id: eventId, snapshot_timestamp: snapshotTs, commence_time: commenceTime,
          home_team: homeTeam, away_team: awayTeam,
          bookmaker_key: bmKey, bookmaker_title: bmTitle,
          market_key: "totals", player_name: "", line,
          over_odds: overPrice, under_odds: underPrice,
        });
      } else {
        // Player-prop markets: each outcome has description=playerName + name=Over/Under + point=line
        // Group by (description, point) → one row with both prices.
        const byPlayer = new Map<string, { line: number; over: number | null; under: number | null }>();
        for (const o of outcomes) {
          const player = o.description ?? "";
          if (!player) continue;
          const ln = o.point ?? 0;
          const key = `${player}|${ln}`;
          let v = byPlayer.get(key);
          if (!v) { v = { line: ln, over: null, under: null }; byPlayer.set(key, v); }
          if (o.name === "Over") v.over = o.price ?? null;
          else if (o.name === "Under") v.under = o.price ?? null;
        }
        for (const [key, v] of byPlayer.entries()) {
          const player = key.split("|")[0];
          rows.push({
            event_id: eventId, snapshot_timestamp: snapshotTs, commence_time: commenceTime,
            home_team: homeTeam, away_team: awayTeam,
            bookmaker_key: bmKey, bookmaker_title: bmTitle,
            market_key: marketKey, player_name: player, line: v.line,
            over_odds: v.over, under_odds: v.under,
          });
        }
      }
    }
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY || !ODDS_KEY) return j({ error: "missing env" }, 500);
  const auth = req.headers.get("authorization") || "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  // D-291 SHIP 1 — mutex pattern. Prevent the dup-loop bug from D-289
  // (~500K credits wasted). 15-min TTL guards against orphaned locks.
  const LOCK_KEY = "fetch-historical-odds-mlb";
  const lock = await tryAcquireLock(LOCK_KEY, 900, `${Date.now()}`);
  if (!lock.acquired) {
    // Log the blocked attempt for visibility
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ function_name: "fetch-historical-odds-mlb", phase: "lock_acquire", error_type: "concurrent_instance_blocked", error_message: lock.reason, context: { existing_lock_acquired_at: lock.acquired_at, existing_lock_expires_at: lock.expires_at } }),
      });
    } catch { /* swallow */ }
    return j({ blocked: true, reason: "concurrent_instance_already_running", lock_state: lock });
  }

  let body: { max_events?: number; credits_floor?: number; window_start?: string; window_end?: string; snapshot_offsets?: number[]; markets_override?: string; status_filter?: string } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const maxEvents = Math.min(body.max_events ?? 50, 150);
  const creditsFloor = body.credits_floor ?? 500_000;  // escalation rule 7 safety
  const windowStart = body.window_start ?? "2023-05-03";
  const windowEnd = body.window_end ?? "2025-10-31";
  // D-358 SHIP 2 — allow caller to pull fewer snapshots per event to fit the
  // 60K credit cap for the 2026 validation-gate proof. Default preserves the
  // D-289 production behavior of 3 snapshots × 80 credits = 240 per event.
  const snapshotOffsets: number[] = Array.isArray(body.snapshot_offsets) && body.snapshot_offsets.length > 0
    ? body.snapshot_offsets
    : SNAPSHOT_OFFSETS_HOURS;
  // D-768 — targeted single-market re-backfill. When `markets_override` is
  // set, ALL_MARKETS is replaced for this run only. `status_filter` lets the
  // run target events whose initial backfill already 'complete'd (the natural
  // population for closing the pitcher_outs gap).
  const marketsForRun = (typeof body.markets_override === "string" && body.markets_override.length > 0)
    ? body.markets_override
    : ALL_MARKETS;
  const statusFilter = (typeof body.status_filter === "string" && body.status_filter.length > 0)
    ? body.status_filter
    : "pending";
  // When markets_override is set we are doing an additive backfill on already-
  // complete events — do NOT regress their status to 'partial' or anything else;
  // just INSERT the new market rows (PostgREST conflict resolution handles dups).
  const additiveOnly = typeof body.markets_override === "string" && body.markets_override.length > 0;

  const start = Date.now();
  try {
  // Pull events ordered by commence_time
  const eventsUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?odds_backfill_status=eq.${statusFilter}&commence_time=gte.${windowStart}T00:00:00Z&commence_time=lte.${windowEnd}T23:59:59Z&order=commence_time.asc&limit=${maxEvents}&select=event_id,commence_time,home_team,away_team`;
  const er = await fetch(eventsUrl, { headers: supaHeaders() });
  if (!er.ok) { await releaseLock(LOCK_KEY); return j({ error: `events fetch ${er.status}` }, 500); }
  const events = await er.json() as Array<{ event_id: string; commence_time: string; home_team: string; away_team: string }>;

  let creditsRemaining: number | null = null;
  let snapshotsUpserted = 0;
  let rowsUpserted = 0;
  let eventsCompleted = 0;
  const errors: string[] = [];
  let stoppedReason: string | null = null;

  for (const ev of events) {
    if (Date.now() - start > 130_000) { stoppedReason = "function_time_budget"; break; }
    if (creditsRemaining !== null && creditsRemaining < creditsFloor) { stoppedReason = "credits_floor_hit"; break; }

    const commenceMs = new Date(ev.commence_time).getTime();
    const allRows: Array<Record<string, unknown>> = [];
    let snapsThisEvent = 0;
    let eventFailed = false;

    for (const offsetH of snapshotOffsets) {
      const snapshotMs = commenceMs + offsetH * 3600_000;
      const snapshotIso = new Date(snapshotMs).toISOString().slice(0, 19) + "Z";
      try {
        const oddsUrl = `https://api.the-odds-api.com/v4/historical/sports/baseball_mlb/events/${ev.event_id}/odds?date=${snapshotIso}&regions=us&markets=${marketsForRun}&oddsFormat=american&apiKey=${ODDS_KEY}`;
        const r = await fetch(oddsUrl);
        const remHdr = r.headers.get("x-requests-remaining");
        if (remHdr) creditsRemaining = parseInt(remHdr, 10);
        if (!r.ok) {
          if (r.status === 429) {
            await new Promise((res) => setTimeout(res, 3000));
          }
          errors.push(`${ev.event_id} @ ${snapshotIso}: HTTP ${r.status}`);
          eventFailed = true;
          continue;
        }
        const txt = await r.text();
        const parsed = JSON.parse(txt) as OddsResponse;
        // Use the response timestamp (Odds API returns nearest available snapshot)
        const actualTs = ((parsed as unknown as { timestamp?: string }).timestamp) ?? snapshotIso;
        const rows = parseSnapshotToRows(ev.event_id, actualTs, ev.commence_time, ev.home_team, ev.away_team, parsed);
        allRows.push(...rows);
        snapsThisEvent++;
      } catch (e) {
        errors.push(`${ev.event_id}: ${e instanceof Error ? e.message : String(e)}`);
        eventFailed = true;
      }
      // Light throttle
      await new Promise((r) => setTimeout(r, 50));
    }

    // Bulk upsert rows in chunks of 500
    for (let i = 0; i < allRows.length; i += 500) {
      const chunk = allRows.slice(i, i + 500);
      try {
        const up = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_odds?on_conflict=event_id,snapshot_timestamp,bookmaker_key,market_key,player_name,line`, {
          method: "POST",
          headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(chunk),
        });
        if (up.ok) rowsUpserted += chunk.length;
        else errors.push(`${ev.event_id} upsert: ${up.status}`);
      } catch (e) {
        errors.push(`${ev.event_id} upsert exc: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    snapshotsUpserted += snapsThisEvent;

    // Checkpoint event status (complete OR partial). "Complete" means all
    // configured snapshots succeeded — not necessarily the D-289 default 3.
    // D-768 — when running an additive single-market re-backfill, we do NOT
    // touch the existing status (the event was already 'complete' from its
    // original full-market run; we're just inserting new market rows).
    if (!additiveOnly) {
      const newStatus = (snapsThisEvent === snapshotOffsets.length && !eventFailed) ? "complete" : "partial";
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?event_id=eq.${ev.event_id}`, {
          method: "PATCH",
          headers: { ...supaHeaders(), Prefer: "return=minimal" },
          body: JSON.stringify({ odds_backfill_status: newStatus, odds_backfill_at: new Date().toISOString() }),
        });
      } catch { /* ignore checkpoint failures */ }
    }
    eventsCompleted++;
  }

  return j({
    success: true,
    events_requested: events.length,
    events_completed: eventsCompleted,
    snapshots_upserted: snapshotsUpserted,
    rows_upserted: rowsUpserted,
    credits_remaining: creditsRemaining,
    stopped_reason: stoppedReason,
    errors_sample: errors.slice(0, 10),
    duration_ms: Date.now() - start,
    lock_acquired: true,
  });
  } finally {
    // D-291 SHIP 1 — always release the mutex
    await releaseLock(LOCK_KEY);
  }
});
