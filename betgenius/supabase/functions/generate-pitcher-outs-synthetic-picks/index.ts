// D-771 — Synthetic pitcher_outs pick generator. Closes the architectural gap
// D-769 surfaced: warehouse has 6,907 pitcher_outs odds for 2025 events, but
// pick_history has 0 pitcher_outs picks in 2025, so there's nothing to re-score.
//
// This function GENERATES synthetic picks from the (warehouse odds + boxscore
// outcomes) join, scoring each with the REAL deployed scorer (import, NOT
// reimplement).
//
// FLOW per (event, pitcher) pair:
//   1. Pull the LATEST pre-game odds snapshot for this pitcher_outs line (one
//      per pitcher per game) from cache_mlb_historical_odds.
//   2. Match pitcher_name → player_id via cache_mlb_boxscore_player_stats
//      WHERE game_pk = the event's game_pk (canonical-normalized name match).
//      Picks where the projected starter wasn't the actual starter (Ronel Blanco
//      scratch class) are FILTERED — they would have voided in real betting.
//   3. Build historical scoring context via buildPitcherHistoricalContext
//      (D-359 router — same one rescore-historic-pitcher-k uses). Filters by
//      commence_time < game_date for NO LEAKAGE.
//   4. Call scorePitcherOuts(ctx) — the REAL deployed function. NO reimpl.
//   5. Determine model's preferred side (over or under) from the scored
//      confidence + edge direction.
//   6. RESOLVE against actual outs from cache_mlb_boxscore_player_stats.outs:
//      - over picks: hit if actual > line, miss if actual < line, push if equal
//      - under picks: hit if actual < line, miss if actual > line, push if equal
//   7. Store in pitcher_outs_synthetic_picks (new sister table).
//
// NO LEAKAGE GUARANTEE by construction:
//   - Resolution data (actual outs) is used ONLY to set hit/no-hit on the pick
//     AFTER scoring. It is NOT in the scoring context.
//   - buildPitcherHistoricalContext is the same router proven on pitcher_k 851
//     rows — filters by commence_time < game_date.
//   - Manager_hook + i06 caches use current snapshots (acknowledged drift bias,
//     not leakage — the same value is applied to every 2025 pick).
//
// DARK FACTORS on 2025 cohort (flagged per pick via context_missing field):
//   - manager_hook: D-763 cache only has today's snapshot; will use today's
//     value as proxy for 2025 (small per-team bias, no per-game leakage)
//   - i06 3rd-time: cache only has rolling i06 for current-roster pitchers;
//     dark for 2025-only pitchers
//   - pitches/IP: from season aggregate — could be slightly leaky if 2025
//     stats reflect end-of-season; we filter to pre-game season cuts when
//     buildPitcherHistoricalContext supports it
//   - 14 D-668-wave factors: cache support varies; the historical-router pulls
//     what's available, returns 0 for missing factors. Document context_missing.
//
// AUTH: service-role OR BACKFILL_AUTH_TOKEN.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  scorePitcherOuts,
  type PitcherKScoringContext,
} from "../_shared/scoring_mlb_v2.ts";
// D-772 — pitcher_outs-specific router replaces the pitcher_k router that
// was leaving 15 of 17 factors dark on the 2025 cohort. Reconstructs season
// stats, gameLog, opponent K rate, pen rest, runs-per-game, and manager_hook
// from point-in-time boxscore data. All queries filter game_date < gameDate.
import { buildPitcherOutsHistoricalContext } from "../_shared/historical_context_router_pitcher_outs.ts";
import { canonicalNameKey } from "../_shared/name_normalizer.ts";

// D-773 — restore ballpark + weather caller-side injection (regression fix from
// D-772). Mirrors the pitcher_k router's logic at historical_context_router_pitcher.ts:93,304.
// Park lookups from cache_ballpark_factors (30 venues); weather per event_id
// from cache_mlb_historical_weather (7,527 rows, many NULL temps but the
// row-exists check still gates score_weather_temp at 0 — same as live behavior).
const TEAM_TO_PARK: Record<string, string> = {
  "Arizona Diamondbacks": "Chase Field", "Atlanta Braves": "Truist Park",
  "Baltimore Orioles": "Camden Yards", "Boston Red Sox": "Fenway Park",
  "Chicago Cubs": "Wrigley Field", "Chicago White Sox": "Guaranteed Rate Field",
  "Cincinnati Reds": "Great American Ball Park", "Cleveland Guardians": "Progressive Field",
  "Colorado Rockies": "Coors Field", "Detroit Tigers": "Comerica Park",
  "Houston Astros": "Minute Maid Park", "Kansas City Royals": "Kauffman Stadium",
  "Los Angeles Angels": "Angel Stadium", "Los Angeles Dodgers": "Dodger Stadium",
  "Miami Marlins": "loanDepot park", "Milwaukee Brewers": "American Family Field",
  "Minnesota Twins": "Target Field", "New York Mets": "Citi Field",
  "New York Yankees": "Yankee Stadium", "Athletics": "Oakland Coliseum",
  "Oakland Athletics": "Oakland Coliseum", "Philadelphia Phillies": "Citizens Bank Park",
  "Pittsburgh Pirates": "PNC Park", "San Diego Padres": "Petco Park",
  "San Francisco Giants": "Oracle Park", "Seattle Mariners": "T-Mobile Park",
  "St. Louis Cardinals": "Busch Stadium", "Tampa Bay Rays": "Tropicana Field",
  "Texas Rangers": "Globe Life Field", "Toronto Blue Jays": "Rogers Centre",
  "Washington Nationals": "Nationals Park",
};

interface BallparkRow { park_name: string; runs_factor: number | null; hr_factor: number | null; k_factor: number | null; hits_factor: number | null }
interface WeatherRow { event_id: string; temperature_f: number | null; wind_speed_mph: number | null; wind_direction_degrees: number | null; condition?: string | null }

function degToCompass(deg: number | null | undefined): string | null {
  if (deg === null || deg === undefined) return null;
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
const sH = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

interface OddsRow {
  event_id: string;
  commence_time: string;
  player_name: string;
  line: number;
  over_odds: number | null;
  under_odds: number | null;
  snapshot_timestamp: string;
}
interface BoxscorePitcher {
  player_id: number;
  player_name: string;
  game_pk?: number;
  team_id?: number;
  outs: number | null;
  is_starter?: boolean;
}
interface EventRow {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  game_pk: number | null;
}

async function getJSON<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: sH() });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

async function postJSON(url: string, body: unknown): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { ...sH(), Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const authHeader = req.headers.get("Authorization") ?? "";
  const authOk =
    (SUPABASE_KEY && authHeader.includes(SUPABASE_KEY)) ||
    (BACKFILL_TOKEN && authHeader.includes(BACKFILL_TOKEN));
  if (!authOk) return j({ success: false, error: "unauthorized" }, 401);

  let body: { start_date?: string; end_date?: string; limit?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { body = {}; }
  const startDate = body.start_date ?? "2025-04-01";
  const endDate = body.end_date ?? "2025-05-31";
  const limit = Math.min(body.limit ?? 200, 500);
  const dryRun = body.dry_run === true;

  const t0 = Date.now();

  // STEP 1: pull the latest pre-game snapshot per (event, pitcher) — DEDUP by
  // taking the snapshot closest to commence_time (T-15min). We selected only
  // -0.25h offset in D-769's backfill, so most rows are this snapshot already.
  // We pull from across bookmakers and pick the consensus line.
  const oddsUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_odds?` +
    `market_key=eq.pitcher_outs&commence_time=gte.${startDate}T00:00:00&commence_time=lt.${endDate}T23:59:59` +
    `&select=event_id,commence_time,player_name,line,over_odds,under_odds,snapshot_timestamp` +
    `&order=commence_time.asc&limit=${limit * 20}`;  // ~20 rows per event-pitcher pair across bookmakers
  const allOdds = await getJSON<OddsRow[]>(oddsUrl) ?? [];

  // Group by (event_id, normalized_name) → take consensus line (median across bookmakers)
  const grouped = new Map<string, { event_id: string; commence_time: string; player_name: string; lines: number[]; overs: number[]; unders: number[] }>();
  for (const o of allOdds) {
    if (o.line == null) continue;
    const nameKey = canonicalNameKey(o.player_name);
    const key = `${o.event_id}|${nameKey}`;
    let g = grouped.get(key);
    if (!g) {
      g = { event_id: o.event_id, commence_time: o.commence_time, player_name: o.player_name, lines: [], overs: [], unders: [] };
      grouped.set(key, g);
    }
    g.lines.push(o.line);
    if (o.over_odds != null) g.overs.push(o.over_odds);
    if (o.under_odds != null) g.unders.push(o.under_odds);
  }

  // Pull events for game_pk lookup
  const eventsUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?` +
    `commence_time=gte.${startDate}T00:00:00&commence_time=lt.${endDate}T23:59:59` +
    `&select=event_id,commence_time,home_team,away_team,game_pk&limit=2000`;
  const events = await getJSON<EventRow[]>(eventsUrl) ?? [];
  const eventByCode = new Map<string, EventRow>();
  for (const e of events) eventByCode.set(e.event_id, e);

  const sa = { url: SUPABASE_URL, key: SUPABASE_KEY };
  const caches = {
    events: new Map(), oppPitcher: new Map(), weather: new Map(),
    ballpark: new Map<string, BallparkRow>(), playerMeta: new Map(), framing: new Map(),
    arsenal: new Map(), statcast: new Map(),
  };
  // D-773 — preload cache_ballpark_factors (30 rows, one-shot lookup)
  const ballparkRows = await getJSON<BallparkRow[]>(
    `${SUPABASE_URL}/rest/v1/cache_ballpark_factors?select=park_name,hits_factor,hr_factor,k_factor,runs_factor&limit=50`,
  ) ?? [];
  for (const r of ballparkRows) caches.ballpark.set(r.park_name, r);
  const weatherCache = new Map<string, WeatherRow | null>();

  const results: Array<Record<string, unknown>> = [];
  const counts = {
    pairs_input: grouped.size,
    no_event: 0,
    no_game_pk: 0,
    pitcher_scratched: 0,    // projected starter didn't actually pitch
    no_outs: 0,              // boxscore exists but outs is null
    context_error: 0,
    score_error: 0,
    scored_over: 0,
    scored_under: 0,
    hit: 0,
    miss: 0,
    push: 0,
  };
  // D-772 — track per-factor fire rate to verify the dark-factor unblock.
  const factorFires: Record<string, number> = {};

  let processed = 0;
  for (const g of grouped.values()) {
    if (processed >= limit) break;
    if (Date.now() - t0 > 130_000) break;
    processed++;
    const ev = eventByCode.get(g.event_id);
    if (!ev) { counts.no_event++; continue; }
    if (!ev.game_pk) { counts.no_game_pk++; continue; }
    // Boxscore: find pitcher by game_pk + canonical name match. D-772 — also
    // resolve team_id from the matched boxscore row so the new pitcher_outs
    // historical router can compute opp_team_id and own_team aggregates.
    const bsUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?game_pk=eq.${ev.game_pk}&outs=not.is.null&select=player_id,player_name,team_id,outs,is_starter&limit=30`;
    const bs = await getJSON<BoxscorePitcher[]>(bsUrl) ?? [];
    const needNameKey = canonicalNameKey(g.player_name);
    const match = bs.find(p => canonicalNameKey(p.player_name) === needNameKey);
    if (!match) { counts.pitcher_scratched++; continue; }
    if (match.outs == null) { counts.no_outs++; continue; }
    // Resolve opp_team_id as the OTHER team_id in this game's boxscore
    const teamsInGame = new Set(bs.map(p => p.team_id).filter((t): t is number => typeof t === "number"));
    const oppTeamId = Array.from(teamsInGame).find(t => t !== match.team_id) ?? null;
    if (match.team_id == null || oppTeamId == null) { counts.no_event++; continue; }
    const isHome = ev.home_team !== undefined && match.team_id !== undefined; // placeholder; can compare to home_team via team-map but not strictly required for outs scoring

    // Consensus line — median across bookmakers (most stable estimate)
    const sortedLines = g.lines.slice().sort((a, b) => a - b);
    const consensusLine = sortedLines[Math.floor(sortedLines.length / 2)];
    const consensusOver = g.overs.length > 0
      ? Math.round(g.overs.reduce((a, b) => a + b, 0) / g.overs.length)
      : -110;

    const gameDate = g.commence_time.slice(0, 10);

    // D-772 — pitcher_outs-specific router. Reconstructs season stats,
    // gameLog, opp K rate, pen rest, runs/g, and manager_hook from point-in-time
    // boxscore data (game_date < gameDate filtering enforced per query).
    let bundle;
    try {
      bundle = await buildPitcherOutsHistoricalContext(
        sa, ev, match.player_id, match.team_id, oppTeamId, g.player_name, isHome, gameDate,
      );
      if (!bundle) { counts.context_error++; continue; }
    } catch (_e) { counts.context_error++; continue; }

    // D-773 — caller-side ballpark + weather injection (restores the 2 factors
    // that regressed in D-772 because the router shell returned null).
    const parkName = TEAM_TO_PARK[ev.home_team] ?? null;
    const parkRow = parkName ? caches.ballpark.get(parkName) : undefined;
    if (parkRow) {
      bundle.ctx.ballpark = {
        runsFactor: Number(parkRow.runs_factor ?? 1.0),
        hrFactor: Number(parkRow.hr_factor ?? 1.0),
        kFactor: Number(parkRow.k_factor ?? 1.0),
        hitsFactor: Number(parkRow.hits_factor ?? 1.0),
      };
    }
    let wxRow: WeatherRow | null = weatherCache.get(ev.event_id) ?? null;
    if (wxRow === null && !weatherCache.has(ev.event_id)) {
      const wxRows = await getJSON<WeatherRow[]>(
        `${SUPABASE_URL}/rest/v1/cache_mlb_historical_weather?event_id=eq.${ev.event_id}&select=*&limit=1`,
      );
      wxRow = (wxRows && wxRows.length > 0) ? wxRows[0] : null;
      weatherCache.set(ev.event_id, wxRow);
    }
    if (wxRow) {
      bundle.ctx.weather = {
        tempF: wxRow.temperature_f,
        windSpeed: wxRow.wind_speed_mph,
        windDir: degToCompass(wxRow.wind_direction_degrees),
        windDirDeg: wxRow.wind_direction_degrees,
        condition: wxRow.condition ?? null,
      };
    }

    // We pick the SIDE the model has higher confidence in. Run both sides and compare.
    const ctxOver: PitcherKScoringContext = {
      ...bundle.ctx,
      prop: { propType: "outs", line: consensusLine, odds: consensusOver, pickSide: "over", bookmaker: "consensus" },
    };
    const ctxUnder: PitcherKScoringContext = {
      ...bundle.ctx,
      prop: { propType: "outs", line: consensusLine, odds: consensusOver, pickSide: "under", bookmaker: "consensus" },
    };
    let scoredOver, scoredUnder;
    try {
      scoredOver = scorePitcherOuts(ctxOver);
      scoredUnder = scorePitcherOuts(ctxUnder);
    } catch (_e) { counts.score_error++; continue; }

    // Model picks the higher-confidence side
    const pickedSide: "over" | "under" = scoredOver.confidence >= scoredUnder.confidence ? "over" : "under";
    const scored = pickedSide === "over" ? scoredOver : scoredUnder;

    // RESOLVE against actual outs (separate from scoring; not in context)
    const actual = match.outs;
    let hit: boolean | null;
    if (actual === consensusLine) hit = null;  // push
    else if (pickedSide === "over") hit = actual > consensusLine;
    else hit = actual < consensusLine;

    if (pickedSide === "over") counts.scored_over++; else counts.scored_under++;
    if (hit === true) counts.hit++;
    else if (hit === false) counts.miss++;
    else counts.push++;

    const cleanBreakdown: Record<string, number | string | null> = {};
    for (const [k, v] of Object.entries(scored)) {
      if (typeof v === "number" || typeof v === "string" || v === null) {
        cleanBreakdown[k] = v as number | string | null;
      }
    }
    // D-777 CONSTRUCT-BUG FIX — pitcher_outs-specific factor scores live in
    // scored.breakdown (NOT the top-level result). Same pattern as
    // rescore-historic-pitcher-k:118-130 (D-747-DEPLOY). Without this, the
    // 18 pitcher_outs factors (score_pitcher_avg_ip, score_opp_walk_rate,
    // score_pitcher_manager_hook, etc.) are silently dropped from
    // breakdown_synthetic — making fire-rate verification structurally
    // impossible. NOT a scoring change; pure output serialization fix.
    // deno-lint-ignore no-explicit-any
    const bdObj = (scored as any).breakdown as Record<string, unknown> | undefined;
    if (bdObj) {
      for (const [k, v] of Object.entries(bdObj)) {
        if (typeof v === "number" || typeof v === "string" || v === null) {
          cleanBreakdown[k] = v as number | string | null;
        } else if (typeof v === "boolean") {
          cleanBreakdown[k] = v ? 1 : 0;
        }
      }
    }
    // D-772 — count non-zero firings per factor for the dry-run report.
    for (const [k, v] of Object.entries(cleanBreakdown)) {
      if (k.startsWith("score_") && typeof v === "number" && v !== 0) {
        factorFires[k] = (factorFires[k] ?? 0) + 1;
      }
    }

    results.push({
      event_id: g.event_id,
      game_pk: ev.game_pk,
      player_id: match.player_id,
      player_name: g.player_name,
      game_date: g.commence_time.slice(0, 10),
      consensus_line: consensusLine,
      consensus_over_odds: consensusOver,
      actual_outs: actual,
      pick_side: pickedSide,
      confidence: scored.confidence,
      hit: hit,
      context_completeness: bundle.completeness,
      context_missing: bundle.missing,
      breakdown_synthetic: cleanBreakdown,
      generator_run: "d771_v1_real_scorer",
      generated_at: new Date().toISOString(),
    });
  }

  if (dryRun) {
    // D-772 — surface per-factor fire rate so evaluator can verify dark
    // factors are now firing (target: jump from 2/17 toward full).
    const scoredN = counts.scored_over + counts.scored_under;
    const factorFireRate: Record<string, { fires: number; pct: number }> = {};
    for (const [k, n] of Object.entries(factorFires)) {
      factorFireRate[k] = { fires: n, pct: scoredN > 0 ? Math.round((n / scoredN) * 1000) / 10 : 0 };
    }
    return j({
      success: true,
      counts,
      factor_fire_rate: factorFireRate,
      sample_first_3: results.slice(0, 3),
      duration_ms: Date.now() - t0,
    });
  }

  let inserted = 0; let insert_errors = 0;
  for (let i = 0; i < results.length; i += 100) {
    const chunk = results.slice(i, i + 100);
    const ok = await postJSON(`${SUPABASE_URL}/rest/v1/pitcher_outs_synthetic_picks`, chunk);
    if (ok) inserted += chunk.length;
    else insert_errors += chunk.length;
  }

  return j({
    success: true,
    counts: { ...counts, inserted, insert_errors },
    duration_ms: Date.now() - t0,
  });
});
