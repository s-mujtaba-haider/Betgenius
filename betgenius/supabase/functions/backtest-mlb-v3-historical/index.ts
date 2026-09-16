// D-289 PHASE 5 — historical backtest engine v3.
//
// MVP scope: resolves closing-snapshot odds against cache_mlb_historical_outcomes,
// aggregates per-market WR + 95% Wilson CI. Two modes:
//   - mode='market_baseline': pure resolution; signal = implied probability
//     from closing American odds. Shows base hit rates if you always bet
//     the higher-EV side per book consensus.
//   - mode='algo_replay': STUB. Full 14-factor algo replay requires
//     historical Statcast/splits/lineup data we don't have. CEO Option C
//     allows current-snapshot proxy — D-290 work.
//
// Writes a row to historical_backtest_runs per invocation.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const supaHeaders = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

function americanToProb(o: number): number {
  if (o > 0) return 100 / (o + 100);
  return -o / (-o + 100);
}

function wilsonCi(hits: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const p = hits / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

interface OddsRow {
  event_id: string;
  snapshot_timestamp: string;
  bookmaker_key: string;
  market_key: string;
  player_name: string;
  line: number;
  over_odds: number | null;
  under_odds: number | null;
  commence_time: string;
}

interface Outcome {
  event_id: string;
  home_score: number | null;
  away_score: number | null;
  home_team: string;
  away_team: string;
  game_completed: boolean;
  resolution_data: Record<string, { hits?: number; total_bases?: number; home_runs?: number; rbi?: number; strikeouts?: number; innings_pitched?: number }>;
}

// Resolve one (market, player, line) against an outcome.
// Returns: 'over' | 'under' | 'push' | 'no_data'
function resolveLine(market: string, player: string, line: number, outcome: Outcome): "over" | "under" | "push" | "no_data" {
  if (market === "h2h__home" || market === "h2h__away") {
    if (outcome.home_score === null || outcome.away_score === null) return "no_data";
    const homeWon = outcome.home_score > outcome.away_score;
    return market === "h2h__home" ? (homeWon ? "over" : "under") : (homeWon ? "under" : "over");
  }
  if (market === "totals") {
    if (outcome.home_score === null || outcome.away_score === null) return "no_data";
    const total = outcome.home_score + outcome.away_score;
    if (total > line) return "over";
    if (total < line) return "under";
    return "push";
  }
  if (market.startsWith("spreads")) {
    if (outcome.home_score === null || outcome.away_score === null) return "no_data";
    const isHome = market === "spreads__home";
    const teamScore = isHome ? outcome.home_score : outcome.away_score;
    const oppScore = isHome ? outcome.away_score : outcome.home_score;
    const adjusted = teamScore + line;  // line is signed for that team
    if (adjusted > oppScore) return "over";
    if (adjusted < oppScore) return "under";
    return "push";
  }
  // Player prop markets
  const stat = outcome.resolution_data?.[player];
  if (!stat) return "no_data";
  let actual: number | undefined;
  if (market === "batter_hits") actual = stat.hits;
  else if (market === "batter_total_bases") actual = stat.total_bases;
  else if (market === "batter_home_runs") actual = stat.home_runs;
  else if (market === "batter_rbis") actual = stat.rbi;
  else if (market === "pitcher_strikeouts") actual = stat.strikeouts;
  else return "no_data";
  if (actual === undefined) return "no_data";
  if (actual > line) return "over";
  if (actual < line) return "under";
  return "push";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return j({ error: "missing env" }, 500);
  const auth = req.headers.get("authorization") || "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  let body: {
    mode?: "market_baseline" | "algo_replay";
    window_start?: string;
    window_end?: string;
    bookmaker_priority?: string[];
    snapshot_position?: "earliest" | "closing";
    max_rows?: number;
    factor_set_version?: string;
  } = {};
  try { body = await req.json(); } catch { /* defaults */ }

  const mode = body.mode ?? "market_baseline";
  const windowStart = body.window_start ?? "2024-01-01";
  const windowEnd = body.window_end ?? "2025-10-31";
  const snapshotPosition = body.snapshot_position ?? "closing";
  const maxRows = Math.min(body.max_rows ?? 50_000, 200_000);
  const bookmakerPriority = body.bookmaker_priority ?? ["hardrockbet", "draftkings", "fanduel"];
  const factorVersion = body.factor_set_version ?? "v2.69_14factor";

  if (mode === "algo_replay") {
    return j({
      success: false,
      error: "algo_replay mode not yet implemented",
      note: "Full 14-factor algo replay against historical odds requires re-executing scoreBatterMarket/scorePitcherStrikeouts with historical Statcast/splits/lineup contexts. Current Statcast proxy approach (CEO Option C) requires importing scoring_mlb logic into this function plus loading current preload caches. Scoped for D-290.",
    });
  }

  const start = Date.now();

  // Load outcomes for the window — keyed by event_id
  const outUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?game_completed=eq.true&commence_time=gte.${windowStart}T00:00:00Z&commence_time=lte.${windowEnd}T23:59:59Z&select=event_id,commence_time,home_team,away_team,home_score,away_score,game_completed,resolution_data&limit=100000`;
  const or = await fetch(outUrl, { headers: supaHeaders() });
  if (!or.ok) return j({ error: `outcomes fetch ${or.status}` }, 500);
  const outcomes = await or.json() as Outcome[];
  const outByEvent = new Map<string, Outcome>();
  for (const o of outcomes) outByEvent.set(o.event_id, o);

  // Load odds for the window — paginated since may be > 1M rows
  // We pull closing snapshot only (latest per event/bookmaker/market/player/line)
  // PostgREST: order DESC by snapshot_timestamp + limit per event group is hard
  // Simplification: pull ALL odds in window, then de-dup in JS taking the most-recent
  // (or earliest) per group depending on snapshot_position.
  const oddsUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_odds?commence_time=gte.${windowStart}T00:00:00Z&commence_time=lte.${windowEnd}T23:59:59Z&select=event_id,snapshot_timestamp,bookmaker_key,market_key,player_name,line,over_odds,under_odds,commence_time&order=snapshot_timestamp.${snapshotPosition === "closing" ? "desc" : "asc"}&limit=${maxRows}`;
  const odr = await fetch(oddsUrl, { headers: supaHeaders() });
  if (!odr.ok) return j({ error: `odds fetch ${odr.status}` }, 500);
  const oddsRows = await odr.json() as OddsRow[];

  // Group → take first per (event, bookmaker, market, player, line) by chosen snapshot position
  const seenKey = new Set<string>();
  const pickRows: OddsRow[] = [];
  for (const r of oddsRows) {
    const k = `${r.event_id}|${r.bookmaker_key}|${r.market_key}|${r.player_name}|${r.line}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    pickRows.push(r);
  }

  // For each pick row, pick the bookmaker in priority order
  // (keep all bookmakers for now — we'll filter at the resolution step)
  const filtered = pickRows.filter((r) => bookmakerPriority.includes(r.bookmaker_key));

  // Resolve each pick. Mode: market_baseline = bet the side with HIGHER implied prob (lower juice).
  interface Stats { n: number; hits: number; pushes: number; no_data: number; signal_sum: number; }
  const perMarket = new Map<string, Stats>();
  const perBookmaker = new Map<string, Stats>();
  let total = 0;
  let totalNoData = 0;
  let totalPush = 0;

  for (const r of filtered) {
    const outcome = outByEvent.get(r.event_id);
    if (!outcome) { totalNoData++; continue; }
    // Determine bet side
    let side: "over" | "under";
    if (r.over_odds === null || r.under_odds === null) {
      // Only one side priced — use it
      side = r.over_odds !== null ? "over" : "under";
    } else {
      const overP = americanToProb(r.over_odds);
      const underP = americanToProb(r.under_odds);
      side = overP > underP ? "over" : "under";
    }
    const result = resolveLine(r.market_key, r.player_name, r.line, outcome);
    if (result === "no_data") { totalNoData++; continue; }
    if (result === "push") { totalPush++; continue; }
    const hit = result === side ? 1 : 0;
    total++;
    const bucket = perMarket.get(r.market_key) ?? { n: 0, hits: 0, pushes: 0, no_data: 0, signal_sum: 0 };
    bucket.n++;
    bucket.hits += hit;
    perMarket.set(r.market_key, bucket);
    const bm = perBookmaker.get(r.bookmaker_key) ?? { n: 0, hits: 0, pushes: 0, no_data: 0, signal_sum: 0 };
    bm.n++;
    bm.hits += hit;
    perBookmaker.set(r.bookmaker_key, bm);
  }

  const perMarketResults: Record<string, { n: number; wr: number; ci_low: number; ci_high: number }> = {};
  for (const [m, s] of perMarket.entries()) {
    const ci = wilsonCi(s.hits, s.n);
    perMarketResults[m] = { n: s.n, wr: s.n > 0 ? s.hits / s.n : 0, ci_low: ci.low, ci_high: ci.high };
  }

  const perBookmakerResults: Record<string, { n: number; wr: number; ci_low: number; ci_high: number }> = {};
  for (const [bm, s] of perBookmaker.entries()) {
    const ci = wilsonCi(s.hits, s.n);
    perBookmakerResults[bm] = { n: s.n, wr: s.n > 0 ? s.hits / s.n : 0, ci_low: ci.low, ci_high: ci.high };
  }

  const overall = total > 0 ? Array.from(perMarket.values()).reduce((a, s) => a + s.hits, 0) / total : 0;

  const results = {
    mode,
    window_start: windowStart, window_end: windowEnd,
    snapshot_position: snapshotPosition,
    bookmakers_used: bookmakerPriority,
    total_picks_resolved: total,
    pushes: totalPush,
    no_data: totalNoData,
    overall_wr: overall,
    per_market: perMarketResults,
    per_bookmaker: perBookmakerResults,
    outcomes_loaded: outcomes.length,
    odds_rows_scanned: oddsRows.length,
    duration_ms: Date.now() - start,
  };

  // Write to historical_backtest_runs
  await fetch(`${SUPABASE_URL}/rest/v1/historical_backtest_runs`, {
    method: "POST",
    headers: { ...supaHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify({
      factor_set_version: `${factorVersion}_${mode}`,
      train_window_start: null, train_window_end: null,
      validate_window_start: windowStart, validate_window_end: windowEnd,
      weights_used: { mode },
      results_json: results,
      cto_recommendation: "baseline_only_pending_full_algo",
      notes: `D-289 MVP. mode=${mode}. snapshot=${snapshotPosition}.`,
    }),
  });

  return j(results);
});
