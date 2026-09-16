// D-767 — Re-score historical pitcher_outs picks through the REAL deployed
// post-D-668-wave scoring function. NO formula reimplementation — we import
// scorePitcherOuts from _shared/scoring_mlb_v2.ts and call it. This is the
// pitcher_outs analog of rescore-historic-pitcher-k (D-737f-B).
//
// HONEST WAREHOUSE FINDING (D-767 audit):
//   cache_mlb_historical_odds has 0 pitcher_outs rows. fetch-historical-odds-mlb's
//   ALL_MARKETS constant explicitly excludes pitcher_outs (captures only h2h,
//   spreads, totals, batter_hits, batter_total_bases, batter_home_runs,
//   batter_rbis, pitcher_strikeouts). So this re-score CANNOT expand the cohort
//   beyond what's already in pick_history. It can only re-score the 295 live
//   picks under the current model.
//
//   The structural unblock is INFRA: add pitcher_outs to ALL_MARKETS + run a
//   historical Odds API backfill. Deferred to D-768.
//
// Flow per pick:
//   1. D-742 PART 3 FAST PATH: if scoring_inputs is populated (D-756 RPC fix,
//      landed 2026-06-25 22 UTC), replay the formula directly — 100% parity
//      by construction. Currently fires on 0 resolved picks; coverage grows
//      forward as live picks resolve.
//   2. FALLBACK: historical-router reconstruction via buildPitcherHistoricalContext.
//      Pitcher_outs-specific factors (own_pen_rest, opp_batting_stats, ballpark,
//      weather, statcast xera) reconstruct from cache. Dark factors (manager_hook,
//      i06 3rd-time, pitches/IP from older games not yet in cache) return 0.
//   3. Call scorePitcherOuts(ctx) — the REAL deployed function.
//   4. Persist to pitcher_outs_rescore_results (new sister table — original
//      pick_history.breakdown PRESERVED).
//
// AUTH: service-role or BACKFILL_AUTH_TOKEN.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  scorePitcherOuts,
  type PitcherKScoringContext,
} from "../_shared/scoring_mlb_v2.ts";
import { buildPitcherHistoricalContext } from "../_shared/historical_context_router_pitcher.ts";

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

interface PickRow {
  id: string;
  player_id: number | null;
  player_name: string;
  team: string;
  opponent: string;
  game_date: string;
  pick_side: "over" | "under";
  line: number;
  odds: number | null;
  hit: boolean | null;
  actual_value: number | null;
  confidence: number | null;
  scoring_inputs: PitcherKScoringContext | null;
  breakdown: Record<string, unknown> | null;
}

interface EventRow {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
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
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const authOk =
    (SUPABASE_KEY && authHeader.includes(SUPABASE_KEY)) ||
    (BACKFILL_TOKEN && authHeader.includes(BACKFILL_TOKEN));
  if (!authOk) return j({ success: false, error: "unauthorized" }, 401);

  let body: { start_date?: string; end_date?: string; limit?: number; dry_run?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const startDate = body.start_date ?? "2026-06-13"; // earliest pitcher_outs pick
  const endDate = body.end_date ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(body.limit ?? 500, 1000);
  const dryRun = body.dry_run === true;

  // Pull resolved pitcher_outs picks (D-742 PART 3 scoring_inputs included)
  const picksUrl =
    `${SUPABASE_URL}/rest/v1/pick_history?` +
    `sport=eq.mlb&mlb_market_type=eq.pitcher_outs&is_synthetic=eq.false` +
    `&hit=not.is.null&game_date=gte.${startDate}&game_date=lte.${endDate}` +
    `&select=id,player_id,player_name,team,opponent,game_date,pick_side,line,odds,hit,actual_value,confidence,scoring_inputs,breakdown` +
    `&order=game_date.asc&limit=${limit}`;
  const picks = (await getJSON<PickRow[]>(picksUrl)) ?? [];

  if (picks.length === 0) {
    return j({ success: true, picks_found: 0, message: "no picks in window" });
  }

  // Event lookup for the date window
  const eventsUrl =
    `${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?` +
    `commence_time=gte.${startDate}T00:00:00&commence_time=lt.${endDate}T23:59:59` +
    `&select=event_id,commence_time,home_team,away_team&limit=10000`;
  const events = (await getJSON<EventRow[]>(eventsUrl)) ?? [];
  const eventMap = new Map<string, EventRow>();
  for (const e of events) {
    const d = e.commence_time.slice(0, 10);
    eventMap.set(`${d}|${e.home_team}|${e.away_team}`, e);
  }

  const sa = { url: SUPABASE_URL, key: SUPABASE_KEY };

  const results: Array<Record<string, unknown>> = [];
  const counts = {
    picks_processed: 0,
    rescored_fast_path: 0,
    rescored_historical_router: 0,
    no_event: 0,
    no_player_id: 0,
    context_error: 0,
    score_error: 0,
  };
  // Per-factor parity: compare new score_* values vs stored breakdown values
  const factorParity: Record<string, { matches: number; diffs: number; total: number }> = {};
  const trackFactor = (k: string, stored: unknown, fresh: unknown) => {
    const s = factorParity[k] ?? { matches: 0, diffs: 0, total: 0 };
    s.total += 1;
    if (stored == null && fresh == null) { /* both null = neutral */ }
    else if (stored === fresh) s.matches += 1;
    else s.diffs += 1;
    factorParity[k] = s;
  };

  const caches = {
    events: new Map(), oppPitcher: new Map(), weather: new Map(),
    ballpark: new Map(), playerMeta: new Map(), framing: new Map(),
    arsenal: new Map(), statcast: new Map(),
  };

  for (const p of picks) {
    counts.picks_processed += 1;
    let scored: ReturnType<typeof scorePitcherOuts> | null = null;
    let completeness: number = 1.0;
    let missing: string[] = [];
    let path: "fast" | "historical" = "historical";

    // FAST PATH (D-742 PART 3): scoring_inputs replay
    if (p.scoring_inputs && p.scoring_inputs.pitcher && p.scoring_inputs.prop) {
      const ctxLive = p.scoring_inputs as PitcherKScoringContext;
      try {
        scored = scorePitcherOuts(ctxLive);
        path = "fast";
        counts.rescored_fast_path += 1;
      } catch (_e) {
        counts.score_error += 1;
        continue;
      }
    } else {
      // FALLBACK: historical-router reconstruction
      if (!p.player_id) { counts.no_player_id += 1; continue; }
      let ev = eventMap.get(`${p.game_date}|${p.team}|${p.opponent}`);
      if (!ev) ev = eventMap.get(`${p.game_date}|${p.opponent}|${p.team}`);
      if (!ev) { counts.no_event += 1; continue; }
      let bundle;
      try {
        bundle = await buildPitcherHistoricalContext(sa, ev.event_id, p.player_id, caches);
      } catch (_e) { counts.context_error += 1; continue; }
      const ctx: PitcherKScoringContext = {
        ...bundle.ctx,
        prop: {
          propType: "outs",
          line: p.line,
          odds: p.odds ?? -110,
          pickSide: p.pick_side,
          bookmaker: "historical",
        },
      };
      try {
        scored = scorePitcherOuts(ctx);
        completeness = bundle.completeness;
        missing = bundle.missing;
        counts.rescored_historical_router += 1;
      } catch (_e) { counts.score_error += 1; continue; }
    }

    // Clean breakdown for persistence + parity tracking
    const cleanBreakdown: Record<string, number | string | null> = {};
    for (const [k, v] of Object.entries(scored)) {
      if (typeof v === "number" || typeof v === "string" || v === null) {
        cleanBreakdown[k] = v as number | string | null;
      }
    }
    // Track parity for every score_* key vs the stored breakdown
    const storedBd = (p.breakdown ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(cleanBreakdown)) {
      if (k.startsWith("score_")) trackFactor(k, storedBd[k], v);
    }

    results.push({
      pick_id: p.id,
      player_id: p.player_id,
      game_date: p.game_date,
      pick_side: p.pick_side,
      line: p.line,
      hit: p.hit,
      actual_value: p.actual_value,
      old_confidence: p.confidence,
      new_confidence: scored.confidence,
      context_completeness: completeness,
      context_missing: missing,
      breakdown_rescored: cleanBreakdown,
      rescore_path: path,
      rescored_at: new Date().toISOString(),
      rescore_run: "d767_real_scorer_import",
    });
  }

  // Parity summary — % match per factor
  const paritySummary: Record<string, { match_pct: number; n: number; diffs: number }> = {};
  for (const [k, s] of Object.entries(factorParity)) {
    const denom = s.total;
    paritySummary[k] = {
      match_pct: denom > 0 ? Math.round(1000 * s.matches / denom) / 10 : 0,
      n: denom,
      diffs: s.diffs,
    };
  }

  if (dryRun) {
    return j({
      success: true,
      counts,
      parity: paritySummary,
      window: { startDate, endDate, limit },
      sample_first_3: results.slice(0, 3),
    });
  }

  let inserted = 0; let insert_errors = 0;
  for (let i = 0; i < results.length; i += 100) {
    const chunk = results.slice(i, i + 100);
    const ok = await postJSON(`${SUPABASE_URL}/rest/v1/pitcher_outs_rescore_results`, chunk);
    if (ok) inserted += chunk.length;
    else insert_errors += chunk.length;
  }

  return j({
    success: true,
    counts: { ...counts, inserted, insert_errors },
    parity: paritySummary,
    window: { startDate, endDate, limit },
    results_count: results.length,
  });
});
