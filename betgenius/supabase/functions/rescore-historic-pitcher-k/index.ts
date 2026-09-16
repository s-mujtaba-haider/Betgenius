// D-737f-B — Re-score historical pitcher_strikeouts picks through the REAL
// post-D-737d deployed scoring function. NO formula reimplementation — we
// import scorePitcherStrikeouts from _shared/scoring_mlb_v2.ts and call it.
//
// Flow per pick:
//   1. Read pitcher_k pick from pick_history (resolved, non-synthetic).
//   2. Look up event_id from cache_mlb_historical_events via commence_time
//      date + (home_team, away_team) match against pick.team/opponent.
//   3. Build historical scoring context via buildPitcherHistoricalContext
//      (D-359 SHIP 3 — uses cached historical data).
//   4. Construct full PitcherKScoringContext by adding prop info.
//   5. Call scorePitcherStrikeouts(ctx) — the REAL deployed function.
//   6. Persist clean breakdown to pitcher_k_rescore_results (new table).
//
// Original pick_history.breakdown is PRESERVED — we write to a sister table.
//
// AUTH: service-role or BACKFILL_AUTH_TOKEN.
// Mutex: simple in-process (single-instance assumption — function is short-running).
//
// HONEST SCOPE: per D-359 router, opposingHitting + umpire + lineupKComposition
// are DARK for historical (no per-game sources) → those factors return 0. The
// at-risk Math.round-asymmetry bug fix (D-737d) applies to all FIRING factors;
// the dark factors were 0 before and after, so the re-scored breakdown is
// CORRECT for what the post-D-737d code would produce given identical inputs.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  scorePitcherStrikeouts,
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
  hit: boolean | null;
  actual_value: number | null;
  confidence: number | null;
  scoring_inputs: PitcherKScoringContext | null;  // D-742 PART 3 — captured ctx
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

  // Auth: accept SR key OR backfill token
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
  const startDate = body.start_date ?? "2026-03-26"; // opening day this season
  const endDate = body.end_date ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(body.limit ?? 1500, 2000);
  const dryRun = body.dry_run === true;

  // Pull resolved pitcher_k picks in the window — including scoring_inputs (D-742 PART 3).
  // When scoring_inputs is non-null, we can replay the formula directly with 100% parity.
  const picksUrl =
    `${SUPABASE_URL}/rest/v1/pick_history?` +
    `sport=eq.mlb&mlb_market_type=eq.pitcher_k&is_synthetic=eq.false` +
    `&hit=not.is.null&game_date=gte.${startDate}&game_date=lte.${endDate}` +
    `&select=id,player_id,player_name,team,opponent,game_date,pick_side,line,hit,actual_value,confidence,scoring_inputs` +
    `&order=game_date.asc&limit=${limit}`;
  const picks = (await getJSON<PickRow[]>(picksUrl)) ?? [];

  if (picks.length === 0) {
    return j({ success: true, picks_found: 0, message: "no picks in window" });
  }

  // For event lookup we need cache_mlb_historical_events filtered to the date window
  const eventsUrl =
    `${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?` +
    `commence_time=gte.${startDate}T00:00:00&commence_time=lt.${endDate}T23:59:59` +
    `&select=event_id,commence_time,home_team,away_team&limit=10000`;
  const events = (await getJSON<EventRow[]>(eventsUrl)) ?? [];

  // Build event lookup map: key by date|home|away
  const eventMap = new Map<string, EventRow>();
  for (const e of events) {
    const d = e.commence_time.slice(0, 10);
    eventMap.set(`${d}|${e.home_team}|${e.away_team}`, e);
  }

  const sa = { url: SUPABASE_URL, key: SUPABASE_KEY };

  const results: Array<Record<string, unknown>> = [];
  const counts = {
    picks_processed: 0,
    rescored: 0,
    no_event: 0,
    no_player_id: 0,
    context_error: 0,
    score_error: 0,
  };
  const factor_match_sample: Record<string, { matches: number; total: number; diffs: Array<{ stored: number; rescored: number; pick: string }> }> = {};

  // Shared caches across picks (perf)
  const caches = {
    events: new Map(),
    oppPitcher: new Map(),
    weather: new Map(),
    ballpark: new Map(),
    playerMeta: new Map(),
    framing: new Map(),
    arsenal: new Map(),
    statcast: new Map(),
  };

  for (const p of picks) {
    counts.picks_processed += 1;

    // D-742 PART 3 — FAST PATH: if scoring_inputs was captured at live scoring time
    // (post-D-742 deploy), replay the formula directly with 100% parity by construction.
    // No warehouse reconstruction, no API re-fetch, no temporal drift.
    if (p.scoring_inputs && p.scoring_inputs.pitcher && p.scoring_inputs.prop) {
      const ctxLive = p.scoring_inputs as PitcherKScoringContext;
      let scored;
      try {
        scored = scorePitcherStrikeouts(ctxLive);
      } catch (_e) {
        counts.score_error += 1;
        continue;
      }
      const cleanBreakdown: Record<string, number | string | null> = {};
      for (const [k, v] of Object.entries(scored)) {
        if (typeof v === "number" || typeof v === "string" || v === null) {
          cleanBreakdown[k] = v as number | string | null;
        }
      }
      // D-747-DEPLOY — also flatten result.breakdown into cleanBreakdown so
      // downstream analysis (offline simulations, evaluators) can see projected_k,
      // statcast_xera, weather_*, season_*, and the rest of the raw input snapshot.
      // Previously only top-level score_* + confidence + projectedK persisted; the
      // nested breakdown object was dropped during JSONB serialization.
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
      counts.rescored += 1;
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
        old_projected_k: null,
        new_projected_k: scored.projectedK,
        context_completeness: 1.0,
        context_missing: [] as string[],
        breakdown_rescored: cleanBreakdown,
        rescored_at: new Date().toISOString(),
        rescore_run: "d742_input_replay",  // D-742 — distinguished from historical-router rescores
      });
      continue;
    }

    // FALLBACK: historical router reconstruction (pre-D-742 picks).
    if (!p.player_id) {
      counts.no_player_id += 1;
      continue;
    }

    // Resolve event_id: try both orientations (team home or away)
    let ev = eventMap.get(`${p.game_date}|${p.team}|${p.opponent}`);
    if (!ev) ev = eventMap.get(`${p.game_date}|${p.opponent}|${p.team}`);
    if (!ev) {
      counts.no_event += 1;
      continue;
    }

    // Build historical context
    let bundle;
    try {
      bundle = await buildPitcherHistoricalContext(sa, ev.event_id, p.player_id, caches);
    } catch (_e) {
      counts.context_error += 1;
      continue;
    }

    // Construct full context with prop info from the pick
    const ctx: PitcherKScoringContext = {
      ...bundle.ctx,
      prop: {
        propType: "strikeouts",
        line: p.line,
        odds: -110, // placeholder; scoring doesn't use odds for factor computation
        pickSide: p.pick_side,
        bookmaker: "historical",
      },
    };

    // Call the REAL deployed scoring function
    let scored;
    try {
      scored = scorePitcherStrikeouts(ctx);
    } catch (_e) {
      counts.score_error += 1;
      continue;
    }

    // Build clean breakdown JSONB (factor scores + metadata)
    const cleanBreakdown: Record<string, number | string | null> = {};
    for (const [k, v] of Object.entries(scored)) {
      if (typeof v === "number" || typeof v === "string" || v === null) {
        cleanBreakdown[k] = v as number | string | null;
      }
    }

    counts.rescored += 1;
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
      old_projected_k: null, // we'd need to read old breakdown to compare
      new_projected_k: scored.projectedK,
      context_completeness: bundle.completeness,
      context_missing: bundle.missing,
      breakdown_rescored: cleanBreakdown,
      rescored_at: new Date().toISOString(),
    });
  }

  if (dryRun) {
    return j({
      success: true,
      counts,
      sample_first_3: results.slice(0, 3),
    });
  }

  // Bulk insert into pitcher_k_rescore_results
  // Insert in chunks of 100
  let inserted = 0;
  let insert_errors = 0;
  for (let i = 0; i < results.length; i += 100) {
    const chunk = results.slice(i, i + 100);
    const ok = await postJSON(
      `${SUPABASE_URL}/rest/v1/pitcher_k_rescore_results`,
      chunk,
    );
    if (ok) inserted += chunk.length;
    else insert_errors += chunk.length;
  }

  return j({
    success: true,
    counts: { ...counts, inserted, insert_errors },
    window: { startDate, endDate, limit },
    results_count: results.length,
  });
});
