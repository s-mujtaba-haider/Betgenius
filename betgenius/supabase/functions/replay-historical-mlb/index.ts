// D-298 SHIP 1 — Faithful algo replay engine for MLB game-level markets.
//
// HONEST SCOPE: this batch covers `game_side` and `game_total` only.
// Batter markets (batter_hits / batter_total_bases / batter_hr /
// batter_rbis / pitcher_strikeouts) require BatterSeasonStats +
// gameLog + opposing pitcher full season stats — none of which are
// in D-293 warehouses. Queued for D-299+ (warehouse expansion).
//
// FLOW per replayed pick:
//   1. Pull row from cache_mlb_historical_odds (window-filtered)
//   2. Build GameScoringContext from D-293 warehouses + outcomes
//      via historical_context_router.buildHistoricalContext()
//   3. Call scoreGameSide() or scoreGameTotal() from scoring_mlb_v2
//      (the SAME production scoring functions, per spec)
//   4. Resolve via cache_mlb_historical_outcomes (per event_id)
//   5. Compute hit/push and write to historical_replay_results
//
// AUTH: service-role or BACKFILL_AUTH_TOKEN.
// Mutex: D-291 pattern via _shared/function_lock.ts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { tryAcquireLock, releaseLock } from "../_shared/function_lock.ts";
import { scoreGameSide, scoreGameTotal, type GameScoringContext } from "../_shared/scoring_mlb_v2.ts";
import { buildHistoricalContext } from "../_shared/historical_context_router.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
const LOCK_KEY = "replay-historical-mlb";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

interface OddsRow {
  event_id: string;
  snapshot_timestamp: string;
  commence_time: string;
  bookmaker_key: string;
  market_key: string;
  player_name: string;
  line: number;
  over_odds: number | null;
  under_odds: number | null;
  home_team?: string;
  away_team?: string;
}

interface EventInfoRow { event_id: string; home_team: string; away_team: string }

function uuid(): string {
  return crypto.randomUUID();
}

function resolveGameOutcome(
  market: "game_side" | "game_total",
  pickSide: "home" | "away" | "over" | "under",
  line: number,
  homeScore: number | null,
  awayScore: number | null,
): { hit: boolean | null; push: boolean; actual: number | null } {
  if (homeScore === null || awayScore === null) return { hit: null, push: false, actual: null };
  if (market === "game_total") {
    const total = homeScore + awayScore;
    if (Math.abs(total - line) < 1e-9) return { hit: null, push: true, actual: total };
    if (pickSide === "over") return { hit: total > line, push: false, actual: total };
    return { hit: total < line, push: false, actual: total };
  }
  // game_side: line is home spread (negative if home favored).
  const pickHome = pickSide === "home";
  const margin = pickHome ? homeScore - awayScore : awayScore - homeScore;
  const lineForPick = pickHome ? line : -line;
  const adj = margin + lineForPick;
  if (Math.abs(adj) < 1e-9) return { hit: null, push: true, actual: margin };
  return { hit: adj > 0, push: false, actual: margin };
}

interface ReplayInput {
  market_key: string;          // 'totals','spreads','h2h','game_total','game_side'
  effective_market: "game_side" | "game_total"; // normalized
}

function normalizeMarket(market_key: string): "game_side" | "game_total" | null {
  const m = market_key.toLowerCase();
  if (m === "totals" || m === "game_total") return "game_total";
  if (m === "spreads" || m === "spreads__home" || m === "spreads__away" || m === "game_side") return "game_side";
  if (m === "h2h" || m === "h2h__home" || m === "h2h__away") return "game_side";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  let body: { start_date?: string; end_date?: string; bookmaker_filter?: string[]; market_filter?: string[]; limit?: number; dry_run?: boolean; write_pick_history?: boolean; backfill_run_id?: string } = {};
  try { body = await req.json(); } catch { /* ok */ }
  const start = body.start_date ?? "2024-06-01";
  const end = body.end_date ?? "2024-06-08";
  const bookFilter = body.bookmaker_filter ?? ["hardrockbet", "betmgm", "draftkings"];
  const marketFilter = body.market_filter ?? ["spreads", "totals"];
  const limit = Math.min(Math.max(body.limit ?? 100, 1), 1000);
  const dryRun = body.dry_run ?? true;
  // D-358 SHIP 3 — opt-in synthetic pick_history minting. Off by default so
  // existing D-298 replay flows are untouched. backfill_run_id allows the
  // caller to chain multiple invocations into one logical mint run.
  const writePickHistory = body.write_pick_history ?? false;
  const backfillRunId = body.backfill_run_id ?? crypto.randomUUID();

  const acquired = await tryAcquireLock(LOCK_KEY, SUPABASE_URL, SUPABASE_KEY, 15);
  if (!acquired) return j({ error: "another instance running" }, 423);

  const runId = uuid();
  const t0 = Date.now();
  const maxMs = 100_000;

  try {
    // CLOSING SNAPSHOT — one row per (event, bookmaker, market, line) — latest snapshot per
    const sa = { url: SUPABASE_URL, key: SUPABASE_KEY };

    // D-303 SHIP 1 — multi-row spreads pairing.
    // cache_mlb_historical_odds stores spreads as 2 rows per snapshot:
    //   - spreads__home: line=-1.5, over_odds=home_odds, under_odds=null
    //   - spreads__away: line=+1.5, over_odds=away_odds, under_odds=null
    // We need to pair them by (event_id, snapshot_timestamp, bookmaker_key)
    // and synthesize a single virtual row with both sides priced.
    //
    // For totals, both sides are on the same row (over_odds + under_odds);
    // existing logic just works.
    const wantsSpreads = marketFilter.some(m => m === "spreads" || m === "spreads__home" || m === "spreads__away");
    const wantsTotals = marketFilter.some(m => m === "totals");
    const effectiveMarkets: string[] = [];
    if (wantsTotals) effectiveMarkets.push("totals");
    if (wantsSpreads) effectiveMarkets.push("spreads__home", "spreads__away");
    const effFilter = effectiveMarkets.join(",");

    // For totals: require both over_odds AND under_odds (single-row two-sided).
    // For spreads__home/__away: only over_odds is populated; under_odds null is expected.
    // Pull both sets, no over/under not-null filter, since spread rows would be excluded.
    const oddsUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_odds?commence_time=gte.${start}&commence_time=lte.${end}T23:59:59&bookmaker_key=in.(${bookFilter.join(",")})&market_key=in.(${effFilter})&over_odds=not.is.null&select=event_id,snapshot_timestamp,commence_time,bookmaker_key,market_key,player_name,line,over_odds,under_odds&order=event_id,bookmaker_key,snapshot_timestamp.desc&limit=${limit * 6}`;
    const oddsR = await fetch(oddsUrl, { headers: sH() });
    if (!oddsR.ok) return j({ error: `odds_fetch_${oddsR.status}` }, 502);
    const allOdds = await oddsR.json() as OddsRow[];

    // Build closing snapshots:
    //   - totals: one row per (event, book, line); first occurrence (sorted desc by snapshot_timestamp)
    //   - spreads: pair spreads__home + spreads__away by (event, book, snapshot_timestamp);
    //     synthesize virtual row with line=home spread, over_odds=home odds, under_odds=away odds
    const closingMap = new Map<string, OddsRow>();
    // First pass: totals — same as D-298
    for (const o of allOdds) {
      if (o.market_key !== "totals") continue;
      if (o.over_odds === null || o.under_odds === null) continue;
      const k = `${o.event_id}|${o.bookmaker_key}|totals|${o.line}`;
      if (!closingMap.has(k)) closingMap.set(k, o);
    }
    // Second pass: spreads pairing
    let unpairedSpreadsCount = 0;
    if (wantsSpreads) {
      // Index spread rows by (event, book, snapshot_timestamp) → { home?, away? }
      type SpreadPair = { home?: OddsRow; away?: OddsRow };
      const pairMap = new Map<string, SpreadPair>();
      for (const o of allOdds) {
        if (o.market_key !== "spreads__home" && o.market_key !== "spreads__away") continue;
        if (o.over_odds === null) continue;
        const k = `${o.event_id}|${o.bookmaker_key}|${o.snapshot_timestamp}`;
        const entry = pairMap.get(k) ?? {};
        if (o.market_key === "spreads__home") entry.home = o;
        else entry.away = o;
        pairMap.set(k, entry);
      }
      // For each event+book, keep latest paired snapshot (closing snapshot)
      // Group by (event, book), find latest snapshot_timestamp with both home + away present.
      const latestByEvBook = new Map<string, { home: OddsRow; away: OddsRow }>();
      for (const [k, entry] of pairMap) {
        if (!entry.home || !entry.away) { unpairedSpreadsCount++; continue; }
        const [evId, bookKey] = k.split("|");
        const groupKey = `${evId}|${bookKey}`;
        const existing = latestByEvBook.get(groupKey);
        if (!existing || entry.home.snapshot_timestamp > existing.home.snapshot_timestamp) {
          latestByEvBook.set(groupKey, { home: entry.home, away: entry.away });
        }
      }
      // Synthesize virtual rows
      for (const [groupKey, pair] of latestByEvBook) {
        const virtualKey = `${groupKey}|spreads|${pair.home.line}`;
        if (closingMap.has(virtualKey)) continue;
        // Synthesize: market_key="spreads", line=home_line, over_odds=home_odds, under_odds=away_odds
        const virtual: OddsRow = {
          event_id: pair.home.event_id,
          snapshot_timestamp: pair.home.snapshot_timestamp,
          commence_time: pair.home.commence_time,
          bookmaker_key: pair.home.bookmaker_key,
          market_key: "spreads",
          player_name: pair.home.player_name,
          line: pair.home.line,
          over_odds: pair.home.over_odds,
          under_odds: pair.away.over_odds, // away_odds becomes "under" of synthesized row
        };
        closingMap.set(virtualKey, virtual);
      }
    }
    const closing = Array.from(closingMap.values()).slice(0, limit);

    // Pull event home/away (from events table)
    const eventIds = Array.from(new Set(closing.map(o => o.event_id)));
    const eventsRows = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?event_id=in.(${eventIds.join(",")})&select=event_id,home_team,away_team&limit=2000`, { headers: sH() }).then(r => r.json()) as EventInfoRow[];
    const eventMap = new Map(eventsRows.map(e => [e.event_id, e]));

    // Pull outcomes for resolution
    const outcomesRows = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?event_id=in.(${eventIds.join(",")})&select=event_id,home_score,away_score,game_completed&limit=2000`, { headers: sH() }).then(r => r.json()) as Array<{ event_id: string; home_score: number | null; away_score: number | null; game_completed: boolean }>;
    const outcomeMap = new Map(outcomesRows.map(o => [o.event_id, o]));

    // Shared caches for context router to amortize cost across picks for same team/date
    const outcomesCache: Record<string, unknown[]> = {};
    const bullpenCache: Record<string, unknown> = {};

    const replayRows: Record<string, unknown>[] = [];
    // D-358 SHIP 3 — parallel synthetic pick_history rows. Built only when
    // writePickHistory=true; otherwise empty array, behavior identical to D-298.
    const synthPickRows: Record<string, unknown>[] = [];
    let scored = 0, failed = 0, no_outcome = 0, no_event = 0;
    const completenessSum = { total: 0, n: 0 };

    for (const o of closing) {
      if (Date.now() - t0 > maxMs) break;
      const norm = normalizeMarket(o.market_key);
      if (!norm) { failed++; continue; }
      const ev = eventMap.get(o.event_id);
      if (!ev) { no_event++; continue; }

      // Build context (parallelism across picks would help but keeps simpler)
      // Choose pickSide as the chalkier (higher implied) side — consistent with D-292 fix
      const overImp = o.over_odds! > 0 ? 100 / (o.over_odds! + 100) : -o.over_odds! / (-o.over_odds! + 100);
      const underImp = o.under_odds! > 0 ? 100 / (o.under_odds! + 100) : -o.under_odds! / (-o.under_odds! + 100);
      const pickSide: "over" | "under" | "home" | "away" = norm === "game_total"
        ? (overImp > underImp ? "over" : "under")
        : (overImp > underImp ? "home" : "away");
      const pickOdds = (pickSide === "over" || pickSide === "home") ? o.over_odds! : o.under_odds!;

      let bundle;
      try {
        // deno-lint-ignore no-explicit-any
        bundle = await buildHistoricalContext(sa, o.event_id, o.commence_time, ev.home_team, ev.away_team, null, outcomesCache as any, bullpenCache as any);
      } catch (_e) {
        failed++; continue;
      }
      completenessSum.total += bundle.completeness;
      completenessSum.n++;

      const ctx: GameScoringContext = {
        ...bundle.ctx,
        prop: { propType: o.market_key, line: o.line, odds: pickOdds, pickSide, bookmaker: o.bookmaker_key },
      };

      let result;
      try {
        result = norm === "game_side" ? scoreGameSide(ctx) : scoreGameTotal(ctx);
      } catch (_e) {
        failed++; continue;
      }

      // Resolve outcome
      const oc = outcomeMap.get(o.event_id);
      let hit: boolean | null = null;
      let push = false;
      let actual: number | null = null;
      if (oc && oc.game_completed) {
        const r = resolveGameOutcome(norm, pickSide, o.line, oc.home_score, oc.away_score);
        hit = r.hit; push = r.push; actual = r.actual;
      } else {
        no_outcome++;
      }

      replayRows.push({
        replay_run_id: runId,
        event_id: o.event_id,
        snapshot_timestamp: o.snapshot_timestamp,
        commence_time: o.commence_time,
        market_key: o.market_key,
        player_name: o.player_name || `${ev.home_team} vs ${ev.away_team}`,
        line: o.line,
        odds: pickOdds,
        book_key: o.bookmaker_key,
        algo_confidence: result.confidence,
        algo_pick_side: pickSide,
        algo_verdict: result.verdict,
        algo_breakdown: result.breakdown,
        context_completeness: bundle.completeness,
        context_missing: bundle.missing.slice(0, 20),
        hit,
        push,
        voided: false,
        actual_value: actual,
      });

      // D-358 SHIP 3 — emit synthetic pick_history row.
      // Critical isolation flags so SharpAI production dashboards never see
      // these (Performance.tsx filters is_synthetic=eq.false). source field
      // identifies D-358 specifically so D-359/D-360 mints stay separable.
      if (writePickHistory) {
        synthPickRows.push({
          player_name: o.player_name || `${ev.home_team} vs ${ev.away_team}`,
          team: pickSide === "home" ? ev.home_team : (pickSide === "away" ? ev.away_team : null),
          opponent: pickSide === "home" ? ev.away_team : (pickSide === "away" ? ev.home_team : null),
          game_time: o.commence_time,
          is_home: pickSide === "home" ? true : (pickSide === "away" ? false : null),
          prop_type: norm,
          line: o.line,
          pick_side: pickSide,
          odds: pickOdds,
          confidence: Math.round(result.confidence),
          verdict: result.verdict,
          hit,
          actual_value: actual,
          resolved_at: (hit !== null || push) ? new Date().toISOString() : null,
          source: "d358_synthetic_backfill",
          sport: "mlb",
          is_synthetic: true,
          backfill_run_id: backfillRunId,
          // Pack factor breakdown + replay metadata into ai_analysis JSON-ish
          // so we can reconstruct the scoring chain during the SHIP 4 audit.
          ai_analysis: JSON.stringify({
            d358_event_id: o.event_id,
            d358_snapshot_timestamp: o.snapshot_timestamp,
            d358_bookmaker: o.bookmaker_key,
            d358_market_key: o.market_key,
            context_completeness: bundle.completeness,
            context_missing: bundle.missing.slice(0, 20),
            factor_breakdown: result.breakdown,
          }),
        });
      }

      scored++;
    }

    let writeCount = 0;
    if (!dryRun && replayRows.length > 0) {
      const wR = await fetch(`${SUPABASE_URL}/rest/v1/historical_replay_results`, {
        method: "POST",
        headers: { ...sH(), Prefer: "return=minimal" },
        body: JSON.stringify(replayRows),
      });
      if (wR.ok) writeCount = replayRows.length;
      else { const t = await wR.text(); console.error("write_fail", wR.status, t.slice(0, 400)); }
    }

    // D-358 SHIP 3 — synthetic pick_history write (chunked at 500/batch to
    // dodge Postgres single-statement size limits).
    let synthWriteCount = 0;
    const synthWriteErrors: string[] = [];
    if (!dryRun && writePickHistory && synthPickRows.length > 0) {
      for (let i = 0; i < synthPickRows.length; i += 500) {
        const chunk = synthPickRows.slice(i, i + 500);
        const wS = await fetch(`${SUPABASE_URL}/rest/v1/pick_history`, {
          method: "POST",
          headers: { ...sH(), Prefer: "return=minimal" },
          body: JSON.stringify(chunk),
        });
        if (wS.ok) synthWriteCount += chunk.length;
        else {
          const t = await wS.text();
          synthWriteErrors.push(`chunk ${i}: ${wS.status} ${t.slice(0, 200)}`);
          console.error("synth_write_fail", wS.status, t.slice(0, 400));
        }
      }
    }

    const summary = {
      success: true,
      replay_run_id: runId,
      backfill_run_id: backfillRunId,
      window: { start, end },
      bookmaker_filter: bookFilter,
      market_filter: marketFilter,
      candidates_seen: allOdds.length,
      closing_snapshots: closing.length,
      spreads_unpaired: unpairedSpreadsCount,
      scored,
      failed,
      no_outcome,
      no_event_match: no_event,
      avg_context_completeness: completenessSum.n > 0 ? completenessSum.total / completenessSum.n : 0,
      dry_run: dryRun,
      rows_written: writeCount,
      synth_pick_history_written: synthWriteCount,
      synth_pick_history_errors: synthWriteErrors.slice(0, 5),
      duration_ms: Date.now() - t0,
    };
    return j(summary);
  } finally {
    await releaseLock(LOCK_KEY, SUPABASE_URL, SUPABASE_KEY);
  }
});
