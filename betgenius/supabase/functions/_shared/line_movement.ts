// D-635 — Line movement v2 factor + display data.
// ─────────────────────────────────────────────────────────────────────
// Reads from cache_odds_snapshots (built in D-634) via the source-
// agnostic OddsSnapshot shape. NO direct calls to The Odds API or any
// provider — the same code works post-OddsJam swap because it reads
// the normalized snapshot table.
//
// Two responsibilities:
//   1. loadLineMovementMap() — pull per-pick "first vs latest" snapshot
//      for the sport+date once at the top of process-games, so per-pick
//      scoring doesn't need to query the DB.
//   2. applyLineMovementV2() — augment a scoring result with a line-
//      movement factor + breakdown fields the UI reads.
//
// D-636 — WEIGHT PULLED TO 0 (measure-only).
// CEO §2: new unproven signals gather + store + display + inform AI write-up
// but do NOT affect confidence scoring until the harness proves them.
// Weight is 0, not 0.5 — a partial weight still changes picks with an
// unproven signal. Factor STILL computes and writes breakdown so the D-549
// harness can measure r_residual on 30 days of data; promote to a real
// algorithm_weights row only after the measurement.

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────
export interface LineMovementSnapshot {
  line: number;
  odds: number;
  snapshot_time: string;
}

export interface LineMovementInfo {
  first: LineMovementSnapshot;  // earliest snapshot today for this pick
  last: LineMovementSnapshot;   // latest snapshot today for this pick
}

// Keyed by `${event_id}|${market}|${player_name}|${prop_type}|${pick_side}|${bookmaker}`.
// The map is built once per scoring run from a single SELECT.
export type LineMovementMap = Map<string, LineMovementInfo>;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
function lineMovementKey(
  event_id: string,
  market: string,
  player_name: string,
  prop_type: string,
  pick_side: string,
  bookmaker: string,
): string {
  return `${event_id}|${market}|${player_name.toLowerCase()}|${prop_type}|${pick_side.toLowerCase()}|${bookmaker.toLowerCase()}`;
}

// ─────────────────────────────────────────────────────────────────────
// loadLineMovementMap — single fetch + group into per-pick first/last
// ─────────────────────────────────────────────────────────────────────
export async function loadLineMovementMap(
  sport: string,
  gameDate: string,        // YYYY-MM-DD (ISO; cache_odds_snapshots stores ISO)
): Promise<LineMovementMap> {
  const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const map: LineMovementMap = new Map();
  let pStart = 0;
  const PAGE = 10000;
  for (let i = 0; i < 10; i++) {
    const url = `${SUPA_URL}/rest/v1/cache_odds_snapshots?sport=eq.${sport}` +
      `&game_date=eq.${encodeURIComponent(gameDate)}` +
      `&select=event_id,market,player_name,prop_type,pick_side,bookmaker,line,odds,snapshot_time` +
      `&order=snapshot_time.asc`;
    const r = await fetch(url, {
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        Range: `${pStart}-${pStart + PAGE - 1}`, "Range-Unit": "items",
      },
    });
    if (!r.ok) break;
    const rows = await r.json() as Array<{
      event_id: string; market: string; player_name: string;
      prop_type: string; pick_side: string; bookmaker: string;
      line: number; odds: number; snapshot_time: string;
    }>;
    for (const row of rows) {
      const k = lineMovementKey(
        row.event_id, row.market, row.player_name,
        row.prop_type, row.pick_side, row.bookmaker,
      );
      const snap: LineMovementSnapshot = {
        line: Number(row.line),
        odds: Number(row.odds),
        snapshot_time: row.snapshot_time,
      };
      const existing = map.get(k);
      if (!existing) {
        // First sighting (rows ordered ASC → this is the earliest).
        map.set(k, { first: snap, last: snap });
      } else {
        // Update last every iteration; first is already set.
        existing.last = snap;
      }
    }
    if (rows.length < PAGE) break;
    pStart += PAGE;
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────
// applyLineMovementV2 — augment a scoring result with line-movement
// factor + breakdown fields. Source-agnostic: reads the LineMovementMap
// built from cache_odds_snapshots (which the writer fills from whichever
// adapter is active).
//
// Movement signal logic (works for all sports + bets):
//   - For ANY pick_side, the side's OWN odds line getting MORE NEGATIVE
//     (price tightening on our side) = market priced our side higher =
//     CONFIRMING signal → score positive.
//   - Side's odds becoming LESS negative / more positive = market priced
//     our side lower = FADE → score negative.
//   - The line itself moving toward our side (OVER picks: line down /
//     UNDER picks: line up) is a SECONDARY confirming signal — we use it
//     to slightly boost the magnitude when present.
//
// Buckets (per ABS odds delta in cents):
//   ≥20¢: ±8   (strong)
//   ≥10¢: ±5   (moderate)
//   ≥5¢:  ±2   (mild)
//   <5¢:  0    (neutral / noise)
// ─────────────────────────────────────────────────────────────────────
export function applyLineMovementV2(
  ctx: {
    event_id: string;
    market: string;
    player_name: string;
    prop_type: string;
    pick_side: string;
    bookmaker: string;
  },
  scoreResult: { confidence: number; breakdown: Record<string, number | string | null | boolean> },
  lineMovementMap: LineMovementMap | null,
): { applied: boolean; factor_score: number } {
  // breakdown fields are written even when the map is empty / no data,
  // so the UI can render "no movement yet" rather than missing the
  // fields entirely. Set as nulls for the no-data case.
  if (!lineMovementMap) {
    scoreResult.breakdown.score_line_movement_v2 = 0;
    scoreResult.breakdown.lm_raw_score = 0;
    scoreResult.breakdown.lm_seed_weight = 0;
    scoreResult.breakdown.lm_opened_odds = null;
    scoreResult.breakdown.lm_current_odds = null;
    scoreResult.breakdown.lm_opened_line = null;
    scoreResult.breakdown.lm_current_line = null;
    scoreResult.breakdown.lm_toward_pick = null;
    scoreResult.breakdown.lm_magnitude = "no_data";
    scoreResult.breakdown.lm_delta_odds = 0;
    return { applied: false, factor_score: 0 };
  }
  const k = lineMovementKey(
    ctx.event_id, ctx.market, ctx.player_name,
    ctx.prop_type, ctx.pick_side, ctx.bookmaker,
  );
  const info = lineMovementMap.get(k);

  // No snapshots yet (e.g. brand-new pick scored before the first
  // snapshot-odds-writer tick fired). Factor 0; UI sees "no_data".
  if (!info) {
    scoreResult.breakdown.score_line_movement_v2 = 0;
    scoreResult.breakdown.lm_raw_score = 0;
    scoreResult.breakdown.lm_seed_weight = 0;
    scoreResult.breakdown.lm_opened_odds = null;
    scoreResult.breakdown.lm_current_odds = null;
    scoreResult.breakdown.lm_opened_line = null;
    scoreResult.breakdown.lm_current_line = null;
    scoreResult.breakdown.lm_toward_pick = null;
    scoreResult.breakdown.lm_magnitude = "no_data";
    scoreResult.breakdown.lm_delta_odds = 0;
    return { applied: false, factor_score: 0 };
  }

  // Only one snapshot exists (first.snapshot_time === last.snapshot_time).
  // No movement yet. Factor 0; UI shows opening price.
  if (info.first.snapshot_time === info.last.snapshot_time) {
    scoreResult.breakdown.score_line_movement_v2 = 0;
    scoreResult.breakdown.lm_raw_score = 0;
    scoreResult.breakdown.lm_seed_weight = 0;
    scoreResult.breakdown.lm_opened_odds = info.first.odds;
    scoreResult.breakdown.lm_current_odds = info.last.odds;
    scoreResult.breakdown.lm_opened_line = info.first.line;
    scoreResult.breakdown.lm_current_line = info.last.line;
    scoreResult.breakdown.lm_toward_pick = false;  // no direction yet
    scoreResult.breakdown.lm_magnitude = "no_movement";
    scoreResult.breakdown.lm_delta_odds = 0;
    return { applied: false, factor_score: 0 };
  }

  const oddsDelta = info.last.odds - info.first.odds;
  const lineDelta = info.last.line - info.first.line;
  // odds_delta < 0 = OUR side's price tightened = TOWARD us.
  // Holds for all markets/sports because the snapshot is per-side
  // (each side has its own odds line); we always reason from our pick's
  // own side, never the "other side."
  const towardPick = oddsDelta < 0;
  const absOdds = Math.abs(oddsDelta);

  let magnitude: "strong" | "moderate" | "mild" | "neutral" = "neutral";
  let baseScore = 0;
  if (absOdds >= 20) { magnitude = "strong"; baseScore = 8; }
  else if (absOdds >= 10) { magnitude = "moderate"; baseScore = 5; }
  else if (absOdds >= 5) { magnitude = "mild"; baseScore = 2; }

  // D-636 — SEED_WEIGHT pulled from 1.0 to 0. Factor still computes a
  // raw "if-it-mattered" score (recorded as lm_raw_score) so the D-549
  // harness can measure it, but the applied score is 0 — confidence is
  // not perturbed by this factor until the harness proves it.
  const SEED_WEIGHT = 0;
  const rawScore = (towardPick ? 1 : -1) * baseScore;
  let factorScore = rawScore * SEED_WEIGHT;
  // Cast to mute "unused after assignment" linter when we apply line-boost.

  // Secondary boost from LINE movement matching the side direction.
  // OVER picks benefit when line moves DOWN (easier to clear); UNDER
  // benefits when line moves UP. Game-side / h2h markets typically have
  // line=0; the line delta is then 0 and this boost is a no-op.
  let lineBoost = 0;
  if (Math.abs(lineDelta) >= 0.5) {
    const pickSide = ctx.pick_side.toLowerCase();
    if (pickSide === "over" && lineDelta < 0) lineBoost = 1;
    else if (pickSide === "under" && lineDelta > 0) lineBoost = 1;
    else if (pickSide === "over" && lineDelta > 0) lineBoost = -1;
    else if (pickSide === "under" && lineDelta < 0) lineBoost = -1;
  }
  // D-636 — line boost also weight 0. Record raw, apply 0.
  const rawTotal = rawScore + lineBoost;
  factorScore += lineBoost * SEED_WEIGHT;

  // D-636 — confidence NOT mutated (SEED_WEIGHT=0 makes factorScore 0;
  // skip the line entirely so the intent is explicit). The factor still
  // writes breakdown so the D-549 harness can read it.
  // OLD: scoreResult.confidence = clamp(scoreResult.confidence + factorScore);
  scoreResult.breakdown.score_line_movement_v2 = factorScore;       // applied (0)
  scoreResult.breakdown.lm_raw_score = rawTotal;                    // measured (non-zero)
  scoreResult.breakdown.lm_seed_weight = SEED_WEIGHT;
  scoreResult.breakdown.lm_opened_odds = info.first.odds;
  scoreResult.breakdown.lm_current_odds = info.last.odds;
  scoreResult.breakdown.lm_opened_line = info.first.line;
  scoreResult.breakdown.lm_current_line = info.last.line;
  scoreResult.breakdown.lm_toward_pick = towardPick;
  scoreResult.breakdown.lm_magnitude = magnitude;
  scoreResult.breakdown.lm_delta_odds = oddsDelta;

  return { applied: true, factor_score: factorScore };
}
