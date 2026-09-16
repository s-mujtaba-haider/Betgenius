// process-games-mlb — D-204 Batch 3 Tasks 3.1-3.4.
//
// 7-market MLB Beta scorer. Reads MLB props from props_cache + 5 T3.0 cache
// tables + MLB Stats API live data, dispatches to market-specific scorers in
// _shared/scoring_mlb.ts, writes to recommendations_cache + pick_history with
// all D-204 score_* + sanity flag columns via upsert_pick_history RPC.
//
// MARKETS (D-203 enum / pick_history.mlb_market_type CHECK):
//   pitcher_k          (T3.1) — strikeouts
//   batter_hits        (T3.2) — hits
//   batter_total_bases (T3.4) — total_bases
//   batter_rbis        (T3.4) — rbis / runs_batted_in
//   batter_hr          (T3.4) — home_runs
//   game_side          (T3.3) — h2h / spreads
//   game_total         (T3.3) — totals
//
// AUTH: service-role gated. Trigger: cron jobid 21 every 30 min + manual.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
declare const Deno: any;
import { notify } from "../_shared/notify.ts";
import {
  getPitcherStatcast, getBatterStatcast,
  bulkLoadPitcherStatcast, bulkLoadBatterStatcast
} from "../_shared/statcast.ts";
import { captureError } from "../_shared/sentry.ts";
import {
  scorePitcherStrikeouts, scorePitcherOuts, scoreBatterHits, scoreBatterTotalBases,
  scoreBatterRbis, scoreBatterHomeRuns, scoreBatterStrikeouts,
  scoreBatterRunsScored, scoreGameSide, scoreGameTotal,
  setMlbWeights,  // D-340 / T6 — DB-tunable weights
  // D-534 — per-market weight plumbing
  setMlbWeightsWithPerMarket, setActiveMarket,
  type PitcherSeasonStats, type PitcherGameLogEntry, type TeamHittingStats,
  type BatterSeasonStats, type BatterGameLogEntry, type OpposingPitcherContext,
  type TeamSeasonContext, type H2HRecent,
  type BallparkFactor, type GameWeather, type UmpireStats,
  type BatterMarketResult, type GameMarketResult,
} from "../_shared/scoring_mlb_v2.ts";
import { loadMlbWeightsFromDB, loadMlbWeightsWithPerMarket } from "../_shared/mlb_weights.ts";
import { mlbRecommendationShown } from "../_shared/mlb_ev_policy.ts";
import { getCalibratedMarketWinRate } from "../_shared/dynamic_scoring_wrapper.ts";
import { getMlbPickCommentary } from "../_shared/anthropic_mlb.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";
import { selectBestSameLineBook } from "../_shared/best_price.ts";
import { cacheMarketTrainingFeatures, cacheMarketGateMetrics, type MarketMetricsRow, type MarketGateMetricsRow } from "../_shared/market_metrics.ts";

let _marketMetrics: Map<string, MarketMetricsRow> = new Map();
let _gateMetrics: Map<string, MarketGateMetricsRow> = new Map();
import { evaluateMarketGate, type MarketGateMetrics } from "../_shared/market_gate.ts";

// D-826 Phase 2 — build gate metrics from real DB aggregates.
// Returns null if no gate data exists for this market+side, which causes
// mlb_ev_policy to fail-safe (recommendation_shown = false).
function buildMarketGateMetrics(market: string, pickSide: string): MarketGateMetrics | null {
  const gm = _gateMetrics.get(`${market}|${pickSide}`);
  if (!gm) return null;
  return {
    roiLowerBound: gm.roi_lower_bound,
    sampleSize: gm.sample_size,
    brierScore: gm.brier_score,
    baselineBrierScore: gm.baseline_brier_score,
    avgClv: gm.avg_clv,
    gradingCompleteness: gm.grading_completeness,
  };
}
// D-635 — line-movement v2 augmentation. Reads cache_odds_snapshots
// (D-634) via the source-agnostic OddsSnapshot vocabulary; the same
// code works after a future OddsJam/Sportradar swap.
import {
  loadLineMovementMap, applyLineMovementV2,
  type LineMovementMap,
} from "../_shared/line_movement.ts";
// Module-level for cross-function reach (scorer functions defined at
// top level, set once per handler invocation in the main try block).
let _d635_lineMovementMap: LineMovementMap | null = null;
// D-636 — sharp-money (RLM proxy + steam) augmentation. Same source-
// agnostic pattern as D-635; reads cache_odds_snapshots cross-book.
// SEED_WEIGHT=0 — measure-only. Confidence is NOT perturbed.
import {
  loadSharpMoneyMap, applySharpMoneyV2,
  type SharpMoneyMap,
} from "../_shared/sharp_money.ts";
let _d636_sharpMoneyMap: SharpMoneyMap | null = null;
// D-347 — venue lat/lon + haversine for travel_getaway factor.
import { venueByTeamName, venueByVenueName, haversineMiles, travelDirection } from "../_shared/mlb_venues.ts";
// D-488 STAGE 3 — unified pick_history writer (MLB caller migration).
// The local writePickHistory wrapper below now delegates to the canonical
// _shared/pick_history_writer.ts helper. NBA has been on this path since
// D-487 with 7+ days clean; MLB joins now. See d486_write_path_design.md
// for the rollout design.
import {
  writePickHistory as canonicalWritePickHistory,
  type PickHistoryPayload,
  // D-723: prefetch the cache_mlb_player_metadata unique-name → player_id map
  // at the top of each cron run so writePickHistory can auto-fill player_id
  // on every new pick without a per-pick REST roundtrip.
  prefetchMlbPlayerIds,
} from "../_shared/pick_history_writer.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

// D-302 SHIP 2 — all 30 MLB team IDs for active-roster preload.
const MLB_TEAM_IDS: number[] = [108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 158];

// D-381 SHIP 4 (post-pivot) — collect SAME-LINE multi-book odds for a primary
// pick. Returns an array of {bookmaker, line, odds, pick_side} matching the
// established AvailableBook shape NBA's process-games already writes to the
// existing recommendations_cache.available_books JSONB column (added in
// 20260428000000_path_c_step1_line_shopping_schema.sql). Dashboard's existing
// LineShoppingSection already renders this shape; Games.tsx is built fresh
// in SHIP 4. Hard Rock prioritization happens at frontend render time via
// findBestPrice (bookmaker.startsWith("hardrockbet")), so no write-time sort.
function buildAvailableBooks(
  matchingProps: PropRow[],
  primaryLine: number,
  primarySide: string,
): Array<{ bookmaker: string; line: number; odds: number; pick_side: string }> {
  const sameLine = matchingProps.filter(
    (p) => p.line === primaryLine && p.pick_side === primarySide,
  );
  // Dedup by bookmaker (different snapshots of same book → keep first).
  const seenBook = new Set<string>();
  const entries: Array<{ bookmaker: string; line: number; odds: number; pick_side: string }> = [];
  for (const p of sameLine) {
    if (seenBook.has(p.bookmaker)) continue;
    seenBook.add(p.bookmaker);
    entries.push({ bookmaker: p.bookmaker, line: p.line, odds: p.odds, pick_side: p.pick_side });
  }
  return entries;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const supaHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

// D-253f dry-run gate: module-scope flag set at top of Deno.serve per-request.
// Deno edge functions are per-invocation so module-scope effectively scopes to
// the current request. writeRecommendationsCache + writePickHistory + logError
// + checkpoint + notify all early-return when true.
let _dryRun = false;
const _dryRunCounts = {
  recommendations_cache: 0,
  pick_history: 0,
  error_log: 0,
};
function _resetDryRunCounts(): void {
  _dryRunCounts.recommendations_cache = 0;
  _dryRunCounts.pick_history = 0;
  _dryRunCounts.error_log = 0;
}

// ============================================================
// Types
// ============================================================

interface PropRow {
  game_date: string;
  event_id: string;
  player_name: string;
  prop_type: string;
  line: number;
  odds: number;
  bookmaker: string;
  pick_side: string;     // wider than "over"/"under" for game props (could be "home"/"away")
  home_team: string;
  away_team: string;
  game_time: string;
  updated_at?: string;
}

interface ProbablePitcher {
  id: number;
  fullName: string;
  teamName: string;
  opposingTeamName: string;
  opposingTeamId: number;
  gameTime: string;
  isHome: boolean;
  venue: string | null;
  // For batter scoring of OPPONENTS: the pitcher facing the batter
}

interface ScheduledGame {
  gamePk: number;
  homeTeam: string;
  awayTeam: string;
  homeTeamId: number;
  awayTeamId: number;
  homeProbableId: number | null;
  awayProbableId: number | null;
  gameTime: string;
  venue: string | null;
}

// ============================================================
// Helpers
// ============================================================

function parseInningsPitched(ip: number | string | null | undefined): number {
  if (ip == null) return 0;
  const s = String(ip);
  const i = s.indexOf(".");
  if (i < 0) return Number(s) || 0;
  return (Number(s.slice(0, i)) || 0) + (Number(s.slice(i + 1)) || 0) / 3;
}
function todayYyyymmddEt(): string {
  return new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}
function ymdToIsoDate(y: string): string { return `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`; }
// D-728: was a weak one-liner that dropped accented chars entirely
// ("Andrés García" → "andrs garca"). Now delegates to the shared canonical
// normalizer (resolve-picks' D-716 robust impl). Behavior improvements:
//   - "Lastname, Firstname" → "Firstname Lastname" (D-716)
//   - NFD + Slavic char preservation ("Andrés" → "andres", not "andrs")
//   - Jr./Sr./III suffix stripping
// All process-games-mlb call sites compare normalized output against other
// normalized output from the SAME normalizer, so the canonical-form change
// is internally consistent. The Slavic/accent improvement fixes latent
// roster-lookup mismatches that the weak version was silently dropping.
import { canonicalNormalizeName as normalizeName } from "../_shared/name_normalizer.ts";
// D-620 — Sonnet-call gating. Module-level cache of existing rec_cache
// rows; lookups inside the per-pick scoring loops decide whether the
// new pick's signature matches the existing one (REUSE ai_analysis) or
// differs (CALL Sonnet for fresh ai_analysis).
//
// "Same pick" = same line + same pick_side + same odds-bucket (10¢) +
// same confidence-band (5 pt). If any one differs → the math/edge/
// projection moved enough to warrant a fresh Sonnet narrative.
interface D620ExistingPick { line: number; pick_side: string; odds: number; confidence: number; ai_analysis: string }
let _d620_existingPickCache: Map<string, D620ExistingPick> = new Map();
let _d620_sonnetReused = 0;
let _d620_sonnetCalled = 0;
function _d620_pickKey(playerName: string, propType: string, pickSide: string): string {
  return `${playerName}|${propType}|${pickSide}`;
}
function _d620_pickSignature(line: number, pickSide: string, odds: number, confidence: number): string {
  // odds bucketed to 10¢ (matches D-619 hash); confidence bucketed to 5 pt.
  const ob = Math.round(odds / 10) * 10;
  const cb = Math.round(confidence / 5) * 5;
  return `${line}|${pickSide}|${ob}|${cb}`;
}
// Returns the existing ai_analysis if the new pick matches the existing
// one in signature AND the existing narrative isn't a template stub.
// Returns null → caller must call Sonnet.
function d620MaybeReuseSonnet(
  playerName: string, propType: string, pickSide: string,
  newLine: number, newOdds: number, newConfidence: number,
): string | null {
  const key = _d620_pickKey(playerName, propType, pickSide);
  const existing = _d620_existingPickCache.get(key);
  if (!existing) return null;
  if (!existing.ai_analysis) return null;
  // Template stubs don't count as "valid existing narrative".
  if (existing.ai_analysis.indexOf("v1 MLB") >= 0) return null;
  if (existing.ai_analysis.indexOf("Algorithm projection") >= 0) return null;
  const newSig = _d620_pickSignature(newLine, pickSide, newOdds, newConfidence);
  const oldSig = _d620_pickSignature(existing.line, existing.pick_side, existing.odds, existing.confidence);
  if (newSig !== oldSig) return null;
  _d620_sonnetReused++;
  return existing.ai_analysis;
}
// D-619 — team-key normalization for D-617 hash lookup.
// MLB Stats API and The Odds API disagree on minor formatting (periods,
// dashes, "Oakland Athletics" vs "Athletics"). Strip everything but
// [a-z0-9] so trivial format differences don't break the matchup lookup.
function normTeamKey(s: string): string { return (s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
// D-619 — round American odds to nearest 10¢ bucket for the hash key.
// Sub-10¢ jiggle (-110 → -113) hashes the same; meaningful moves
// (-110 → -125, or +110 → +120 at the boundary) cross a bucket and trigger
// a re-score. Materiality gate before the full time-window redesign (D-620).
function bucketOdds10c(odds: number): number { return Math.round(odds / 10) * 10; }

// D-284 SHIP 1 — concurrency-bounded map. Runs `fn` over `items` with at
// most `concurrency` in-flight Promises. Preserves order in results.
async function concurrentMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  let _d752_loggedErrors = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i]); }
      catch (e) {
        // D-752 — surface per-item errors. Pre-D-752 these were silently
        // swallowed, hiding D-749's NaN cascade for hours: every Phase B
        // callback threw on the malformed breakdown but scored.length=0 had
        // no error trail. Cap log volume at 3 per call so a real bug that
        // throws on every item doesn't drown error_log. Index + message is
        // enough to localize; full stack would 10x the row weight.
        if (_d752_loggedErrors < 3) {
          _d752_loggedErrors++;
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          logError("concurrent-map", "phase_b_swallowed_error", msg.slice(0, 240), {
            item_index: i, total_items: items.length, logged_so_far: _d752_loggedErrors,
          }).catch(() => { /* logError failures are themselves logged elsewhere */ });
        }
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function quietFetch(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status: number; text: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) { return { ok: false, status: 0, text: String(e) }; }
  finally { clearTimeout(t); }
}
async function logError(phase: string, errorType: string, msg: string, ctx: Record<string, unknown> = {}): Promise<void> {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    // D-253f: suppress error_log writes in dry-run EXCEPT dry_run_internal telemetry.
    if (_dryRun && errorType !== "dry_run_internal") {
      _dryRunCounts.error_log++;
      return;
    }
    await fetch(SUPABASE_URL + "/rest/v1/error_log", {
      method: "POST", headers: { ...supaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ function_name: "process-games-mlb", phase, error_type: errorType, error_message: msg, context: ctx }),
    });
  } catch { /* best-effort */ }
}

// D-232 Fix 3 — checkpoint() writes mid-function progress markers to
// error_log with `info` semantics. Reuses error_log because there's no
// dedicated progress table; the existing error_log filters by
// error_type so checkpoint entries with error_type='checkpoint' are
// easy to isolate. Every checkpoint stamps elapsed_ms since the
// passed-in startTime so future silent-hangs surface the exact step
// where the 150s budget was consumed.
async function checkpoint(step: string, startMs: number, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    // D-253f: skip checkpoint writes in dry-run (they POST to error_log).
    if (_dryRun) {
      _dryRunCounts.error_log++;
      return;
    }
    await fetch(SUPABASE_URL + "/rest/v1/error_log", {
      method: "POST", headers: { ...supaHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({
        function_name: "process-games-mlb",
        phase: "checkpoint",
        error_type: "checkpoint",
        error_message: step,
        context: { step, elapsed_ms: Date.now() - startMs, ...extra },
      }),
    });
  } catch { /* swallow */ }
}

// ============================================================
// MLB Stats API readers
// ============================================================

// D-789 — VERIFICATION-ONLY module-level flag set by main handler.
// Defaults to false; when true the fetchScheduleFull D-374 Preview-only
// filter is bypassed so verification ticks can re-score Live/Final games.
let _d789_bypassPreview = false;

async function fetchScheduleFull(isoDate: string): Promise<ScheduledGame[]> {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&date=${isoDate}&hydrate=probablePitcher,venue`;
  const { ok, text } = await quietFetch(url);
  if (!ok) { await logError("fetch-schedule", "http_error", text.slice(0, 200), { iso: isoDate }); return []; }
  const out: ScheduledGame[] = [];
  let skippedLive = 0;
  let skippedFinal = 0;
  try {
    const d = JSON.parse(text);
    for (const dt of d?.dates ?? []) {
      for (const g of dt?.games ?? []) {
        // D-374 Track B SHIP 4 — skip games whose state is no longer "Preview"
        // (i.e., already in progress or completed). Without this filter the
        // 30-min cron re-scores live games every tick, burning Anthropic
        // credits and mutating recommendations_cache mid-game (Sonnet dedup
        // window is exactly 30 min, so it re-fires at every boundary).
        // Picks should freeze at first pitch.
        // D-789 verification override: when _d789_bypassPreview=true, skip
        // this filter (still emits the skipped_live/final tally for logs).
        const state = g?.status?.abstractGameState as string | undefined;
        if (state && state !== "Preview" && !_d789_bypassPreview) {
          if (state === "Live") skippedLive++;
          else if (state === "Final") skippedFinal++;
          continue;
        }
        out.push({
          gamePk: g?.gamePk ?? 0,
          homeTeam: g?.teams?.home?.team?.name ?? "",
          awayTeam: g?.teams?.away?.team?.name ?? "",
          homeTeamId: g?.teams?.home?.team?.id ?? 0,
          awayTeamId: g?.teams?.away?.team?.id ?? 0,
          homeProbableId: g?.teams?.home?.probablePitcher?.id ?? null,
          awayProbableId: g?.teams?.away?.probablePitcher?.id ?? null,
          gameTime: g?.gameDate ?? "",
          venue: g?.venue?.name ?? null,
        });
      }
    }
  } catch (e) { await logError("fetch-schedule", "parse_error", String(e), { iso: isoDate }); }
  if (skippedLive > 0 || skippedFinal > 0) {
    await logError("fetch-schedule", "d374_skipped_in_progress", `D-374 filter excluded games`, {
      iso: isoDate, skipped_live: skippedLive, skipped_final: skippedFinal, kept: out.length,
    });
  }
  return out;
}

async function fetchPersonHand(playerId: number): Promise<{ pitchHand: "L" | "R" | null; bats: "L" | "R" | "S" | null }> {
  const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/people/${playerId}`);
  if (!ok) return { pitchHand: null, bats: null };
  try {
    const d = JSON.parse(text);
    const p = d?.people?.[0] ?? {};
    const ph = p.pitchHand?.code;
    const b = p.batSide?.code;
    return {
      pitchHand: ph === "L" || ph === "R" ? ph : null,
      bats: b === "L" || b === "R" || b === "S" ? b : null,
    };
  } catch { return { pitchHand: null, bats: null }; }
}

async function fetchPitcherSeason(playerId: number, season: number): Promise<PitcherSeasonStats | null> {
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=season&season=${season}&group=pitching`;
  const { ok, text } = await quietFetch(url);
  if (!ok) return null;
  try {
    const d = JSON.parse(text);
    const split = d?.stats?.[0]?.splits?.[0];
    if (!split) return null;
    const s = split.stat ?? {};
    const ip = parseInningsPitched(s.inningsPitched);
    const games = Number(s.gamesPlayed) || 0;
    const hand = await fetchPersonHand(playerId);
    return {
      gamesPlayed: games, inningsPitched: ip,
      strikeOuts: Number(s.strikeOuts) || 0,
      battersFaced: Number(s.battersFaced) || 0,
      kPerNine: Number(s.strikeoutsPer9Inn) || 0,
      era: Number(s.era) || 0,
      pitchesPerStart: games > 0 && s.numberOfPitches !== undefined ? Number(s.numberOfPitches) / games : null,
      throws: hand.pitchHand,
      // D-671 SHIP 1 — REAL baseOnBalls from SAME season-pitching response body.
      // Replaces D-670 fake walk_efficiency formula. Zero new HTTP.
      baseOnBalls: Number(s.baseOnBalls) || 0,
    };
  } catch { return null; }
}

async function fetchPitcherSeasonAsOpposing(playerId: number, season: number): Promise<OpposingPitcherContext | null> {
  const sp = await fetchPitcherSeason(playerId, season);
  if (!sp) return null;
  const personUrl = `${MLB_STATS_BASE}/people/${playerId}`;
  const personRes = await quietFetch(personUrl);
  let fullName = "";
  try {
    if (personRes.ok) {
      const d = JSON.parse(personRes.text);
      fullName = d?.people?.[0]?.fullName ?? "";
    }
  } catch { /* ignore */ }
  // Pull WHIP + HR/9 from extended stats endpoint
  const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/people/${playerId}/stats?stats=season&season=${season}&group=pitching`);
  let whip = 0, hr9 = 0;
  // D-661 — extract groundOutsToAirouts ratio from the SAME response body.
  // No extra API call. Drives the D-661 score_pitcher_gb_fb_rate HR factor.
  let goToAo: number | null = null;
  // D-663 — gamesStarted extracted from the SAME response body. Combined with
  // inningsPitched in the scorer to derive IP-per-start. Zero new HTTP.
  let gs: number | null = null;
  if (ok) {
    try {
      const d = JSON.parse(text);
      const stat = d?.stats?.[0]?.splits?.[0]?.stat ?? {};
      whip = Number(stat.whip) || 0;
      hr9 = Number(stat.homeRunsPer9) || 0;
      // groundOutsToAirouts is a string like "1.05" in the MLB Stats API payload.
      if (stat.groundOutsToAirouts !== undefined && stat.groundOutsToAirouts !== null) {
        const parsed = Number(stat.groundOutsToAirouts);
        if (Number.isFinite(parsed) && parsed > 0) goToAo = parsed;
      }
      // gamesStarted is a number in the MLB Stats API payload.
      if (stat.gamesStarted !== undefined && stat.gamesStarted !== null) {
        const parsedGs = Number(stat.gamesStarted);
        if (Number.isFinite(parsedGs) && parsedGs > 0) gs = parsedGs;
      }
    } catch { /* ignore */ }
  }
  // D-652 — pull Statcast arsenal aggregates for v3 SP-quality factor.
  // Per D-646 fix the cache covers ~24.6% of distinct pitchers (598/2431).
  let expectedWhiffPct: number | null = null;
  let expectedKPct: number | null = null;
  let expectedPutAway: number | null = null;
  try {
    const aUrl = `${SUPABASE_URL}/rest/v1/cache_statcast_pitcher_arsenal?player_id=eq.${playerId}&expected_put_away=not.is.null&order=snapshot_date.desc&limit=1&select=expected_whiff_pct,expected_k_pct,expected_put_away`;
    const aRes = await fetch(aUrl, { headers: supaHeaders });
    if (aRes.ok) {
      const rows = await aRes.json() as Array<{ expected_whiff_pct: number | null; expected_k_pct: number | null; expected_put_away: number | null }>;
      if (rows.length > 0) {
        expectedWhiffPct = typeof rows[0].expected_whiff_pct === "number" ? rows[0].expected_whiff_pct : null;
        expectedKPct = typeof rows[0].expected_k_pct === "number" ? rows[0].expected_k_pct : null;
        expectedPutAway = typeof rows[0].expected_put_away === "number" ? rows[0].expected_put_away : null;
      }
    }
  } catch { /* graceful degrade — v3 SP quality falls back to ERA-only */ }

  // D-803 — pull pitcher hard-contact-ALLOWED from cache_statcast_pitchers_exit_velo.
  // Closes the D-800 finding: the data was being fetched into _pitcherCache by
  // bulkLoadPitcherStatcast but DROPPED at this construction (OpposingPitcherContext
  // pre-D-803 had no field for it). Same xwOBA pattern as D-796. Latest snapshot
  // strictly is used here at live-scoring time (point-in-time for live picks; for
  // backfill use snapshot_date < game_date). Coverage ~25% (mirrors arsenal cache).
  let oppPitcherEv95Percent: number | null = null;
  let oppPitcherBrlPa: number | null = null;
  let oppPitcherBrlPercent: number | null = null;
  let oppPitcherAvgHitSpeed: number | null = null;
  try {
    const evUrl = `${SUPABASE_URL}/rest/v1/cache_statcast_pitchers_exit_velo?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=ev95percent,brl_pa,brl_percent,avg_hit_speed`;
    const evRes = await fetch(evUrl, { headers: supaHeaders });
    if (evRes.ok) {
      const rows = await evRes.json() as Array<{ ev95percent: number | null; brl_pa: number | null; brl_percent: number | null; avg_hit_speed: number | null }>;
      if (rows.length > 0) {
        oppPitcherEv95Percent = typeof rows[0].ev95percent === "number" ? rows[0].ev95percent : null;
        oppPitcherBrlPa = typeof rows[0].brl_pa === "number" ? rows[0].brl_pa : null;
        oppPitcherBrlPercent = typeof rows[0].brl_percent === "number" ? rows[0].brl_percent : null;
        oppPitcherAvgHitSpeed = typeof rows[0].avg_hit_speed === "number" ? rows[0].avg_hit_speed : null;
      }
    }
  } catch { /* graceful degrade — D-803 factor returns 0 on cache miss */ }

  return {
    fullName,
    throws: sp.throws,
    era: sp.era,
    whip,
    kPerNine: sp.kPerNine,
    hrPerNine: hr9,
    inningsPitched: sp.inningsPitched,
    last3Era: null,
    expectedWhiffPct,
    expectedKPct,
    expectedPutAway,
    // D-661 — ground-out-to-air-out ratio (GB/FB equivalent).
    groundOutsToAirouts: goToAo,
    // D-663 — gamesStarted for IP/start factor.
    gamesStarted: gs,
    // D-664 — last-3-start ERA from cache_mlb_pitcher_last3 (lazy-loaded below).
    last3StartEra: await readLast3StartEra(playerId),
    // D-803 — closes D-800 loaded-then-dropped finding on pitcher side.
    oppPitcherEv95Percent,
    oppPitcherBrlPa,
    oppPitcherBrlPercent,
    oppPitcherAvgHitSpeed,
  };
}

// D-664 — lookup last-3-start aggregate ERA. Single PostgREST row per pitcher per tick.
// Memoized via the existing process-games-mlb cache layer above.
async function readLast3StartEra(playerId: number): Promise<number | null> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/cache_mlb_pitcher_last3?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=last3_era`;
    const r = await fetch(url, { headers: supaHeaders });
    if (!r.ok) return null;
    const rows = await r.json() as Array<{ last3_era: number | null }>;
    if (rows.length === 0) return null;
    return rows[0].last3_era != null ? Number(rows[0].last3_era) : null;
  } catch { return null; }
}

async function fetchPitcherGameLog(playerId: number, season: number): Promise<PitcherGameLogEntry[]> {
  const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/people/${playerId}/stats?stats=gameLog&season=${season}&group=pitching`);
  if (!ok) return [];
  try {
    const d = JSON.parse(text);
    const splits = d?.stats?.[0]?.splits ?? [];
    const entries: PitcherGameLogEntry[] = splits.map((sp: { date?: string; opponent?: { name?: string }; stat?: Record<string, unknown> }) => {
      const st = sp.stat ?? {};
      return {
        date: sp.date ?? "",
        strikeOuts: Number(st.strikeOuts) || 0,
        inningsPitched: parseInningsPitched(st.inningsPitched as number | string),
        opponent: sp.opponent?.name ?? "",
        // D-335 SHIP 4 — MLB API gameLog never returns pitchesThrown (D-333 diagnostic).
        // Populated from cache_mlb_boxscore_player_stats below.
        pitchCount: st.pitchesThrown !== undefined ? Number(st.pitchesThrown) : null,
        // D-348 — walks per start. MLB API exposes as st.baseOnBalls.
        walks: st.baseOnBalls !== undefined ? Number(st.baseOnBalls) : null,
      };
    });

    // D-335 SHIP 4 — enrich with pitches_thrown from cache_mlb_boxscore_player_stats.
    if (entries.length > 0) {
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?player_id=eq.${playerId}&pitches_thrown=not.is.null&select=game_date,pitches_thrown&order=game_date.desc&limit=50`;
        const r = await fetch(url, { headers: supaHeaders });
        if (r.ok) {
          const rows = await r.json() as Array<{ game_date: string; pitches_thrown: number | null }>;
          const pcByDate = new Map<string, number>();
          for (const c of rows) {
            if (c.pitches_thrown !== null) pcByDate.set(c.game_date, c.pitches_thrown);
          }
          for (const e of entries) {
            if (e.pitchCount === null) {
              const pc = pcByDate.get(e.date);
              if (typeof pc === "number") e.pitchCount = pc;
            }
          }
        }
      } catch { /* graceful degrade */ }
    }
    return entries;
  } catch { return []; }
}

async function fetchBatterSeason(playerId: number, season: number): Promise<BatterSeasonStats | null> {
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=season&season=${season}&group=hitting`;
  const { ok, text } = await quietFetch(url);
  if (!ok) return null;
  try {
    const d = JSON.parse(text);
    const split = d?.stats?.[0]?.splits?.[0];
    if (!split) return null;
    const s = split.stat ?? {};
    const hand = await fetchPersonHand(playerId);
    const pa = Number(s.plateAppearances) || 0;
    const ab = Number(s.atBats) || 0;
    const hits = Number(s.hits) || 0;
    const tb = Number(s.totalBases) || 0;
    const hr = Number(s.homeRuns) || 0;
    const slg = ab > 0 ? tb / ab : 0;
    const avg = ab > 0 ? hits / ab : 0;
    return {
      gamesPlayed: Number(s.gamesPlayed) || 0,
      atBats: ab, hits, plateAppearances: pa,
      battingAvg: avg, babip: Number(s.babip) || 0, obp: Number(s.obp) || 0,
      bats: hand.bats,
      homeRuns: hr, totalBases: tb, rbi: Number(s.rbi) || 0,
      hrPerPA: pa > 0 ? hr / pa : 0,
      iso: slg - avg,
      avgVsLHP: null, avgVsRHP: null,
      // D-474 — batter season K total for scoreBatterStrikeouts.
      strikeOuts: Number(s.strikeOuts) || 0,
      // D-475 — batter season runs scored for scoreBatterRunsScored.
      runs: Number(s.runs) || 0,
    };
  } catch { return null; }
}

async function fetchBatterGameLog(playerId: number, season: number): Promise<BatterGameLogEntry[]> {
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=gameLog&season=${season}&group=hitting`;
  const { ok, text } = await quietFetch(url);
  if (!ok) return [];
  try {
    const d = JSON.parse(text);
    const splits = d?.stats?.[0]?.splits ?? [];
    const entries: BatterGameLogEntry[] = splits.map((sp: { date?: string; stat?: Record<string, unknown> }) => {
      const st = sp.stat ?? {};
      return {
        date: sp.date ?? "",
        atBats: Number(st.atBats) || 0,
        hits: Number(st.hits) || 0,
        homeRuns: Number(st.homeRuns) || 0,
        totalBases: Number(st.totalBases) || 0,
        rbi: Number(st.rbi) || 0,
        plateAppearances: Number(st.plateAppearances) || 0,
        // D-335 SHIP 4 — MLB API gameLog never returns batting order slot.
        // Populated from cache_mlb_boxscore_player_stats below.
        battingOrderSlot: null,
        // D-474 — per-game K count for scoreBatterStrikeouts last-N form factor.
        strikeOuts: Number(st.strikeOuts) || 0,
        // D-475 — per-game runs scored for scoreBatterRunsScored last-N form factor.
        runs: Number(st.runs) || 0,
      };
    });

    // D-335 SHIP 4 — enrich with batting_order_slot from cache_mlb_boxscore_player_stats.
    if (entries.length > 0) {
      try {
        const cUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?player_id=eq.${playerId}&batting_order_slot=not.is.null&select=game_date,batting_order_slot&order=game_date.desc&limit=50`;
        const r = await fetch(cUrl, { headers: supaHeaders });
        if (r.ok) {
          const rows = await r.json() as Array<{ game_date: string; batting_order_slot: number | null }>;
          const slotByDate = new Map<string, number>();
          for (const c of rows) {
            if (c.batting_order_slot !== null) slotByDate.set(c.game_date, c.batting_order_slot);
          }
          for (const e of entries) {
            const slot = slotByDate.get(e.date);
            if (typeof slot === "number") e.battingOrderSlot = slot;
          }
        }
      } catch { /* graceful degrade */ }
    }
    return entries;
  } catch { return []; }
}

// Player-id resolver. Use /people/search?names=<x>&sportIds=1 to map name → ID.
async function resolvePlayerIdByName(name: string): Promise<number | null> {
  const q = encodeURIComponent(name);
  const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/people/search?names=${q}&sportIds=1`);
  if (!ok) return null;
  try {
    const d = JSON.parse(text);
    const people = d?.people ?? [];
    // Take the first active MLB player
    const active = people.find((p: { active?: boolean }) => p.active === true) ?? people[0];
    return active?.id ?? null;
  } catch { return null; }
}

// ============================================================
// D-269 (2026-05-19): Active-lineup gate
// ============================================================
// Pre-D-269: process-games-mlb scored EVERY batter for whom a book posted a
// prop, with no check whether the batter was actually starting that game.
// Real bug: Kyle Schwarber Total Bases OVER 1.5 @ Strong 87 confidence
// recommended on 2026-05-18 + 2026-05-19; Schwarber did not start either
// game. Subscribers betting that pick lost on day 1.
//
// Fix: before scoring a batter prop, verify the batter is in today's
// starting lineup per MLB Stats API. If lineup not yet published (early
// morning before lineups are out), allow scoring but mark with pending_
// lineup_flag for downstream cleanup once lineups land.
//
// MLB Stats API exposes lineups via /schedule?date=...&hydrate=lineups
// per gamePk under teams.{home,away}.lineup[] (array of player objects
// with fullName + id).

const _lineupCache = new Map<number, Set<string> | null>();
const _lineupCacheTime = new Map<number, number>();
const LINEUP_TTL_MS = 5 * 60 * 1000; // 5 min — lineups can change late

// Uses /game/{gamePk}/boxscore — works for both pre-game (Warmup/Pre-Game
// state) and post-game. Starters identified by battingOrder ending in "00"
// (e.g., "100"=cleanup, "200"=2nd in order, ..., "900"=9th). The /schedule
// endpoint's hydrate=lineups returns nothing in practice; boxscore is the
// authoritative source.
async function fetchLineupForGame(gamePk: number): Promise<Set<string> | null> {
  const now = Date.now();
  const cachedAt = _lineupCacheTime.get(gamePk);
  if (cachedAt && (now - cachedAt) < LINEUP_TTL_MS) {
    return _lineupCache.get(gamePk) ?? null;
  }
  const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/game/${gamePk}/boxscore`);
  if (!ok) {
    _lineupCache.set(gamePk, null);
    _lineupCacheTime.set(gamePk, now);
    return null;
  }
  try {
    const d = JSON.parse(text) as {
      teams?: {
        home?: { players?: Record<string, { person?: { fullName?: string }; battingOrder?: string }> };
        away?: { players?: Record<string, { person?: { fullName?: string }; battingOrder?: string }> };
      };
    };
    const set = new Set<string>();
    for (const side of ["home", "away"] as const) {
      const players = d?.teams?.[side]?.players ?? {};
      for (const pid of Object.keys(players)) {
        const p = players[pid];
        const order = p?.battingOrder ?? "";
        // Starters have battingOrder = "X00" (3 chars ending in 00).
        if (order.length === 3 && order.endsWith("00")) {
          const nm = p?.person?.fullName;
          if (nm) set.add(normalizeName(nm));
        }
      }
    }
    if (set.size === 0) {
      // Lineup not yet locked — null signals "unknown, don't block"
      _lineupCache.set(gamePk, null);
      _lineupCacheTime.set(gamePk, now);
      return null;
    }
    _lineupCache.set(gamePk, set);
    _lineupCacheTime.set(gamePk, now);
    return set;
  } catch {
    _lineupCache.set(gamePk, null);
    _lineupCacheTime.set(gamePk, now);
    return null;
  }
}

// Returns: "in_lineup" | "not_in_lineup" | "lineup_unknown"
// "lineup_unknown" → caller proceeds (avoid false-block when lineups
// haven't been published yet).
async function checkBatterInLineup(playerName: string, gamePk: number): Promise<"in_lineup" | "not_in_lineup" | "lineup_unknown"> {
  const lineupSet = await fetchLineupForGame(gamePk);
  if (lineupSet === null) return "lineup_unknown";
  return lineupSet.has(normalizeName(playerName)) ? "in_lineup" : "not_in_lineup";
}

// D-302 SHIP 2 — active 26-man roster preload + check.
//
// Defensive gate: blocks prop generation for players NOT on any team's
// active 26-man roster (catches IL/optioned/DFA cases even when lineup
// data is "lineup_unknown" state).
//
// Single Set<string> of normalized names — O(1) lookup per prop. Built
// once at run start from MLB Stats API roster endpoints (30 teams,
// concurrent). Cardinal §1.5 reuse: same normalizeName() as existing
// checkBatterInLineup so name matching is consistent.
//
// On MLB Stats API failure: graceful degradation — return null and
// caller skips the gate (preserves existing behavior, doesn't block
// all picks if API is down).
let _activeRosterCache: Set<string> | null = null;
async function preloadActiveRosters(): Promise<Set<string> | null> {
  if (_activeRosterCache) return _activeRosterCache;
  const set = new Set<string>();
  let failed = 0;
  await Promise.all(MLB_TEAM_IDS.map(async (tid) => {
    try {
      const r = await quietFetch(`${MLB_STATS_BASE}/teams/${tid}/roster?rosterType=active`, 10_000);
      if (!r.ok) { failed++; return; }
      const j = JSON.parse(r.text);
      for (const p of (j.roster ?? [])) {
        const name = p?.person?.fullName;
        if (name) set.add(normalizeName(name));
      }
    } catch { failed++; }
  }));
  // Require majority of teams to succeed; else assume API issue and
  // disable the gate (graceful degrade per Esc Rule #4).
  if (failed > 5) {
    console.log(`[d302-active-roster] ${failed}/30 teams failed roster fetch; gate DISABLED for this run`);
    return null;
  }
  _activeRosterCache = set;
  return set;
}

// D-285 SHIP 1 — starting lineup player IDs per side from boxscore.
// Returns home + away starting batters' MLB IDs (battingOrder X00).
// Cached per gamePk with LINEUP_TTL_MS. Used by lineup_vs_hand
// preload aggregator.
// D-286 SHIP 1 — added projected-lineup fallback via
// fetchLatestLineupForTeam (uses most recent completed game's lineup).
const _lineupIdsCache = new Map<number, { home: number[]; away: number[] }>();
const _lineupIdsCacheTime = new Map<number, number>();
const _projectedLineupCache = new Map<number, number[]>();  // team_id → lineup batter IDs from most recent game
async function fetchLineupIdsForGame(gamePk: number): Promise<{ home: number[]; away: number[] }> {
  const now = Date.now();
  const cachedAt = _lineupIdsCacheTime.get(gamePk);
  if (cachedAt && (now - cachedAt) < LINEUP_TTL_MS) {
    return _lineupIdsCache.get(gamePk) ?? { home: [], away: [] };
  }
  const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/game/${gamePk}/boxscore`);
  if (!ok) {
    const empty = { home: [], away: [] };
    _lineupIdsCache.set(gamePk, empty);
    _lineupIdsCacheTime.set(gamePk, now);
    return empty;
  }
  try {
    const d = JSON.parse(text) as {
      teams?: {
        home?: { players?: Record<string, { person?: { id?: number }; battingOrder?: string }> };
        away?: { players?: Record<string, { person?: { id?: number }; battingOrder?: string }> };
      };
    };
    const collectStarters = (side: "home" | "away"): number[] => {
      const players = d?.teams?.[side]?.players ?? {};
      const out: number[] = [];
      for (const pid of Object.keys(players)) {
        const p = players[pid];
        const order = p?.battingOrder ?? "";
        if (order.length === 3 && order.endsWith("00") && p?.person?.id) {
          out.push(p.person.id);
        }
      }
      return out;
    };
    const result = { home: collectStarters("home"), away: collectStarters("away") };
    _lineupIdsCache.set(gamePk, result);
    _lineupIdsCacheTime.set(gamePk, now);
    return result;
  } catch {
    const empty = { home: [], away: [] };
    _lineupIdsCache.set(gamePk, empty);
    _lineupIdsCacheTime.set(gamePk, now);
    return empty;
  }
}

// D-286 SHIP 1 — projected-lineup fallback. When today's boxscore
// hasn't posted a starting lineup yet, look up the team's most
// recent completed game and use its lineup as the projection.
// Optimized for the 150s IDLE_TIMEOUT budget: ONE schedule call
// (hydrate=team to identify home/away inline) + ONE boxscore call
// for the most recent Final/Live game. Returns [] if not found.
async function fetchLatestLineupForTeam(teamId: number): Promise<number[]> {
  if (_projectedLineupCache.has(teamId)) return _projectedLineupCache.get(teamId)!;
  const today = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  // ONE schedule call with hydrate=team so we can identify home/away without separate boxscore lookup
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${sevenDaysAgo}&endDate=${today}`;
  const { ok, text } = await quietFetch(url);
  if (!ok) { _projectedLineupCache.set(teamId, []); return []; }
  try {
    const d = JSON.parse(text) as {
      dates?: Array<{ games?: Array<{ gamePk?: number; status?: { abstractGameState?: string }; gameDate?: string; teams?: { home?: { team?: { id?: number } }; away?: { team?: { id?: number } } } }> }>;
    };
    // Flatten + filter to Final/Live games + identify which side this team was on
    const games: Array<{ gamePk: number; gameDate: string; isHome: boolean }> = [];
    for (const dt of d.dates ?? []) {
      for (const g of dt.games ?? []) {
        const state = g.status?.abstractGameState;
        if (!g.gamePk || !g.gameDate) continue;
        if (state !== "Final" && state !== "Live") continue;
        const isHome = g.teams?.home?.team?.id === teamId;
        const isAway = g.teams?.away?.team?.id === teamId;
        if (!isHome && !isAway) continue;
        games.push({ gamePk: g.gamePk, gameDate: g.gameDate, isHome });
      }
    }
    games.sort((a, b) => b.gameDate.localeCompare(a.gameDate));
    // ONE boxscore call: most recent game. If lineup empty there too, give up.
    if (games.length === 0) { _projectedLineupCache.set(teamId, []); return []; }
    const recent = games[0];
    const ids = await fetchLineupIdsForGame(recent.gamePk);
    const lineup = recent.isHome ? ids.home : ids.away;
    _projectedLineupCache.set(teamId, lineup);
    return lineup;
  } catch {
    _projectedLineupCache.set(teamId, []);
    return [];
  }
}

// D-283 SHIP 1 — game-day starting catcher resolver.
// Scans boxscore players for `position.abbreviation === "C"` AND
// `battingOrder` ending in "00" (starter). Fallback to any catcher
// in the roster if the lineup-locked starter isn't found. Returns
// MLBAMIDs for both home + away starting catchers.
const _catchersCache = new Map<number, { home_id: number | null; away_id: number | null }>();
const _catchersCacheTime = new Map<number, number>();
async function fetchStartingCatchersForGame(gamePk: number): Promise<{ home_id: number | null; away_id: number | null }> {
  const now = Date.now();
  const cachedAt = _catchersCacheTime.get(gamePk);
  if (cachedAt && (now - cachedAt) < LINEUP_TTL_MS) {
    return _catchersCache.get(gamePk) ?? { home_id: null, away_id: null };
  }
  const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/game/${gamePk}/boxscore`);
  if (!ok) {
    const empty = { home_id: null, away_id: null };
    _catchersCache.set(gamePk, empty);
    _catchersCacheTime.set(gamePk, now);
    return empty;
  }
  try {
    const d = JSON.parse(text) as {
      teams?: {
        home?: { players?: Record<string, { person?: { id?: number }; position?: { abbreviation?: string }; battingOrder?: string }> };
        away?: { players?: Record<string, { person?: { id?: number }; position?: { abbreviation?: string }; battingOrder?: string }> };
      };
    };
    const findCatcher = (side: "home" | "away"): number | null => {
      const players = d?.teams?.[side]?.players ?? {};
      // First pass: starting catcher (position C + battingOrder X00)
      for (const pid of Object.keys(players)) {
        const p = players[pid];
        if (p?.position?.abbreviation === "C" && (p?.battingOrder ?? "").endsWith("00")) {
          return p?.person?.id ?? null;
        }
      }
      // Fallback: any catcher in roster
      for (const pid of Object.keys(players)) {
        const p = players[pid];
        if (p?.position?.abbreviation === "C") {
          return p?.person?.id ?? null;
        }
      }
      return null;
    };
    const out = { home_id: findCatcher("home"), away_id: findCatcher("away") };
    _catchersCache.set(gamePk, out);
    _catchersCacheTime.set(gamePk, now);
    return out;
  } catch {
    const empty = { home_id: null, away_id: null };
    _catchersCache.set(gamePk, empty);
    _catchersCacheTime.set(gamePk, now);
    return empty;
  }
}

// ============================================================
// Cache readers (T3.0 tables)
// ============================================================

async function readTeamHitting(teamName: string): Promise<TeamHittingStats | null> {
  // D-669 SHIP 2 — also load Savant chase rate (team-aggregate oz_swing_percent)
  // in parallel with the team batting row.
  const url = `${SUPABASE_URL}/rest/v1/cache_team_batting_stats?team_name=eq.${encodeURIComponent(teamName)}&sport=eq.mlb&order=snapshot_date.desc&limit=1&select=*`;
  const chaseUrl = `${SUPABASE_URL}/rest/v1/cache_savant_team_chase?team_name=eq.${encodeURIComponent(teamName)}&order=snapshot_date.desc&limit=1&select=oz_swing_avg`;
  const [res, chaseRes] = await Promise.all([
    fetch(url, { headers: supaHeaders }),
    fetch(chaseUrl, { headers: supaHeaders }).catch(() => null),
  ]);
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const r = rows[0];
  let ozSwingAvg: number | null = null;
  if (chaseRes && chaseRes.ok) {
    try {
      const chaseRows = await chaseRes.json();
      if (Array.isArray(chaseRows) && chaseRows.length > 0 && chaseRows[0].oz_swing_avg != null) {
        ozSwingAvg = Number(chaseRows[0].oz_swing_avg);
      }
    } catch { /* graceful degrade */ }
  }
  return {
    gamesPlayed: Number(r.games_played) || 0,
    strikeOuts: Number(r.strikeouts) || 0,
    plateAppearances: Number(r.plate_appearances) || 0,
    kRate: Number(r.k_rate) || 0,
    kRateVsLHP: r.vs_lhp_k_rate !== null ? Number(r.vs_lhp_k_rate) : null,
    kRateVsRHP: r.vs_rhp_k_rate !== null ? Number(r.vs_rhp_k_rate) : null,
    // D-668 — opponent-patience / pitch-burden cols populated by extended writer.
    bbRate: r.bb_rate != null ? Number(r.bb_rate) : null,
    obpSeason: r.obp_season != null ? Number(r.obp_season) : null,
    pitchesPerPA: r.pitches_per_pa != null ? Number(r.pitches_per_pa) : null,
    // D-669 SHIP 2 — team-aggregate chase rate.
    ozSwingAvg,
  };
}

async function readTeamSeasonContext(teamName: string): Promise<TeamSeasonContext> {
  // Combine cache_team_batting_stats + cache_mlb_game_scoreboard for RPG / RAPG.
  // v1 uses simple league averages where data is missing.
  // D-283 SHIP 4: bullpen ERA/WHIP from cache_mlb_bullpen_stats.
  // D-334 SHIP 3: l10Runs/l10RunsAllowed from cache_mlb_historical_outcomes (mirrors
  //   historical_context_router's replay-path computation; was hardcoded null pre-D-334).
  const url = `${SUPABASE_URL}/rest/v1/cache_team_batting_stats?team_name=eq.${encodeURIComponent(teamName)}&sport=eq.mlb&order=snapshot_date.desc&limit=1&select=*`;
  const nowIso = new Date().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const bpUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_bullpen_stats?team_name=eq.${encodeURIComponent(teamName)}&snapshot_date=gte.${sevenDaysAgo}&order=snapshot_date.desc&limit=1&select=bullpen_era,bullpen_whip,bullpen_k_per_9,bullpen_baa`;
  const l10Url = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?or=(home_team.eq.${encodeURIComponent(teamName)},away_team.eq.${encodeURIComponent(teamName)})&commence_time=lt.${encodeURIComponent(nowIso)}&game_completed=eq.true&order=commence_time.desc&limit=10&select=home_team,home_score,away_score`;
  // D-653 — Baseball Savant team OAA. Most recent snapshot for this team.
  const oaaUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_team_oaa?full_team_name=eq.${encodeURIComponent(teamName)}&order=snapshot_date.desc&limit=1&select=oaa`;

  // D-664 — pen rest + bullpen high-leverage. Both keyed by team_name, daily snapshot.
  const penRestUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_pen_rest?team_name=eq.${encodeURIComponent(teamName)}&order=snapshot_date.desc&limit=1&select=pen_ip_48h`;
  const bobUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_bullpen_high_leverage?team_name=eq.${encodeURIComponent(teamName)}&order=snapshot_date.desc&limit=1&select=hl_avg_era`;

  const [battingRes, bpRes, l10Res, oaaRes, penRestRes, bobRes] = await Promise.all([
    fetch(url, { headers: supaHeaders }),
    fetch(bpUrl, { headers: supaHeaders }).catch(() => null),
    fetch(l10Url, { headers: supaHeaders }).catch(() => null),
    fetch(oaaUrl, { headers: supaHeaders }).catch(() => null),
    fetch(penRestUrl, { headers: supaHeaders }).catch(() => null),
    fetch(bobUrl, { headers: supaHeaders }).catch(() => null),
  ]);

  let rpg = 4.5, ra = 4.5, games = 0;
  // D-649 — team-level offense quality (ops_season + k_rate) pulled from
  // the same cache_team_batting_stats row. Both fields populate 30/30
  // teams per the 2026-06-21 audit. ops_l10 + vs_lhp/rhp_k_rate are NULL
  // on the snapshot so we don't use them.
  let opsSeason: number | null = null;
  let kRate: number | null = null;
  // D-664 — ISO/SLG from the SAME row (no extra HTTP).
  let isoSeason: number | null = null;
  let slgSeason: number | null = null;
  if (battingRes.ok) {
    const rows = await battingRes.json();
    if (Array.isArray(rows) && rows.length > 0) {
      const r = rows[0];
      games = Number(r.games_played) || 0;
      rpg = Number(r.runs_per_game) || 4.5;
      ra = r.runs_allowed_per_game != null ? Number(r.runs_allowed_per_game) : 4.5;
      opsSeason = r.ops_season != null ? Number(r.ops_season) : null;
      kRate = r.k_rate != null ? Number(r.k_rate) : null;
      isoSeason = r.iso_season != null ? Number(r.iso_season) : null;
      slgSeason = r.slg_season != null ? Number(r.slg_season) : null;
    }
  }

  let bullpenEra: number | null = null;
  let bullpenWhip: number | null = null;
  // D-652 — read additional bullpen quality dimensions for v3 rebuild.
  let bullpenKPer9: number | null = null;
  let bullpenBaa: number | null = null;
  if (bpRes && bpRes.ok) {
    try {
      const bpRows = await bpRes.json();
      if (Array.isArray(bpRows) && bpRows.length > 0) {
        bullpenEra = bpRows[0].bullpen_era !== null ? Number(bpRows[0].bullpen_era) : null;
        bullpenWhip = bpRows[0].bullpen_whip !== null ? Number(bpRows[0].bullpen_whip) : null;
        bullpenKPer9 = bpRows[0].bullpen_k_per_9 != null ? Number(bpRows[0].bullpen_k_per_9) : null;
        bullpenBaa = bpRows[0].bullpen_baa != null ? Number(bpRows[0].bullpen_baa) : null;
      }
    } catch { /* graceful degrade */ }
  }

  let l10Runs: number | null = null;
  let l10RunsAllowed: number | null = null;
  // D-663 — L10 margin distribution computed in the SAME loop. Zero extra HTTP.
  let l10AvgWinMargin: number | null = null;
  let l10BlowoutPct: number | null = null;
  if (l10Res && l10Res.ok) {
    try {
      const rows = await l10Res.json() as Array<{ home_team: string; home_score: number | null; away_score: number | null }>;
      if (Array.isArray(rows) && rows.length > 0) {
        let r = 0, ra2 = 0;
        let marginSum = 0;
        let blowoutCount = 0;
        let countedMargin = 0;
        for (const g of rows) {
          let myRuns = 0, oppRuns = 0;
          if (g.home_team === teamName) {
            myRuns = g.home_score ?? 0;
            oppRuns = g.away_score ?? 0;
          } else {
            myRuns = g.away_score ?? 0;
            oppRuns = g.home_score ?? 0;
          }
          r += myRuns;
          ra2 += oppRuns;
          // D-663 — only count games with non-null scores for the margin signal.
          if (g.home_score != null && g.away_score != null) {
            const margin = myRuns - oppRuns;
            marginSum += margin;
            if (margin >= 3) blowoutCount += 1;
            countedMargin += 1;
          }
        }
        l10Runs = r / rows.length;
        l10RunsAllowed = ra2 / rows.length;
        if (countedMargin > 0) {
          l10AvgWinMargin = marginSum / countedMargin;
          l10BlowoutPct = blowoutCount / countedMargin;
        }
      }
    } catch { /* graceful degrade */ }
  }

  // D-653 SHIP 2 — read real defense OAA from cache_mlb_team_oaa (Baseball Savant).
  let teamOAA: number | null = null;
  if (oaaRes && oaaRes.ok) {
    try {
      const oaaRows = await oaaRes.json();
      if (Array.isArray(oaaRows) && oaaRows.length > 0) {
        teamOAA = oaaRows[0].oaa != null ? Number(oaaRows[0].oaa) : null;
      }
    } catch { /* graceful degrade → v3 falls back to RAPG proxy */ }
  }

  // D-664 — bullpen rest + back-of-bullpen ERA from new daily caches.
  let penIp48h: number | null = null;
  let bobAvgEra: number | null = null;
  if (penRestRes && penRestRes.ok) {
    try {
      const prRows = await penRestRes.json();
      if (Array.isArray(prRows) && prRows.length > 0) {
        penIp48h = prRows[0].pen_ip_48h != null ? Number(prRows[0].pen_ip_48h) : null;
      }
    } catch { /* graceful degrade */ }
  }
  if (bobRes && bobRes.ok) {
    try {
      const bRows = await bobRes.json();
      if (Array.isArray(bRows) && bRows.length > 0) {
        bobAvgEra = bRows[0].hl_avg_era != null ? Number(bRows[0].hl_avg_era) : null;
      }
    } catch { /* graceful degrade */ }
  }
  return {
    name: teamName,
    gamesPlayed: games,
    runsPerGame: rpg,
    runsAllowedPerGame: ra,
    l10Runs,
    l10RunsAllowed,
    bullpenEra,
    bullpenWhip,
    // D-649 — team-level offense quality.
    opsSeason,
    kRate,
    // D-652 — additional bullpen dimensions for v3 rebuild.
    bullpenKPer9,
    bullpenBaa,
    // D-653 SHIP 2 — REAL defense via Baseball Savant team OAA.
    teamOAA,
    // D-663 — L10 run-margin distribution for blowout-tendency factor.
    l10AvgWinMargin,
    l10BlowoutPct,
    // D-664 — ISO / pen-rest / back-of-bullpen quality.
    isoSeason,
    slgSeason,
    bobAvgEra,
    penIp48h,
  };
}

async function readH2HRecent(home: string, away: string, beforeCommence: string): Promise<H2HRecent | null> {
  // D-334 SHIP 5 — h2h_recent live-path wiring.
  // Mirrors historical_context_router buildH2H (replay path). Two queries
  // ((home=X away=Y) and (home=Y away=X)), merge, sort desc, take top 10.
  // Returns null when n=0 (factor gate is >= 3 games anyway).
  const bcEnc = encodeURIComponent(beforeCommence);
  const url1 = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?home_team=eq.${encodeURIComponent(home)}&away_team=eq.${encodeURIComponent(away)}&commence_time=lt.${bcEnc}&game_completed=eq.true&order=commence_time.desc&limit=10&select=home_team,home_score,away_score,commence_time`;
  const url2 = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?home_team=eq.${encodeURIComponent(away)}&away_team=eq.${encodeURIComponent(home)}&commence_time=lt.${bcEnc}&game_completed=eq.true&order=commence_time.desc&limit=10&select=home_team,home_score,away_score,commence_time`;
  try {
    const [r1, r2] = await Promise.all([
      fetch(url1, { headers: supaHeaders }),
      fetch(url2, { headers: supaHeaders }),
    ]);
    if (!r1.ok || !r2.ok) return null;
    const [a1, a2] = await Promise.all([r1.json(), r2.json()]) as Array<Array<{ home_team: string; home_score: number | null; away_score: number | null; commence_time: string }>>;
    const rows = [...a1, ...a2].sort((p, q) => q.commence_time.localeCompare(p.commence_time)).slice(0, 10);
    if (rows.length === 0) return null;
    let totalRuns = 0;
    let homeWins = 0;
    for (const r of rows) {
      totalRuns += (r.home_score ?? 0) + (r.away_score ?? 0);
      const designatedIsHome = r.home_team === home;
      const designatedScore = designatedIsHome ? (r.home_score ?? 0) : (r.away_score ?? 0);
      const otherScore = designatedIsHome ? (r.away_score ?? 0) : (r.home_score ?? 0);
      if (designatedScore > otherScore) homeWins++;
    }
    return { l10Games: rows.length, runsPerGame: totalRuns / rows.length, homeTeamWinPct: homeWins / rows.length };
  } catch {
    return null;
  }
}

async function readBallparkFactor(parkName: string | null): Promise<BallparkFactor | null> {
  if (!parkName) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache_ballpark_factors?park_name=eq.${encodeURIComponent(parkName)}&select=*`, { headers: supaHeaders });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const r = rows[0];
  return { runsFactor: Number(r.runs_factor) || 1.0, hrFactor: Number(r.hr_factor) || 1.0, kFactor: Number(r.k_factor) || 1.0, hitsFactor: Number(r.hits_factor) || 1.0 };
}

async function readGameWeather(gameDate: string, homeTeam: string, awayTeam: string): Promise<{ weather: GameWeather | null; umpireName: string | null }> {
  const url = `${SUPABASE_URL}/rest/v1/cache_mlb_game_scoreboard?game_date=eq.${gameDate}&home_team=eq.${encodeURIComponent(homeTeam)}&away_team=eq.${encodeURIComponent(awayTeam)}&select=weather_temp_f,weather_wind_speed,weather_wind_dir,weather_wind_dir_deg,weather_condition,umpire_name&limit=1`;
  const res = await fetch(url, { headers: supaHeaders });
  if (!res.ok) return { weather: null, umpireName: null };
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return { weather: null, umpireName: null };
  const r = rows[0];
  return {
    weather: {
      tempF: r.weather_temp_f !== null ? Number(r.weather_temp_f) : null,
      windSpeed: r.weather_wind_speed !== null ? Number(r.weather_wind_speed) : null,
      windDir: r.weather_wind_dir ?? null,
      windDirDeg: r.weather_wind_dir_deg !== null ? Number(r.weather_wind_dir_deg) : null,
      condition: r.weather_condition ?? null,
    },
    umpireName: r.umpire_name ?? null,
  };
}

async function readUmpireStats(umpireName: string | null): Promise<UmpireStats | null> {
  if (!umpireName) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/cache_umpire_stats?umpire_name=eq.${encodeURIComponent(umpireName)}&order=snapshot_date.desc&limit=1&select=*`, { headers: supaHeaders });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const r = rows[0];
  return {
    calledStrikeRate: r.called_strike_rate !== null ? Number(r.called_strike_rate) : null,
    kZoneSizeIndex: r.k_zone_size_index !== null ? Number(r.k_zone_size_index) : null,
  };
}

// ============================================================
// Props readers
// ============================================================

async function loadMlbProps(gameDate: string, propTypeFilter?: string[]): Promise<PropRow[]> {
  // D-230 Fix 1 — paginated load with optional prop_type filter so we
  // can pull game-level markets in a tight query first (small batch,
  // <1K rows, finishes in 1 round-trip) and the larger player-prop
  // set in a separate paginated pass. Before this filter, the function
  // loaded all 21K MLB props in one pass and timed out before the
  // bucketize/score pipeline could write game-level picks.
  let url = `${SUPABASE_URL}/rest/v1/props_cache?sport=eq.mlb&game_date=eq.${gameDate}&select=game_date,event_id,player_name,prop_type,line,odds,bookmaker,pick_side,home_team,away_team,game_time`;
  if (propTypeFilter && propTypeFilter.length > 0) {
    url += `&prop_type=in.(${propTypeFilter.join(",")})`;
  }
  // D-232 Fix 2 — hard cap iteration count. If PostgREST's Range header
  // pagination misbehaves (returns 1000 rows every iteration despite
  // table being empty past offset N), the loop would otherwise run all
  // 50 iterations and consume ~50s before failing. Cap at 30 iterations
  // = 30K rows ceiling; log when hit so operators see the boundary case.
  const PAGE = 1000;
  const MAX_ITERATIONS = 30;
  const all: PropRow[] = [];
  let iterations = 0;
  for (let start = 0; start < MAX_ITERATIONS * PAGE; start += PAGE) {
    iterations++;
    if (iterations > MAX_ITERATIONS) {
      await logError("load-props", "pagination_cap", "loadMlbProps iteration cap hit", { game_date: gameDate, iterations, prop_type_filter: propTypeFilter, loaded_so_far: all.length });
      break;
    }
    const end = start + PAGE - 1;
    const res = await fetch(url, {
      headers: { ...supaHeaders, Range: `${start}-${end}`, "Range-Unit": "items" },
    });
    if (!res.ok) {
      await logError("load-props", "http_error", `${res.status}`, { game_date: gameDate, start, iterations });
      return all;
    }
    const rows = await res.json() as PropRow[];
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

// Bucketize props by MLB market.
// D-214 Fix 1 — keys with "pitcher_" prefix preserved by fetch-odds-mlb.
// "strikeouts" (without pitcher_ prefix) is batter strikeouts; we don't
// score it in v1, so route to "skip" rather than mis-routing to pitcher_k.
function classifyMarket(propType: string): string {
  const p = propType.toLowerCase();
  if (p === "pitcher_strikeouts" || p === "pitcher_k") return "pitcher_k";
  // D-476 — pitcher outs (recorded outs / 3 = IP). Routed to its own bucket;
  // shares PitcherKScoringContext with pitcher_k so dispatch wrapper hands
  // off to scorePitcherOuts via the market parameter.
  if (p === "pitcher_outs") return "pitcher_outs";
  if (p === "pitcher_record_a_win") return "skip_unsupported";
  // D-474 — batter strikeouts now scored via scoreBatterStrikeouts.
  // props_cache stores them as prop_type='strikeouts' (no pitcher_ prefix);
  // route to dedicated bucket. Previously skip_unsupported.
  if (p === "strikeouts" || p === "ks" || p === "k") return "batter_strikeouts";
  if (p === "hits" || p === "batter_hits" || p === "batter_total_hits") return "batter_hits";
  if (p.includes("home_run") || p === "hr") return "batter_hr";
  if (p.includes("total_bases") || p === "tb") return "batter_total_bases";
  if (p === "rbi" || p === "rbis" || p.includes("runs_batted_in")) return "batter_rbis";
  // D-475 — batter runs scored. props_cache stores as prop_type='runs_scored'
  // (no batter_ prefix, per The Odds API mapping).
  if (p === "runs_scored" || p === "runs" || p === "batter_runs_scored") return "batter_runs_scored";
  if (p === "h2h" || p === "moneyline" || p === "spreads" || p === "runline") return "game_side";
  if (p === "totals" || p === "total") return "game_total";
  return "unknown";
}

// ============================================================
// Writers
// ============================================================

async function writeRecommendationsCache(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  // D-253f: dry-run skip; count what WOULD be written; synthesize success.
  if (_dryRun) {
    _dryRunCounts.recommendations_cache++;
    return { ok: true };
  }
  // D-782b — Clear OPPOSITE pick_side row when STALE (older than 5 minutes).
  //
  // The on_conflict key below includes pick_side, so when the model flips
  // sides between runs (morning chose "under", evening chose "over"), the
  // upsert would write a NEW row instead of overwriting the old "under" row —
  // leaving stale opposite-side picks visible on the dashboard with prior
  // (possibly pre-calibration) confidence. D-782-pre observed this on 4
  // stale pitcher_outs rows; the sweep found 30 player+game groups across
  // markets with both pick_sides present.
  //
  // STALENESS GATE (5 min): batter markets legitimately write BOTH pick_sides
  // within ~1 second of each other in the SAME process-games-mlb run (each
  // batter's hits/HR/TB/RBIs/runs prop is scored over+under in adjacent loop
  // iterations). A naive DELETE-opposite would let the second write erase
  // the first, breaking legitimate dual-side picks. The 5-minute gate
  // preserves same-run pairs while still cleaning prior-run leftovers.
  //
  // Best-effort: failure doesn't block the upsert.
  const pickSide = payload.pick_side as string | undefined;
  const playerName = payload.player_name as string | undefined;
  const propType = payload.prop_type as string | undefined;
  const gameDate = payload.game_date as string | undefined;
  if (pickSide && playerName && propType && gameDate) {
    const oppositeSide = pickSide === "over" ? "under" : (pickSide === "under" ? "over" : null);
    if (oppositeSide) {
      // Cut-off: 5 minutes ago. DELETE only opposite-side rows older than this.
      const staleThresholdIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const delUrl = `${SUPABASE_URL}/rest/v1/recommendations_cache?` +
        `game_date=eq.${encodeURIComponent(gameDate)}` +
        `&player_name=eq.${encodeURIComponent(playerName)}` +
        `&prop_type=eq.${encodeURIComponent(propType)}` +
        `&pick_side=eq.${encodeURIComponent(oppositeSide)}` +
        `&created_at=lt.${encodeURIComponent(staleThresholdIso)}`;
      try {
        await fetch(delUrl, { method: "DELETE", headers: { ...supaHeaders, Prefer: "return=minimal" } });
      } catch { /* swallow — best effort */ }
    }
  }
  const url = `${SUPABASE_URL}/rest/v1/recommendations_cache?on_conflict=game_date,player_name,prop_type,pick_side`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...supaHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return { ok: false, error: `status=${res.status} ${(await res.text()).slice(0, 300)}` };
  return { ok: true };
}

// D-538 — hard-gate: refuse to write picks where the algorithm's own
// projection direction contradicts the pick_side. This supersedes D-467's
// conf-cap-at-69 (which leaked: D-536 §K found 62 batter_rbis disagree
// picks at conf>=70, max conf=100). Refusal is cleaner than capping.
//
// Rejection counts are tracked per market and logged at run-summary so
// the gate's volume impact is visible (not silent).
let _d538_gateRejections = 0;
const _d538_gateRejectionsByMarket: Record<string, number> = {};
function _d538_resetGateCounter(): void {
  _d538_gateRejections = 0;
  for (const k of Object.keys(_d538_gateRejectionsByMarket)) delete _d538_gateRejectionsByMarket[k];
}
function _d538_disagreesWithProjection(p: Record<string, unknown>): boolean {
  const proj = p.projected_stat;
  const line = p.line;
  const pickSide = p.pick_side;
  if (typeof proj !== "number" || typeof line !== "number" || typeof pickSide !== "string") return false;
  if (!Number.isFinite(proj) || !Number.isFinite(line)) return false;
  // Game-side / h2h picks (pickSide='home' / 'away') aren't sign-of-(proj−line) compatible
  // in the same way; the projection for game_side is a score differential, not a stat-vs-line.
  // Limit the gate to over/under markets where the proj-vs-line semantics are clean.
  if (pickSide !== "over" && pickSide !== "under") return false;
  if (pickSide === "over" && proj < line) return true;
  if (pickSide === "under" && proj > line) return true;
  return false;
}

async function writePickHistory(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; code?: "CLIENT_VALIDATION" | "RPC_FAILED" | "D538_GATED" }> {
  // D-538 hard-gate. Refuse to write if projection direction disagrees
  // with pick_side. Counter increments so the cron summary can report
  // how many picks were rejected this run.
  if (_d538_disagreesWithProjection(payload)) {
    _d538_gateRejections++;
    const market = (payload.mlb_market_type as string | undefined)
      ?? (payload.prop_type as string | undefined) ?? "unknown";
    _d538_gateRejectionsByMarket[market] = (_d538_gateRejectionsByMarket[market] ?? 0) + 1;
    return { ok: false, code: "D538_GATED", error: "projection direction disagrees with pick_side" };
  }
  // D-253f: dry-run skip; count what WOULD be written; synthesize success.
  if (_dryRun) {
    _dryRunCounts.pick_history++;
    return { ok: true };
  }
  // D-488 STAGE 3: delegate to the canonical helper. Validation now runs
  // BEFORE the RPC call (hour-0 catch for D-480-class CHECK constraint
  // mismatches). Output is byte-identical for the DB write — the helper
  // POSTs the same payload to the same upsert_pick_history RPC. The added
  // optional `code` field on the return type lets the caller distinguish
  // CLIENT_VALIDATION (validate rejected, RPC never called — alert via the
  // distinct error_type pattern) vs RPC_FAILED (Postgres rejected, existing
  // error_type='rpc_failed' so D-481 alerting is unchanged).
  const r = await canonicalWritePickHistory(payload as PickHistoryPayload, {
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
  });
  if (r.ok) return { ok: true };
  if (r.code === "CLIENT_VALIDATION") {
    return { ok: false, error: `validation: ${r.errors.join("; ")}`, code: "CLIENT_VALIDATION" };
  }
  return { ok: false, error: `status=${r.status} ${r.body.slice(0, 300)}`, code: "RPC_FAILED" };
}

// ============================================================
// Market handlers
// ============================================================

interface ScoredPick {
  market: string;
  player_name: string;
  team: string | null;
  opponent: string | null;
  confidence: number;
  verdict: string;
  ai_narrative: string;
  rec_payload: Record<string, unknown>;
  hist_payload: Record<string, unknown>;
}

// D-234 — per-pick incremental flush. Optional onBatchReady callback
// invoked every FLUSH_BATCH_SIZE picks so partial completion still
// lands rows before the 150s IDLE_TIMEOUT. Caller (main handler)
// passes flushBatch; scorer accumulates a pendingBatch + flushes
// in 25-pick increments. Caller also receives the full scored array
// for top_picks ranking — UPSERT-on-conflict makes the implicit
// double-flush a no-op.
type IncrementalFlush = (batch: ScoredPick[]) => Promise<void>;
const FLUSH_BATCH_SIZE = 25;

// D-238 — stale-first prioritization. Replaces D-236 Fisher-Yates
// shuffle. Random shuffle gave uniform coverage statistically but
// specific high-visibility players at the top of CEO's dashboard
// (sorted by game-time ascending) kept landing late in the shuffled
// order and aged out at 04:05 UTC even after D-236 ship.
//
// Strategy: pre-fetch every existing recommendations_cache row's
// created_at for today's MLB slate. Build a staleness Map keyed by
// (player_name|prop_type|pick_side) — matching the recs_cache UPSERT
// conflict tuple. Each scorer sorts its props array oldest-first;
// rows with no existing recs_cache entry sort first (treated as
// infinitely stale). Plain English: a stale pick ALWAYS gets re-
// scored before a fresh pick — every cron tick refreshes the
// oldest rows first, then drains forward.
// D-270-C2 — extended staleness entry: track Sonnet-needed status
// for conf>=70 rows that still hold the v1 MLB template.
// `ts` is the original created_at for stale-first ordering.
// `sonnetPending` flips true when ai_analysis contains "v1 MLB" and
// confidence >= SONNET_CONFIDENCE_GATE. sortStaleFirst boosts these
// to the front so the bucket budget always reaches them.
interface StalenessEntry {
  ts: string;
  sonnetPending: boolean;
}

async function loadStalenessMap(gameDate: string): Promise<Map<string, StalenessEntry>> {
  // D-238 critical correction: paginate via Range header. PostgREST's
  // implicit max-rows cap (~1000) silently truncated the first attempt,
  // dropping a chunk of recs_cache rows from the staleness lookup → those
  // players sorted as "fresh" (no map hit = STALE_SENTINEL = treated
  // staleest, BUT only relative to OTHER no-map-hit players; once the
  // first 1000 entered the map, the 5 CEO-target players landed in the
  // "infinitely stale" bucket alongside hundreds of others and the seen-
  // set short-circuit reached them after budget elapsed).
  // First pass missed acceptance criteria (3 of 4 FAIL). Pagination fix
  // below pulls ALL today's recs_cache rows.
  // D-270-C2: also select confidence + ai_analysis so we can detect
  // "Sonnet-still-pending" rows and boost them to the front.
  // D-620 — extended SELECT to include line + odds so we can also
  // populate the existing-pick cache for Sonnet-reuse gating in the
  // same pagination loop (no extra fetch). The line/odds are read
  // into _d620_existingPickCache below.
  const url = `${SUPABASE_URL}/rest/v1/recommendations_cache?sport=eq.mlb&game_date=eq.${gameDate}&select=player_name,prop_type,pick_side,line,odds,created_at,confidence,ai_analysis`;
  const PAGE = 1000;
  const m = new Map<string, StalenessEntry>();
  // D-620 — reset module-level pick cache and re-populate from this load.
  _d620_existingPickCache = new Map();
  _d620_sonnetReused = 0;
  _d620_sonnetCalled = 0;
  try {
    for (let start = 0; start < 50_000; start += PAGE) {
      const end = start + PAGE - 1;
      const res = await fetch(url, {
        headers: { ...supaHeaders, Range: `${start}-${end}`, "Range-Unit": "items" },
      });
      if (!res.ok) break;
      const rows = await res.json() as Array<{ player_name: string; prop_type: string; pick_side: string; line: number | null; odds: number | null; created_at: string; confidence: number | null; ai_analysis: string | null }>;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        const conf = r.confidence ?? 0;
        const ai = r.ai_analysis ?? "";
        // D-620 — populate existing-pick cache (skip rows missing line/odds
        // — these can't be signature-matched against a new pick anyway).
        if (r.line != null && r.odds != null && r.pick_side) {
          _d620_existingPickCache.set(`${r.player_name}|${r.prop_type}|${r.pick_side}`, {
            line: r.line, pick_side: r.pick_side, odds: r.odds, confidence: conf, ai_analysis: ai,
          });
        }
        // D-273-TEMPLATE: extended marker — both legacy "v1 MLB" rows
        // and new "Algorithm projection" fallback rows count as pending
        // for the Sonnet boost.
        const sonnetPending = conf >= 70 && (ai.indexOf("v1 MLB") >= 0 || ai.indexOf("Algorithm projection") >= 0);
        const primaryKey = `${r.player_name}|${r.prop_type}|${r.pick_side}`;
        m.set(primaryKey, { ts: r.created_at, sonnetPending });
        // D-270-C2 — game-market rows write player_name with a
        // "(side over)" / "(total under)" suffix at gameHistPayload-time,
        // but props_cache stores the bare "Home vs Away" form. Without
        // this aliased key, the staleness lookup misses for every game-
        // market prop → all sort as STALE_SENTINEL (=last) → the bucket
        // budget elapses before reaching the stale conf>=70 templates
        // that need Sonnet rewrites. Indexing under both forms lets
        // sortStaleFirst find existing rows under the props_cache key.
        const suffixMatch = r.player_name.match(/^(.+?)\s+\((?:side|total)\s+\w+\)$/);
        if (suffixMatch) {
          const stripped = suffixMatch[1];
          const aliasKey = `${stripped}|${r.prop_type}|${r.pick_side}`;
          // Aggregate: alias entry inherits sonnetPending if ANY
          // (side X) variant of this matchup needs Sonnet, and takes
          // the staleest created_at.
          const existing = m.get(aliasKey);
          if (!existing) {
            m.set(aliasKey, { ts: r.created_at, sonnetPending });
          } else {
            m.set(aliasKey, {
              ts: r.created_at < existing.ts ? r.created_at : existing.ts,
              sonnetPending: existing.sonnetPending || sonnetPending,
            });
          }
        }
      }
      if (rows.length < PAGE) break;
    }
  } catch { /* return whatever we have */ }
  return m;
}

// D-238 v2 — original implementation used "1900-01-01" sentinel so
// never-scored combos sorted FIRST (treated as infinitely stale).
// But today's slate has ~17% never-scored combos (~50 per market);
// they consumed the entire 25-50 pick-per-bucket budget, leaving
// CEO's visible-dashboard 04:05 UTC stale rows still un-refreshed.
// Fix: flip to FUTURE sentinel so missing-rows sort LAST. Existing
// stale rows (the ones subscribers actually see) get priority.
// Newly-discovered combos still get a chance — they're processed
// after existing rows but before fresh-scored ones, so over 2-3
// cron ticks every combo eventually scores.
const STALE_SENTINEL = "9999-12-31T23:59:59Z";

// D-382 SHIP 1 — bookmaker priority for deterministic primary-book selection.
// Mirrors fetch-odds-mlb's BOOKMAKER_PRIORITY at line 12. Used as a TIE-BREAK
// in sortStaleFirst (below) within a single (player, prop_type, pick_side)
// dedup bucket, where all rows have equal sonnet/staleness keys. The first-
// iterated row wins the dedup; with HR-first tie-break, Hard Rock's line/odds
// become the primary deterministically. Resolution is unchanged (resolve-picks
// reads stored line, not bookmaker; existing picks retain their stored line).
const BOOKMAKER_PRIORITY = ["hardrockbet", "hardrockbet_oh", "draftkings", "fanduel", "betmgm", "bovada", "pointsbet"];
function bookmakerRank(book: string | null | undefined): number {
  if (!book) return 999;
  const i = BOOKMAKER_PRIORITY.indexOf(book);
  return i === -1 ? 999 : i;
}

function sortStaleFirst(props: PropRow[], staleness: Map<string, StalenessEntry>): PropRow[] {
  return [...props].sort((a, b) => {
    const keyA = `${a.player_name}|${a.prop_type}|${a.pick_side}`;
    const keyB = `${b.player_name}|${b.prop_type}|${b.pick_side}`;
    const entryA = staleness.get(keyA);
    const entryB = staleness.get(keyB);
    // D-270-C2 — Sonnet-pending rows (conf>=70 with v1 MLB template
    // ai_analysis) sort BEFORE all other rows. UPSERT with merge-
    // duplicates preserves the original created_at, so stale-first
    // ordering alone never converges on a fixed set of rows. By
    // prioritizing template-still rows we ensure every cron tick
    // chips away at the C2 backlog until exhausted.
    const sonnetA = entryA?.sonnetPending ? 0 : 1;
    const sonnetB = entryB?.sonnetPending ? 0 : 1;
    if (sonnetA !== sonnetB) return sonnetA - sonnetB;
    const ageA = entryA?.ts ?? STALE_SENTINEL;
    const ageB = entryB?.ts ?? STALE_SENTINEL;
    const ageCmp = ageA.localeCompare(ageB);
    if (ageCmp !== 0) return ageCmp;
    // D-382 — within a single (player, prop_type, pick_side) bucket all
    // sonnet/age keys are equal; tie-break by bookmaker priority so
    // Hard Rock wins the "first prop seen" dedup deterministically.
    // Outside the same dedup bucket, this branch is never reached
    // (different keys → different staleness entries → ageCmp != 0).
    return bookmakerRank(a.bookmaker) - bookmakerRank(b.bookmaker);
  });
}

async function scorePitcherKMarket(
  props: PropRow[],
  games: ScheduledGame[],
  caches: SharedCaches,
  season: number,
  onBatchReady?: IncrementalFlush,
  deadline?: number,
  staleness?: Map<string, StalenessEntry>,
  market: "pitcher_k" | "pitcher_outs" = "pitcher_k",  // D-476 — market switch
): Promise<ScoredPick[]> {
  const pitcherById = new Map<number, { game: ScheduledGame; isHome: boolean }>();
  const pitcherByName = new Map<string, { id: number; game: ScheduledGame; isHome: boolean }>();
  for (const g of games) {
    if (g.homeProbableId) pitcherById.set(g.homeProbableId, { game: g, isHome: true });
    if (g.awayProbableId) pitcherById.set(g.awayProbableId, { game: g, isHome: false });
  }
  // We need name → id mapping for the props. Use /people fetches lazily.
  const seen = new Set<string>();
  const scored: ScoredPick[] = [];
  const pendingBatch: ScoredPick[] = [];
  // D-238 — stale-first ordering replaces D-236 shuffle. Existing
  // recs_cache rows for today are mapped by (player|prop_type|pick_side);
  // props sort oldest-first (and null=infinitely-stale-first). The
  // staleest row gets re-scored every cron tick before the bucket
  // deadline cuts off, so high-visibility dashboard players stop
  // aging out at 04:05 UTC.
  // D-382 — always sort via sortStaleFirst so the HR-first bookmaker tie-break
  // applies even when no staleness map is provided. Empty map → all entries
  // get STALE_SENTINEL → sonnet/age compare equal → tie-break fires.
  const orderedProps = sortStaleFirst(props, staleness ?? new Map());
  // D-381 SHIP 2 — pre-build lookup map keyed by (normalized player, side)
  // matching the dedup key at line 1201. Same-line filter happens at
  // buildAvailableBooks so primary's line drives which alternates are attached.
  const propsByDedupKey = new Map<string, PropRow[]>();
  for (const p of orderedProps) {
    const k = `${normalizeName(p.player_name)}|${p.pick_side}`;
    if (!propsByDedupKey.has(k)) propsByDedupKey.set(k, []);
    propsByDedupKey.get(k)!.push(p);
  }

  // D-302 SHIP 1 — two-phase refactor mirroring D-290 game_level pattern.
  // Phase A: serial scoring (no Sonnet) — fast, gathers candidates.
  // Phase B: concurrentMap candidates with concurrency=6 — Sonnet in parallel.
  // Pre-D-302: N pitcher_k × ~1.5s Sonnet wait = serial bottleneck.
  // Post-D-302: ceil(N/6) × 1.5s parallel.
  interface PkCandidate {
    prop: PropRow;
    game: ScheduledGame;
    isHome: boolean;
    myTeamName: string;
    oppTeamName: string;
    // deno-lint-ignore no-explicit-any
    result: any;
    templateNarrative: string;
    scoringCtx?: any;
  }
  const candidates: PkCandidate[] = [];

  // D-302 SHIP 2 — active-roster gate (defensive).
  const activeRoster = _activeRosterCache;

  for (const prop of orderedProps) {
    // D-235 — bucket deadline check. Break early so next cron tick
    // advances + other markets still get budget this tick.
    if (deadline !== undefined && Date.now() > deadline) break;
    const key = `${normalizeName(prop.player_name)}|${prop.pick_side}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // D-302 SHIP 2 — active-roster check. Cheap O(1) Set lookup.
    if (activeRoster && !activeRoster.has(normalizeName(prop.player_name))) {
      console.log(`[d302-active-roster] pitcher_not_on_active_26 player="${prop.player_name}" game_date=${prop.game_date}`);
      continue;
    }

    // Resolve player ID
    const pid = await caches.resolvePlayerId(prop.player_name);
    if (!pid) continue;
    const pitcherCtx = pitcherById.get(pid);
    if (!pitcherCtx) continue;  // not in today's probables

    const { game, isHome } = pitcherCtx;
    const seasonStats = await caches.pitcherSeason(pid, season);
    if (!seasonStats || seasonStats.gamesPlayed === 0) continue;
    const gameLog = await caches.pitcherGameLog(pid, season);
    const oppTeamName = isHome ? game.awayTeam : game.homeTeam;
    const myTeamName  = isHome ? game.homeTeam : game.awayTeam;
    const oppHitting = await caches.teamHitting(oppTeamName);
    const ballpark = await caches.ballpark(game.venue);
    const sb = await caches.scoreboard(prop.game_date, prop.home_team, prop.away_team);
    const umpire = await caches.umpire(sb.umpireName);

    // D-276-FACTORS: fetch pitcher Statcast (xERA) for new factor.
    // Returns null when cache miss → factor scores 0 (graceful degrade).
    const pitcherSc = await getPitcherStatcast(pid);
    // D-283 SHIP 1: resolve pitcher's own team game-day starting
    // catcher via boxscore + look up that catcher's framing rv_tot.
    const teamCf = await caches.catcherFramingForGame(game.gamePk, isHome);
    // D-286 SHIP 2: pitcher arsenal lookup (synchronous, pre-loaded)
    const pitcherArs = caches.pitcherArsenal(pid);
    // D-349: pitcher primary FB velocity (pre-loaded)
    const pitcherVelo = caches.pitcherPrimaryFbVelo(pid);
    // D-354: position-weighted opposing-lineup K rate (live boxscore fetch + per-batter season K).
    const lineupKComp = await caches.lineupKComposition(game.gamePk, isHome);
    // D-596: pitch-type matchup aggregates (synchronous, pre-loaded)
    const pitcherPtm = caches.pitchTypeMatchup(pid);
    // D-668 — pitcher_outs durability + game-script signals (gracefully degrade to null on miss):
    //   ownTeamPenIp48h: D-664 cache_mlb_pen_rest for the pitcher's own team (pen-rest → manager hook)
    //   ownTeamRunsPerGame + oppRunsPerGame: cache_team_batting_stats (RPG gap → blowout-pull risk)
    // D-669 SHIP 1 — first-inning trouble: cache_mlb_pitcher_inn1 (sitCodes=i01 per-inning splits).
    let ownPen48h: number | null = null;
    let ownRpg: number | null = null;
    let oppRpgD668: number | null = null;
    let inn1Era: number | null = null;
    let inn1Ip: number | null = null;
    let inn1Walks: number | null = null;
    // D-761 — 3rd-time-through-order signal (early-hook predictor for pitcher_outs unders).
    let thirdTimeOps: number | null = null;
    let thirdTimeIp:  number | null = null;
    // D-763 — REAL manager-hook signal (cache_mlb_team_manager_hook, closes
    // D-668-FOLLOWUP-PULL-FEED).
    let ownTeamHookIndex: number | null = null;
    try {
      const [ownPenRes, ownTeamRes, oppTeamRes, inn1Res, hookRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_pen_rest?team_name=eq.${encodeURIComponent(myTeamName)}&order=snapshot_date.desc&limit=1&select=pen_ip_48h`, { headers: supaHeaders }).catch(() => null),
        fetch(`${SUPABASE_URL}/rest/v1/cache_team_batting_stats?team_name=eq.${encodeURIComponent(myTeamName)}&sport=eq.mlb&order=snapshot_date.desc&limit=1&select=runs_per_game`, { headers: supaHeaders }).catch(() => null),
        fetch(`${SUPABASE_URL}/rest/v1/cache_team_batting_stats?team_name=eq.${encodeURIComponent(oppTeamName)}&sport=eq.mlb&order=snapshot_date.desc&limit=1&select=runs_per_game`, { headers: supaHeaders }).catch(() => null),
        fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_pitcher_inn1?player_id=eq.${pid}&order=snapshot_date.desc&limit=1&select=inn1_era,inn1_ip,inn1_walks,i06_ops,i06_ip`, { headers: supaHeaders }).catch(() => null),
        // D-763 — real manager-hook lookup keyed on team_name (matches the
        // myTeamName the scorer already has). Most-recent snapshot.
        fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_team_manager_hook?team_name=eq.${encodeURIComponent(myTeamName)}&order=snapshot_date.desc&limit=1&select=hook_index`, { headers: supaHeaders }).catch(() => null),
      ]);
      if (ownPenRes && ownPenRes.ok) {
        const rows = await ownPenRes.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0].pen_ip_48h != null) ownPen48h = Number(rows[0].pen_ip_48h);
      }
      if (ownTeamRes && ownTeamRes.ok) {
        const rows = await ownTeamRes.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0].runs_per_game != null) ownRpg = Number(rows[0].runs_per_game);
      }
      if (oppTeamRes && oppTeamRes.ok) {
        const rows = await oppTeamRes.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0].runs_per_game != null) oppRpgD668 = Number(rows[0].runs_per_game);
      }
      if (inn1Res && inn1Res.ok) {
        const rows = await inn1Res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          if (rows[0].inn1_era != null) inn1Era = Number(rows[0].inn1_era);
          if (rows[0].inn1_ip != null) inn1Ip = Number(rows[0].inn1_ip);
          if (rows[0].inn1_walks != null) inn1Walks = Number(rows[0].inn1_walks);
          // D-761 — 3rd-time-through-order
          if (rows[0].i06_ops != null) thirdTimeOps = Number(rows[0].i06_ops);
          if (rows[0].i06_ip != null) thirdTimeIp = Number(rows[0].i06_ip);
        }
      }
      // D-763 — real manager-hook
      if (hookRes && hookRes.ok) {
        const rows = await hookRes.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0].hook_index != null) {
          ownTeamHookIndex = Number(rows[0].hook_index);
        }
      }
    } catch { /* graceful degrade — factors return 0 when null */ }
    const scoringCtx = {
      pitcher: { fullName: prop.player_name, team: myTeamName, opponentTeam: oppTeamName, isHome, gameTime: game.gameTime },
      season: seasonStats, gameLog, opposingHitting: oppHitting,
      ballpark, weather: sb.weather, umpire,
      statcast: pitcherSc ? { xera: pitcherSc.xera, era_minus_xera_diff: pitcherSc.era_minus_xera_diff, est_ba: pitcherSc.est_ba } : null,
      catcherFraming: teamCf,
      arsenal: pitcherArs,
      velocity: pitcherVelo !== null ? { primary_fb_velo: pitcherVelo } : null,
      lineupKComposition: lineupKComp,
      pitchTypeMatchup: pitcherPtm,  // D-596
      // D-668 — game-situation signals for pitcher_outs scorer.
      ownTeamPenIp48h: ownPen48h,
      ownTeamRunsPerGame: ownRpg,
      oppRunsPerGame: oppRpgD668,
      // D-669 SHIP 1 — first-inning trouble signal for pitcher_outs.
      inn1Era,
      inn1Ip,
      inn1Walks,
      // D-761 — 3rd-time-through-order signal (pitcher_outs early-hook factor).
      thirdTimeOps,
      thirdTimeIp,
      // D-763 — REAL manager-hook signal (closes D-668-FOLLOWUP-PULL-FEED).
      ownTeamHookIndex,
      prop: { propType: prop.prop_type, line: prop.line, odds: prop.odds, pickSide: (prop.pick_side === "under" ? "under" : "over") as "over" | "under", bookmaker: prop.bookmaker },
    };
    // D-476 — switch on market. pitcher_k uses K-density scorer; pitcher_outs
    // uses depth-of-start scorer (avg-IP + manager-pull proxy).
    // D-534 — set active market BEFORE scoring so the scorer reads the
    // per-market weight set. With seeded-empty overrides this is byte-
    // identical to pre-D-534; overrides take effect once populated.
    setActiveMarket(market);
    const result = market === "pitcher_outs"
      ? scorePitcherOuts(scoringCtx)
      : scorePitcherStrikeouts(scoringCtx);

    // D-635 — line-movement v2 augmentation (pitcher markets). Same
    // helper as batter path; reads cache_odds_snapshots; source-agnostic.
    // Market key uses canonical D-634 vocabulary: pitcher_k / pitcher_outs.
    applyLineMovementV2(
      {
        event_id: String(prop.event_id ?? ""),
        market: market === "pitcher_outs" ? "pitcher_outs" : "pitcher_k",
        player_name: prop.player_name,
        prop_type: prop.prop_type,
        pick_side: prop.pick_side,
        bookmaker: prop.bookmaker,
      },
      result,
      _d635_lineMovementMap,
    );
    // D-636 — sharp-money signal (RLM proxy + steam). Weight 0.
    applySharpMoneyV2(
      {
        event_id: String(prop.event_id ?? ""),
        market: market === "pitcher_outs" ? "pitcher_outs" : "pitcher_k",
        player_name: prop.player_name,
        prop_type: prop.prop_type,
        pick_side: prop.pick_side,
      },
      result,
      _d636_sharpMoneyMap,
    );

    // D-273-TEMPLATE: template narrative for Sonnet fallback. Label flips with market.
    const statLabel = market === "pitcher_outs" ? "outs" : "K";
    const templateNarrative = `${prop.player_name} (${myTeamName}) vs ${oppTeamName}. Algorithm projection: ${result.projectedK}${statLabel} vs line ${prop.line} (${prop.pick_side}). Season ${result.seasonAvg}/start, last5 ${result.recentAvg}, edge ${result.edge}.`;

    // D-752 — thread scoringCtx through to Phase B. D-742 PART 3 added the
    // `scoring_inputs: scoringCtx` write in Phase B (line ~1866) but forgot
    // that scoringCtx was a Phase-A-only local. The unresolved reference
    // threw ReferenceError on every pick, swallowed silently by concurrentMap
    // → 0 pitcher_k + 0 pitcher_outs picks since 2026-06-25 04:05 UTC. The
    // CSW NaN cascade was a SECOND bug (D-749) layered on top; D-752 fixes
    // BOTH with the wiring change here + the loader entry in mlb_weights.ts.
    candidates.push({ prop, game, isHome, myTeamName, oppTeamName, result, templateNarrative, scoringCtx });
  }

  // Phase B — parallel Sonnet + payload + flush. Concurrency=6.
  await concurrentMap(candidates, async (c) => {
    const { prop, game, isHome, myTeamName, oppTeamName, result, templateNarrative, scoringCtx } = c;
    // D-620 — Sonnet gating. If existing rec_cache row already has a
    // non-template ai_analysis for the same (player, prop_type, pick_side,
    // line, odds-bucket, confidence-band), REUSE it instead of calling
    // Sonnet. Closes the D-616 SHIP 3.6 "regen on unchanged pick" leak.
    const reusable620 = d620MaybeReuseSonnet(prop.player_name, prop.prop_type, prop.pick_side, prop.line, prop.odds, result.confidence);
    let aiTextPk: string | null;
    if (reusable620 !== null) { aiTextPk = reusable620; }
    else {
      _d620_sonnetCalled++;
      aiTextPk = await getMlbPickCommentary({
        market,  // D-476 — "pitcher_k" or "pitcher_outs"
        playerName: prop.player_name, team: myTeamName, opponent: oppTeamName,
        isHome, propType: prop.prop_type, line: prop.line, pickSide: prop.pick_side, odds: prop.odds,
        confidence: result.confidence, verdict: result.verdict,
        projectedStat: result.projectedK, seasonAvg: result.seasonAvg, recentAvg: result.recentAvg, edge: result.edge,
        breakdown: result.breakdown as Record<string, number | string>,
      });
    }
    const aiNarrative = aiTextPk ?? templateNarrative;

    // D-560 — collect same-(player, prop_type) books then choose primary by
    // best-available same-line same-side price (Hard Rock kept within 5c).
    const availableBooks = buildAvailableBooks(
      propsByDedupKey.get(`${normalizeName(prop.player_name)}|${prop.pick_side}`) ?? [],
      prop.line,
      prop.pick_side,
    );
    const primary = selectBestSameLineBook(
      availableBooks, prop.line, prop.pick_side, prop.bookmaker, prop.odds,
    );
    const primaryOdds = primary?.odds ?? prop.odds;
    const primaryBook = primary?.bookmaker ?? prop.bookmaker;
    let marketWinRate = 0;
    let pitcherRecommendationShown = false;
    try {
      const gateMetrics = buildMarketGateMetrics(market, prop.pick_side);
      const variance = _marketMetrics.get(`${market}|${prop.pick_side}`)?.confidence_variance ?? null;
      marketWinRate = getCalibratedMarketWinRate(market, result.confidence, primaryOdds, null, variance);
      pitcherRecommendationShown = mlbRecommendationShown(market, prop.pick_side, marketWinRate, primaryOdds, prop.updated_at || new Date().toISOString(), gateMetrics);
    } catch(e) {
      pitcherRecommendationShown = false;
    }

    scored.push({
      market,  // D-476 — "pitcher_k" or "pitcher_outs"
      player_name: prop.player_name, team: myTeamName, opponent: oppTeamName,
      confidence: result.confidence, verdict: result.verdict, ai_narrative: aiNarrative,
      rec_payload: {
        game_date: prop.game_date, game_id: prop.event_id, game_time: game.gameTime,
        player_name: prop.player_name, team: myTeamName, opponent: oppTeamName, is_home: isHome,
        prop_type: prop.prop_type, line: prop.line, pick_side: prop.pick_side, odds: primaryOdds,
        confidence: result.confidence, verdict: result.verdict, ai_analysis: aiNarrative,
        season_avg: result.seasonAvg, recent_avg: result.recentAvg,
        floor_val: null, ceiling_val: null, breakdown: result.breakdown as Record<string, number | string>,
        bookmaker: primaryBook, sport: "mlb", projected_stat: result.projectedK,
        unbettable_juice_flag: result.unbettableJuiceFlag,
        unbettable_over_breakeven_flag: result.unbettableOverBreakevenFlag ?? false,
        coin_flip_flag: result.coinFlipFlag,
        negative_stacking_flag: result.negativeStackingFlag,
        negative_factor_count: result.negativeFactorCount,
        ...evRecCacheFields(result, pitcherRecommendationShown),
        // D-381 SHIP 2 — same-line multi-book odds for line shopping.
        available_books: availableBooks,
        hit_rates_display: {
          l5: result.breakdown.last5_hit_rate_pct != null ? `${result.breakdown.last5_hit_rate_pct}%` : "N/A",
          l10: result.breakdown.last10_hit_rate_pct != null ? `${result.breakdown.last10_hit_rate_pct}%` : "N/A",
          season: result.breakdown.season_hit_rate_pct != null ? `${result.breakdown.season_hit_rate_pct}%` : "N/A",
        },
      },
      hist_payload: {
        player_name: prop.player_name, team: myTeamName, opponent: oppTeamName,
        game_time: game.gameTime, game_date: prop.game_date, is_home: isHome,
        prop_type: prop.prop_type, line: prop.line, pick_side: prop.pick_side, odds: primaryOdds,
        season_avg: result.seasonAvg, recent_avg: result.recentAvg, projected_stat: result.projectedK,
        confidence: result.confidence, verdict: result.verdict,
        confidence_pre_cap: result.confidence_pre_cap,
        confidence_pre_tier_aware: result.confidence_pre_tier_aware,
        ai_analysis: aiNarrative, source: "process-games-mlb",
        recommendation_shown: pitcherRecommendationShown, is_synthetic: false, sport: "mlb",
        score_pitcher_k_rate: result.score_pitcher_k_rate, score_pitcher_form: result.score_pitcher_form,
        score_opposing_lineup_k: result.score_opposing_lineup_k,
        score_handedness_matchup: result.score_handedness_matchup,
        score_pitch_count_trend: result.score_pitch_count_trend,
        score_rest_pitcher: result.score_rest_pitcher,
        score_ballpark_factor: result.score_ballpark_factor,
        score_weather_wind: result.score_weather_wind, score_weather_temp: result.score_weather_temp,
        score_umpire_k_zone: result.score_umpire_k_zone,
        mlb_market_type: market, is_mlb_beta: true,  // D-476 — "pitcher_k" or "pitcher_outs"
        unbettable_juice_flag: result.unbettableJuiceFlag, coin_flip_flag: result.coinFlipFlag,
        negative_stacking_flag: result.negativeStackingFlag, negative_factor_count: result.negativeFactorCount,
        // D-379 SHIP 2 — persist full per-factor breakdown for the optimizer.
        breakdown: result.breakdown as Record<string, number | string>,
        // D-742 PART 3 — PERMANENT root fix for re-scoring parity.
        // Capture the FULL scoring context (every input that fed the scoring
        // function) at the exact moment of scoring. Re-scoring functions can
        // replay the formula from this snapshot and get 100% parity by
        // construction — no warehouse reconstruction, no MLB API re-fetch,
        // no temporal drift (D-740). Applies to every live pick from this
        // deploy forward; existing pre-D-742 picks fall back to historical
        // router reconstruction with the documented drift caveats.
        scoring_inputs: scoringCtx,
      },
    });
    pendingBatch.push(scored[scored.length - 1]);
    if (onBatchReady && pendingBatch.length >= FLUSH_BATCH_SIZE) {
      await onBatchReady(pendingBatch.splice(0, pendingBatch.length));
    }
  }, 3); // D-302 concurrency=3 — concurrency=6 hit WORKER_RESOURCE_LIMIT

  if (onBatchReady && pendingBatch.length > 0) {
    await onBatchReady(pendingBatch);
  }
  return scored;
}

function evRecCacheFields(
  result: {
    winProb?: number;
    edgeVsImplied?: number;
    evPerUnit?: number;
  },
  recommendationShown: boolean,
): Record<string, unknown> {
  return {
    recommendation_shown: recommendationShown,
    win_prob: result.winProb ?? null,
    edge_vs_implied: result.edgeVsImplied ?? null,
    ev_per_unit: result.evPerUnit ?? null,
  };
}

/** @deprecated Use mlbRecommendationShown */
function batterRecommendationShown(
  market: string,
  pickSide: string,
  result: BatterMarketResult,
): boolean {
  try {
    const wr = getCalibratedMarketWinRate(market, result.confidence, 1.9, null, null);
    return mlbRecommendationShown(market, pickSide, wr, 1.9, new Date().toISOString(), null);
  } catch(e) { return false; }
}

function batterHistPayload(prop: PropRow, batterTeam: string, opponentTeam: string, isHome: boolean, gameTime: string, result: BatterMarketResult, market: string, aiNarrative?: string, batterContactRate?: {
  whiff_percent: number;
  contact_percent: number | null;
  z_contact_percent: number | null;
  oz_contact_percent: number | null;
} | null): Record<string, unknown> {
  // D-273-TEMPLATE: removed "v1 MLB" version label. Same content, neutral framing.
  const defaultNarrative = `${prop.player_name} (${batterTeam}) vs ${opponentTeam}. Algorithm projection (${market}): ${result.projectedStat} vs line ${prop.line} (${prop.pick_side}). Season ${result.seasonAvg}, last10 ${result.recentAvg}, edge ${result.edge}.`;
  return {
    player_name: prop.player_name, team: batterTeam, opponent: opponentTeam,
    game_time: gameTime, game_date: prop.game_date, is_home: isHome,
    prop_type: prop.prop_type, line: prop.line, pick_side: prop.pick_side, odds: prop.odds,
    season_avg: result.seasonAvg, recent_avg: result.recentAvg, projected_stat: result.projectedStat,
    confidence: result.confidence, verdict: result.verdict,
    confidence_pre_cap: result.confidence_pre_cap,
    confidence_pre_tier_aware: result.confidence_pre_tier_aware,
    // D-229 Fix 4 — Sonnet narrative if available, template otherwise.
    ai_analysis: aiNarrative ?? defaultNarrative,
    source: "process-games-mlb", 
    recommendation_shown: (() => {
      try {
        const variance = _marketMetrics.get(`${market}|${prop.pick_side}`)?.confidence_variance ?? null;
        const gateMetrics = buildMarketGateMetrics(market, prop.pick_side);
        const wr = getCalibratedMarketWinRate(market, result.confidence, prop.odds, null, variance);
        return mlbRecommendationShown(market, prop.pick_side, wr, prop.odds, prop.updated_at || new Date().toISOString(), gateMetrics);
      } catch(e) { return false; }
    })(),
    is_synthetic: false, sport: "mlb",
    // batter factor columns (T3.2)
    score_batter_hit_rate: result.score_batter_hit_rate,
    score_batter_form: result.score_batter_form,
    score_opposing_pitcher_quality: result.score_opposing_pitcher_quality,
    score_recent_at_bats: result.score_recent_at_bats,
    score_handedness_matchup: result.score_handedness_matchup,
    score_ballpark_factor: result.score_ballpark_factor,
    score_weather_temp: result.score_weather_temp,
    score_lineup_consistency: result.score_lineup_consistency,
    // power factor columns (T3.4)
    score_batter_power_rate: result.score_batter_power_rate,
    score_batter_form_power: result.score_batter_form_power,
    score_pitcher_hr_rate: result.score_pitcher_hr_rate,
    score_weather_wind: result.score_weather_wind,
    // D-785 — top-level persistence of 10 factor columns previously stored
    // only in breakdown JSONB. D-783 audit found these NULL on top-level
    // for all batter picks (10/12 runs-specific factors invisible to the
    // optimizer reading dedicated columns). Schema + RPC extended in
    // D-785; payload now emits them so they actually persist.
    score_lineup_spot: result.score_lineup_spot,
    score_opp_pitcher_pitchtype_quality: result.score_opp_pitcher_pitchtype_quality,
    score_batter_obp: result.score_batter_obp,
    score_recent_run_form: result.score_recent_run_form,
    score_bullpen_quality: result.score_bullpen_quality,
    score_batter_xba: result.score_batter_xba,
    score_batter_exit_velo_trend: result.score_batter_exit_velo_trend,
    score_batter_barrel_rate: result.score_batter_barrel_rate,
    score_batter_xslg_regression: result.score_batter_xslg_regression,
    score_batter_vs_pitcher_hand_split: result.score_batter_vs_pitcher_hand_split,
    // D-797 — fix babip non-return + 4 new extra-base factors at top-level.
    score_batter_babip: result.score_batter_babip,
    score_batter_xwoba: result.score_batter_xwoba,
    score_batter_launch_angle: result.score_batter_launch_angle,
    score_batter_sweet_spot: result.score_batter_sweet_spot,
    score_batter_hard_hit: result.score_batter_hard_hit,
    // D-803 — pitcher hard-contact-allowed matchup factor at top-level.
    score_pitcher_hard_contact_allowed: result.score_pitcher_hard_contact_allowed,
    // D-807 — runs-only lineup protection + team offense factors at top-level.
    score_batter_lineup_protection: result.score_batter_lineup_protection,
    score_batter_team_offense: result.score_batter_team_offense,
    // D-808 — full-stack completion (6 new factor columns; lineup_consistency
    // already a column pre-D-808; launch_angle + sweet_spot already columns via D-797).
    score_pitcher_baa_vs_hand: result.score_pitcher_baa_vs_hand,
    score_hitter_streak_fatigue: result.score_hitter_streak_fatigue,
    score_day_after_night_fatigue: result.score_day_after_night_fatigue,
    score_travel_getaway: result.score_travel_getaway,
    score_batter_line_hit_rate: result.score_batter_line_hit_rate,
    score_batter_sprint_speed: result.score_batter_sprint_speed,
    // D-816 — PART 1 new HR-only factor (pull rate) + PART 3 3 columns
    // promoted from breakdown-only to top-level (gb_fb, hr_per_9, wind_dir_hr).
    // Reading from breakdown JSONB for the 3 promoted because they were
    // breakdown-only pre-D-816; result already exposes pull_rate at top-level.
    score_batter_pull_rate: result.score_batter_pull_rate,
    score_pitcher_gb_fb_rate: (result.breakdown && (result.breakdown as Record<string, unknown>).score_pitcher_gb_fb_rate) ?? null,
    score_pitcher_hr_per_9: (result.breakdown && (result.breakdown as Record<string, unknown>).score_pitcher_hr_per_9) ?? null,
    score_wind_direction_hr: (result.breakdown && (result.breakdown as Record<string, unknown>).score_wind_direction_hr) ?? null,
    // D-817 — pull × pull-side fence (HR-only directional amplifier).
    score_batter_pull_x_park_fence: result.score_batter_pull_x_park_fence,
    // D-824 — hits-only contact-rate / whiff-rate factor + 3 raw % columns
    // (batter_whiff_pct from cached row; batter_contact_pct / batter_z_contact_pct
    // captured for D-825 retune visibility).
    score_batter_contact_rate: result.score_batter_contact_rate,
    batter_whiff_pct: batterContactRate ? batterContactRate.whiff_percent : null,
    batter_contact_pct: batterContactRate ? batterContactRate.contact_percent : null,
    batter_z_contact_pct: batterContactRate ? batterContactRate.z_contact_percent : null,
    mlb_market_type: market, is_mlb_beta: true,
    unbettable_juice_flag: result.unbettableJuiceFlag,
    unbettable_over_breakeven_flag: result.unbettableOverBreakevenFlag,
    coin_flip_flag: result.coinFlipFlag,
    negative_stacking_flag: result.negativeStackingFlag, negative_factor_count: result.negativeFactorCount,
    // D-379 SHIP 2 — persist full per-factor breakdown for the optimizer.
    breakdown: result.breakdown as Record<string, number | string>,
  };
}

async function scoreBatterMarketProps(
  props: PropRow[],
  games: ScheduledGame[],
  caches: SharedCaches,
  season: number,
  market: "batter_hits" | "batter_hr" | "batter_total_bases" | "batter_rbis" | "batter_strikeouts" | "batter_runs_scored",
  onBatchReady?: IncrementalFlush,
  deadline?: number,
  staleness?: Map<string, StalenessEntry>,
): Promise<ScoredPick[]> {
  // map team → game so we can determine batter's game / opposing pitcher
  const gameByTeam = new Map<string, ScheduledGame>();
  for (const g of games) { gameByTeam.set(g.homeTeam, g); gameByTeam.set(g.awayTeam, g); }

  const scored: ScoredPick[] = [];
  const pendingBatch: ScoredPick[] = [];
  const seen = new Set<string>();
  // D-238 — stale-first ordering. Existing recs_cache row's created_at
  // (per (player|prop_type|pick_side)) drives the iteration order:
  // staleest pick first, missing rows treated as infinitely stale.
  // D-382 — always sort via sortStaleFirst so the HR-first bookmaker tie-break
  // applies even when no staleness map is provided. Empty map → all entries
  // get STALE_SENTINEL → sonnet/age compare equal → tie-break fires.
  const orderedProps = sortStaleFirst(props, staleness ?? new Map());
  // D-381 SHIP 2 — pre-build lookup map for batter market dedup key.
  const propsByDedupKey = new Map<string, PropRow[]>();
  for (const p of orderedProps) {
    const k = `${normalizeName(p.player_name)}|${p.pick_side}|${market}`;
    if (!propsByDedupKey.has(k)) propsByDedupKey.set(k, []);
    propsByDedupKey.get(k)!.push(p);
  }

  // D-302 SHIP 1 — two-phase refactor mirroring D-290 game_level pattern.
  // Phase A: serial scoring (no Sonnet) — fast, gathers candidates.
  // Phase B: concurrentMap candidates with concurrency=6 — Sonnet in parallel.
  interface BatCandidate {
    prop: PropRow;
    game: ScheduledGame;
    myTeam: string;
    oppTeam: string;
    isHome: boolean;
    // deno-lint-ignore no-explicit-any
    result: any;
    ctx?: any;
    batterContactRate?: any;
  }
  const candidates: BatCandidate[] = [];

  // D-302 SHIP 2 — active-roster gate (defensive). Block IL/optioned/DFA.
  // Null cache = MLB Stats API roster fetch failed; gate skipped (graceful).
  const activeRoster = _activeRosterCache;

  for (const prop of orderedProps) {
    // D-235 — bucket deadline check.
    if (deadline !== undefined && Date.now() > deadline) break;
    const key = `${normalizeName(prop.player_name)}|${prop.pick_side}|${market}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // D-302 SHIP 2 — active-roster check. Catches IL/optioned/DFA
    // BEFORE expensive scoring. checkBatterInLineup also gates later
    // but only when lineup is published; this catches the
    // "lineup_unknown" leak vector identified in D-299 follow-up.
    if (activeRoster && !activeRoster.has(normalizeName(prop.player_name))) {
      console.log(`[d302-active-roster] player_not_on_active_26 player="${prop.player_name}" market=${market} game_date=${prop.game_date}`);
      continue;
    }

    const pid = await caches.resolvePlayerId(prop.player_name);
    if (!pid) continue;
    const season_ = await caches.batterSeason(pid, season);
    if (!season_ || season_.gamesPlayed === 0) continue;

    // Determine team by matching home/away props
    const game = gameByTeam.get(prop.home_team) ?? gameByTeam.get(prop.away_team);
    if (!game) continue;

    // D-269 (2026-05-19): active-lineup gate. Block ghost picks BEFORE scoring.
    // Returns "lineup_unknown" if MLB hasn't published the lineup yet —
    // allow scoring in that case (pending lineup state, refresh sweeps will
    // clean up later). Returns "not_in_lineup" if batter is rostered but not
    // starting (Schwarber-class bug). Returns "in_lineup" → proceed.
    const lineupStatus = await checkBatterInLineup(prop.player_name, game.gamePk);
    if (lineupStatus === "not_in_lineup") {
      // D-269 telemetry — console.log only (per D-261 reframing, info-level
      // telemetry doesn't pollute error_log table). visible in supabase
      // functions logs for verification.
      console.log(`[d269] ghost_pick_filtered player="${prop.player_name}" gamePk=${game.gamePk} market=${market} game_date=${prop.game_date}`);
      continue;
    }
    // Without lineup data we approximate: if the batter's name probably belongs
    // to one team, score against the OTHER team's SP. Without a robust roster
    // lookup, we score against BOTH probable pitchers and pick the worse
    // confidence (conservative) — actually simpler: score vs the AWAY pitcher
    // when prop says home_team (batter's team is home), opp is away SP. v1
    // assumes the prop's team affiliation matches the bookmaker side. Most
    // bookmakers list batter props for their actual team. Default: try home
    // team first.
    // Simpler heuristic: query MLB Stats API team roster (cached in caches.roster) and
    // determine the batter's team.
    const teamForBatter = await caches.batterTeam(pid);
    let myTeam: string, oppTeam: string, isHome: boolean, oppPitcherId: number | null;
    if (teamForBatter && teamForBatter === game.homeTeam) {
      myTeam = game.homeTeam; oppTeam = game.awayTeam; isHome = true; oppPitcherId = game.awayProbableId;
    } else if (teamForBatter && teamForBatter === game.awayTeam) {
      myTeam = game.awayTeam; oppTeam = game.homeTeam; isHome = false; oppPitcherId = game.homeProbableId;
    } else {
      // D-270-C1 (2026-05-19) safety net: previously this branch silently
      // assigned myTeam = prop.home_team, which caused the Braves-as-Marlins
      // team swap when batterTeam() returned null (the pre-fix bug). Even
      // with the hydrate=currentTeam fix above, this branch can still hit
      // if (a) MLB Stats API /people lookup fails, or (b) returns a team
      // that doesn't match either game.homeTeam / game.awayTeam (cross-game
      // false positive — e.g. a Marlin in a Yankees/Red Sox prop slate).
      // We drop the pick rather than write a row with an un-validated team.
      // Per D-261 reframing: console.log telemetry only, not error_log.
      console.log(`[d270-c1] batter_team_unverified player="${prop.player_name}" pid=${pid} resolved_team="${teamForBatter ?? "null"}" game_home="${game.homeTeam}" game_away="${game.awayTeam}" market=${market} game_date=${prop.game_date} action=dropped`);
      continue;
    }

    const gameLog = await caches.batterGameLog(pid, season);
    const opposingPitcher = oppPitcherId ? await caches.pitcherOpposing(oppPitcherId, season) : null;
    const ballpark = await caches.ballpark(game.venue);
    const sb = await caches.scoreboard(prop.game_date, prop.home_team, prop.away_team);

    // D-276-FACTORS + D-278-FACTORS: fetch batter Statcast for all 4
    // batter markets (xBA applies to hits + TB + RBI; barrel/xSLG/exit-velo
    // apply to power markets only — gated in scoring_mlb.ts).
    // Pre-D-278: only fetched for power markets. Now fetched for all 4
    // markets so xBA factor can fire on hits picks too.
    const batterSc = await getBatterStatcast(pid);
    // D-282 SHIP 1 — fetch batter hand-splits (cache_mlb_batter_splits).
    // Gracefully degrades to null if cache miss; scoring fn handles null.
    const splits = await caches.batterSplits(pid);
    // D-283 SHIP 4 — fetch opposing team's bullpen aggregates.
    const oppBullpen = await caches.opposingBullpen(oppTeam);

    // D-347 — fetch 3 new factor inputs (lineup spot / day-after-night / travel) in parallel.
    // D-354 — also fetch consecutive starts streak (batter fatigue).
    // D-807 — also fetch lineup protection (next hitters behind OPS) + batter team context.
    // D-808 — also fetch batter sprint speed (Baseball Savant baserunning).
    // D-816 — also fetch batter pull rate (Baseball Savant batted-ball direction).
    const [lineupSpot, dayAfterNight, travelCtx, consecutiveStarts, nextHittersBehindOps, batterTeamCtx, batterSprintSpeed, batterPullRate, batterContactRate] = await Promise.all([
      caches.tonightLineupSpot(game.gamePk, pid),
      caches.dayAfterNightFatigue(myTeam, game.gameTime, pid),
      caches.travelContext(myTeam, prop.game_date, game.venue),
      caches.consecutiveStarts(pid, prop.game_date),
      caches.nextHittersBehindOps(game.gamePk, pid, season),
      caches.batterTeamContext(myTeam),
      caches.batterSprintSpeed(pid),
      caches.batterPullRate(pid),
      caches.batterContactRate(pid),    // D-824 — hits-only contact-rate / whiff-rate
    ]);

    // D-349 — opposing pitcher's splits vs L/R-handed batters (pre-loaded).
    const opposingPitcherSplits = oppPitcherId ? caches.pitcherSplits(oppPitcherId) : null;

    // D-598 — opposing pitcher's pitch-type arsenal aggregates (from
    // D-596 cache). Wired across ALL batter markets so the batter-side
    // matchup factor has data; D-598b will run per-market signal-gate +
    // harness verdict after 14d watch. opposingPitcherId stored too so
    // future retroactive audits / joins are possible without re-fetching
    // live probables (D-599 was blocked by this gap).
    const oppPtm = oppPitcherId ? caches.pitchTypeMatchup(oppPitcherId) : null;
    const opposingPitcherArsenal = oppPtm ? {
      expected_put_away: oppPtm.expected_put_away,
      expected_whiff_pct: oppPtm.expected_whiff_pct,
    } : null;

    const ctx = {
      batter: { fullName: prop.player_name, team: myTeam, opponentTeam: oppTeam, isHome, gameTime: game.gameTime, venue: game.venue },
      season: season_, gameLog, opposingPitcher,
      ballpark, weather: sb.weather,
      prop: { propType: prop.prop_type, line: prop.line, odds: prop.odds, pickSide: prop.pick_side === "under" ? "under" as const : "over" as const, bookmaker: prop.bookmaker },
      statcast: batterSc ? {
        est_ba: batterSc.est_ba,
        est_slg: batterSc.est_slg,
        est_slg_minus_slg_diff: batterSc.est_slg_minus_slg_diff,
        brl_pa: batterSc.brl_pa,
        brl_percent: batterSc.brl_percent,
        avg_hit_speed: batterSc.avg_hit_speed,
        // D-797 — closing D-796 gap: these were in batterSc but pre-D-797 the
        // context construction dropped them, hiding the strongest TB
        // predictors (xwOBA in particular) from the scorer.
        est_woba: batterSc.est_woba,
        est_woba_minus_woba_diff: batterSc.est_woba_minus_woba_diff,
        ev95percent: batterSc.ev95percent,
        avg_hit_angle: batterSc.avg_hit_angle,
        anglesweetspotpercent: batterSc.anglesweetspotpercent,
      } : null,
      splits: splits,  // D-282 SHIP 1
      opposingBullpen: oppBullpen,  // D-283 SHIP 4
      ballparkOrientation: game.venue ? caches.ballparkOrientation(game.venue) : null,  // D-287 SHIP 1
      // D-347 — 3 new batter factors
      lineupSpot,
      dayAfterNight,
      travelContext: travelCtx,
      // D-349 — opposing pitcher BAA vs this batter's handedness
      opposingPitcherSplits,
      // D-354 — consecutive starts (streak fatigue)
      consecutiveStarts,
      // D-598 — opposing pitcher pitch-type matchup (batter-side) + pid
      // stored forward for future audits / retroactive joins.
      opposingPitcherId: oppPitcherId ?? null,
      opposingPitcherArsenal,
      // D-807 — lineup protection (avg OPS next 2 behind) + batter team context.
      nextHittersBehindOps,
      batterTeamContext: batterTeamCtx ? { opsSeason: batterTeamCtx.opsSeason } : null,
      // D-808 — sprint speed (Baseball Savant baserunning).
      batterSprintSpeed,
      // D-816 — pull rate (Baseball Savant batted-ball direction). Pull-air
      // rate is the HR-prediction signal (pull-heavy fly-ball power profile).
      batterPullRate,
      // D-817 — park dimensions (LF/CF/RF distances). Pull × pull-side fence
      // interaction routes via batter handedness (lefty→RF, righty→LF, switch
      // via opp pitcher hand). Null on unknown venue → factor returns 0.
      parkDimensions: caches.parkDimensions(game.venue ?? null),
      // D-824 — batter contact-rate / whiff-rate (hits-only discriminator).
      // Whiff% is INVERSE: high whiff → fewer balls in play → favor UNDER.
      // Buckets in scorer fire only when marketStat === "hits".
      batterContactRate,
    };

    // D-534 — set active market BEFORE scoring so the scorer reads the
    // per-market weight set. Seeded-empty overrides → byte-identical.
    setActiveMarket(market);
    let result: BatterMarketResult;
    if (market === "batter_hits") result = scoreBatterHits(ctx);
    else if (market === "batter_hr") result = scoreBatterHomeRuns(ctx);
    else if (market === "batter_total_bases") result = scoreBatterTotalBases(ctx);
    else if (market === "batter_rbis") result = scoreBatterRbis(ctx);
    else if (market === "batter_strikeouts") result = scoreBatterStrikeouts(ctx);  // D-474 — Market 1
    else result = scoreBatterRunsScored(ctx);  // D-475 — Market 2 of SHIP 4 queue

    // D-635 — line-movement v2 augmentation. Adjusts confidence +
    // writes lm_* breakdown fields the UI reads. Source-agnostic
    // (reads the normalized D-634 snapshot table). Unvalidated until
    // D-549 harness measures r_residual — see framework §15 D-635.
    applyLineMovementV2(
      {
        event_id: String(prop.event_id ?? ""),
        market,
        player_name: prop.player_name,
        prop_type: prop.prop_type,
        pick_side: prop.pick_side,
        bookmaker: prop.bookmaker,
      },
      result,
      _d635_lineMovementMap,
    );
    // D-636 — sharp-money signal (batter markets). Weight 0.
    applySharpMoneyV2(
      {
        event_id: String(prop.event_id ?? ""),
        market,
        player_name: prop.player_name,
        prop_type: prop.prop_type,
        pick_side: prop.pick_side,
      },
      result,
      _d636_sharpMoneyMap,
    );

    // D-302 SHIP 1 — gather candidate; Sonnet moved to Phase B parallel.
    // D-756 — thread the batter scoring context (`ctx`) through to Phase B
    // so the hist_payload can persist scoring_inputs (parity-by-construction
    // re-scoring per D-742 PART 3, now extended from pitcher to batter
    // markets). The scope correctness pattern follows D-752: every var
    // referenced inside the concurrentMap callback must be threaded through
    // the candidate object, not a Phase-A-only local. ctx contains the
    // FULL input snapshot for all 28 batter factors.
    candidates.push({ prop, game, myTeam, oppTeam, isHome, result, ctx, batterContactRate });
  }

  // Phase B — parallel Sonnet + payload + flush. Concurrency=6.
  await concurrentMap(candidates, async (c) => {
    const { prop, game, myTeam, oppTeam, isHome, result, ctx, batterContactRate } = c;
    // D-620 — Sonnet gating (batter markets).
    const reusable620B = d620MaybeReuseSonnet(prop.player_name, prop.prop_type, prop.pick_side, prop.line, prop.odds, result.confidence);
    let sonnetText: string | null;
    if (reusable620B !== null) { sonnetText = reusable620B; }
    else {
      _d620_sonnetCalled++;
      sonnetText = await getMlbPickCommentary({
        market, playerName: prop.player_name, team: myTeam, opponent: oppTeam, isHome,
        propType: prop.prop_type, line: prop.line, pickSide: prop.pick_side, odds: prop.odds,
        confidence: result.confidence, verdict: result.verdict,
        projectedStat: result.projectedStat, seasonAvg: result.seasonAvg, recentAvg: result.recentAvg, edge: result.edge,
        breakdown: result.breakdown as Record<string, number | string>,
      });
    }

    const histPayload = batterHistPayload(prop, myTeam, oppTeam, isHome, game.gameTime, result, market, sonnetText ?? undefined, batterContactRate);
    // D-756 — PERMANENT root fix for batter re-scoring parity (D-742 PART 3
    // extended). Capture the FULL scoring context (every input that fed the
    // scoring function) at the exact moment of scoring. Re-scoring functions
    // can replay the formula from this snapshot and get 100% parity by
    // construction — no warehouse reconstruction, no MLB API re-fetch, no
    // temporal drift (D-740 class). Applies to every live batter pick from
    // this deploy forward; existing pre-D-756 batter picks fall back to
    // historical router reconstruction with the documented drift caveats.
    // The `ctx` value is threaded through `candidates` (D-752 scope-bug
    // pattern — must come from candidate destructure, not Phase A locals).
    histPayload.scoring_inputs = ctx;
    // D-560 — same-(player, prop_type) books + best-price primary selection.
    const availableBooks2 = buildAvailableBooks(
      propsByDedupKey.get(`${normalizeName(prop.player_name)}|${prop.pick_side}|${market}`) ?? [],
      prop.line,
      prop.pick_side,
    );
    const primary2 = selectBestSameLineBook(
      availableBooks2, prop.line, prop.pick_side, prop.bookmaker, prop.odds,
    );
    const primaryOdds2 = primary2?.odds ?? prop.odds;
    const primaryBook2 = primary2?.bookmaker ?? prop.bookmaker;
    // The histPayload above is built earlier in this code path — patch its
    // odds to match the chosen primary so pick_history records the obtainable
    // price too.
    histPayload.odds = primaryOdds2;
    let marketWinRate = 0;
    let recommendationShown = false;
    try {
      const variance = _marketMetrics.get(`${market}|${prop.pick_side}`)?.confidence_variance ?? null;
      const gateMetrics = buildMarketGateMetrics(market, prop.pick_side);
      marketWinRate = getCalibratedMarketWinRate(market, result.confidence, primaryOdds2, ctx, variance);
      recommendationShown = mlbRecommendationShown(market, prop.pick_side, marketWinRate, primaryOdds2, prop.updated_at || new Date().toISOString(), gateMetrics);
    } catch(e) {
      recommendationShown = false;
    }
    const recPayload = {
      game_date: prop.game_date, game_id: prop.event_id, game_time: game.gameTime,
      player_name: prop.player_name, team: myTeam, opponent: oppTeam, is_home: isHome,
      prop_type: prop.prop_type, line: prop.line, pick_side: prop.pick_side, odds: primaryOdds2,
      confidence: result.confidence, verdict: result.verdict, ai_analysis: histPayload.ai_analysis,
      season_avg: result.seasonAvg, recent_avg: result.recentAvg,
      floor_val: null, ceiling_val: null, breakdown: result.breakdown as Record<string, number | string>,
      bookmaker: primaryBook2, sport: "mlb", projected_stat: result.projectedStat,
      unbettable_juice_flag: result.unbettableJuiceFlag,
      unbettable_over_breakeven_flag: result.unbettableOverBreakevenFlag ?? false,
      coin_flip_flag: result.coinFlipFlag,
      negative_stacking_flag: result.negativeStackingFlag,
      negative_factor_count: result.negativeFactorCount,
      ...evRecCacheFields(result, recommendationShown),
      // D-381 SHIP 2 — same-line multi-book odds for line shopping.
      available_books: availableBooks2,
      hit_rates_display: {
        l5: result.breakdown.last5_hit_rate_pct != null ? `${result.breakdown.last5_hit_rate_pct}%` : "N/A",
        l10: result.breakdown.last10_hit_rate_pct != null ? `${result.breakdown.last10_hit_rate_pct}%` : "N/A",
        season: result.breakdown.season_hit_rate_pct != null ? `${result.breakdown.season_hit_rate_pct}%` : "N/A",
      },
    };
    scored.push({
      market, player_name: prop.player_name, team: myTeam, opponent: oppTeam,
      confidence: result.confidence, verdict: result.verdict, ai_narrative: String(histPayload.ai_analysis),
      rec_payload: recPayload, hist_payload: histPayload,
    });
    pendingBatch.push(scored[scored.length - 1]);
    if (onBatchReady && pendingBatch.length >= FLUSH_BATCH_SIZE) {
      await onBatchReady(pendingBatch.splice(0, pendingBatch.length));
    }
  }, 3); // D-302 concurrency=3 — concurrency=6 hit WORKER_RESOURCE_LIMIT

  if (onBatchReady && pendingBatch.length > 0) {
    await onBatchReady(pendingBatch);
  }
  return scored;
}

function gameHistPayload(prop: PropRow, game: ScheduledGame, result: GameMarketResult, market: "game_side" | "game_total"): Record<string, unknown> {
  return {
    player_name: market === "game_side"
      ? `${game.homeTeam} vs ${game.awayTeam} (side ${prop.pick_side})`
      : `${game.homeTeam} vs ${game.awayTeam} (total ${prop.pick_side})`,
    team: prop.pick_side === "home" || prop.pick_side === "over" ? game.homeTeam : game.awayTeam,
    opponent: prop.pick_side === "home" || prop.pick_side === "over" ? game.awayTeam : game.homeTeam,
    game_time: game.gameTime, game_date: prop.game_date, is_home: prop.pick_side === "home" || prop.pick_side === "over",
    prop_type: prop.prop_type, line: prop.line, pick_side: prop.pick_side, odds: prop.odds,
    season_avg: null, recent_avg: null,
    projected_stat: market === "game_total" ? result.projectedTotal : (result.projectedHomeRuns - result.projectedAwayRuns),
    confidence: result.confidence, verdict: result.verdict,
    confidence_pre_cap: result.confidence_pre_cap,
    confidence_pre_tier_aware: result.confidence_pre_tier_aware,
    // D-273-TEMPLATE: removed "v1 MLB" version label. Same content, neutral framing.
    ai_analysis: `${game.awayTeam} @ ${game.homeTeam}. Algorithm projection (${market}): home ${result.projectedHomeRuns} - away ${result.projectedAwayRuns} (total ${result.projectedTotal}) vs line ${prop.line} (${prop.pick_side}). Edge ${result.edge}.`,
    source: "process-games-mlb", 
    recommendation_shown: (() => {
      try {
        const variance = _marketMetrics.get(`${market}|${prop.pick_side}`)?.confidence_variance ?? null;
        const gateMetrics = buildMarketGateMetrics(market, prop.pick_side);
        const wr = getCalibratedMarketWinRate(market, result.confidence, prop.odds, null, variance);
        return mlbRecommendationShown(market, prop.pick_side, wr, prop.odds, prop.updated_at || new Date().toISOString(), gateMetrics);
      } catch(e) { return false; }
    })(),
    is_synthetic: false, sport: "mlb",
    score_offense_differential: result.score_offense_differential,
    score_pitching_matchup: result.score_pitching_matchup,
    score_bullpen_strength: result.score_bullpen_strength,
    score_recent_run_diff: result.score_recent_run_diff,
    score_h2h_recent: result.score_h2h_recent,
    score_team_form: result.score_team_form,
    score_ballpark_factor: result.score_ballpark_factor,
    score_weather_wind: result.score_weather_wind,
    score_weather_temp: result.score_weather_temp,
    score_umpire_k_zone: result.score_umpire_k_zone,
    mlb_market_type: market, is_mlb_beta: true,
    unbettable_juice_flag: result.unbettableJuiceFlag, coin_flip_flag: result.coinFlipFlag,
    negative_stacking_flag: result.negativeStackingFlag, negative_factor_count: result.negativeFactorCount,
    // D-379 SHIP 2 — persist full per-factor breakdown for the optimizer.
    breakdown: result.breakdown as Record<string, number | string>,
  };
}

async function scoreGameMarketProps(
  props: PropRow[],
  games: ScheduledGame[],
  caches: SharedCaches,
  season: number,
  market: "game_side" | "game_total",
  onBatchReady?: IncrementalFlush,
  deadline?: number,
  staleness?: Map<string, StalenessEntry>,
): Promise<ScoredPick[]> {
  // Group props by (home_team, away_team) since each game has 1-2 sides
  const scored: ScoredPick[] = [];
  const pendingBatch: ScoredPick[] = [];
  const seen = new Set<string>();
  const gameByKey = new Map<string, ScheduledGame>();
  for (const g of games) gameByKey.set(`${g.homeTeam}|${g.awayTeam}`, g);
  // D-238 — stale-first ordering.
  // D-382 — always sort via sortStaleFirst so the HR-first bookmaker tie-break
  // applies even when no staleness map is provided. Empty map → all entries
  // get STALE_SENTINEL → sonnet/age compare equal → tie-break fires.
  const orderedProps = sortStaleFirst(props, staleness ?? new Map());
  // D-381 SHIP 2 — pre-build lookup map for game-market dedup key.
  const propsByDedupKey = new Map<string, PropRow[]>();
  for (const p of orderedProps) {
    const k = `${p.home_team}|${p.away_team}|${p.pick_side}|${p.line}|${market}`;
    if (!propsByDedupKey.has(k)) propsByDedupKey.set(k, []);
    propsByDedupKey.get(k)!.push(p);
  }

  // D-290 SHIP 1 — two-phase refactor for Sonnet parallelism.
  // Phase A: iterate props sequentially, score sync, gather candidates
  //   (no Sonnet — fast, ~10ms per prop).
  // Phase B: concurrentMap candidates with concurrency=6 — Sonnet in
  //   parallel + payload build + flush.
  // Pre-D-290: 23 game_total picks × 1.5s Sonnet wait = 34.5s serial.
  // Post-D-290: ceil(23/6) × 1.5s = ~6s parallel.
  interface GameCandidate {
    prop: PropRow;
    game: ScheduledGame;
    result: GameMarketResult;
    histPayload: Record<string, unknown>;
    // D-756 — full scoring context snapshot threaded to Phase B for the
    // scoring_inputs capture (parity-by-construction re-scoring per D-742
    // PART 3, now extended from pitcher to game markets). Holds all 11
    // game-factor inputs.
    ctx: Record<string, unknown>;
  }
  const candidates: GameCandidate[] = [];

  for (const prop of orderedProps) {
    // D-235 — bucket deadline check. Break early if elapsed, letting
    // next cron tick pick up where we left off (UPSERT idempotency).
    if (deadline !== undefined && Date.now() > deadline) break;
    const k = `${prop.home_team}|${prop.away_team}|${prop.pick_side}|${prop.line}|${market}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const game = gameByKey.get(`${prop.home_team}|${prop.away_team}`);
    if (!game) continue;

    const homeTeam = await caches.teamSeason(game.homeTeam);
    const awayTeam = await caches.teamSeason(game.awayTeam);
    const homePitcher = game.homeProbableId ? await caches.pitcherOpposing(game.homeProbableId, season) : null;
    const awayPitcher = game.awayProbableId ? await caches.pitcherOpposing(game.awayProbableId, season) : null;
    const ballpark = await caches.ballpark(game.venue);
    const sb = await caches.scoreboard(prop.game_date, prop.home_team, prop.away_team);
    const umpire = await caches.umpire(sb.umpireName);

    // D-334 SHIP 5 — h2h_recent now populated from cache_mlb_historical_outcomes
    // (was hardcoded null pre-D-334).
    const h2h = await caches.h2hRecent(game.homeTeam, game.awayTeam, game.gameTime);

    // D-663 — team-level travel context for v3 spread travel-flatness factor.
    // Uses the existing D-347 travelContext accessor (team-keyed, memoized per
    // team+date). Two PostgREST calls max per game; downstream calls hit the
    // in-memory travelCache for same-team-same-date repeats across the slate.
    const [homeTravel, awayTravel] = await Promise.all([
      caches.travelContext(game.homeTeam, prop.game_date, game.venue),
      caches.travelContext(game.awayTeam, prop.game_date, game.venue),
    ]);

    const ctx = {
      game: { homeTeam: game.homeTeam, awayTeam: game.awayTeam, gameTime: game.gameTime, venue: game.venue },
      homeTeam, awayTeam, homePitcher, awayPitcher,
      ballpark, weather: sb.weather, umpire,
      h2h,
      prop: {
        propType: prop.prop_type, line: prop.line, odds: prop.odds,
        pickSide: (prop.pick_side as "over" | "under" | "home" | "away"),
        bookmaker: prop.bookmaker,
      },
      // D-285 SHIP 1 — pre-computed lineup-vs-hand OPS aggregate (in-memory)
      lineupVsHand: caches.lineupVsHand(game.gamePk),
      // D-663 — per-team travel context for v3 spread travel-flatness factor.
      gameTravel: { home: homeTravel, away: awayTravel },
    };

    // D-534 — set active market BEFORE scoring (per-market weights).
    setActiveMarket(market);
    const result = market === "game_side" ? scoreGameSide(ctx) : scoreGameTotal(ctx);
    // D-654 SHIP 1 — wire D-635 line_movement + D-636 sharp_money into the
    // game_side / game_total breakdown so the v3 forward-test harness has
    // lm_raw_score, rlm_raw_score, sharp_money_raw, steam_signal recorded.
    // Pre-D-654 these were always null on game-side picks (the v3 scorer
    // expected ctx.marketSignals but process-games-mlb never built it),
    // producing the silent-empty pattern D-654 SHIP 1 caught.
    applyLineMovementV2(
      {
        event_id: String(prop.event_id ?? ""),
        market: market === "game_side" ? "game_side" : "game_total",
        player_name: String(prop.player_name ?? ""),
        prop_type: prop.prop_type,
        pick_side: prop.pick_side,
        bookmaker: prop.bookmaker,
      },
      result,
      _d635_lineMovementMap,
    );
    applySharpMoneyV2(
      {
        event_id: String(prop.event_id ?? ""),
        market: market === "game_side" ? "game_side" : "game_total",
        player_name: String(prop.player_name ?? ""),
        prop_type: prop.prop_type,
        pick_side: prop.pick_side,
      },
      result,
      _d636_sharpMoneyMap,
    );
    const histPayload = gameHistPayload(prop, game, result, market);
    // D-756 — capture scoring_inputs at score time (D-742 PART 3 pattern
    // extended to game markets). Re-scoring replays the formula from this
    // snapshot → 100% parity by construction (no warehouse reconstruction,
    // no temporal drift). `ctx` here is the same object passed to
    // scoreGameSide/scoreGameTotal above, so the snapshot matches the
    // exact inputs the scorer saw.
    histPayload.scoring_inputs = ctx;
    candidates.push({ prop, game, result, histPayload, ctx });
  }

  // Phase B — parallel Sonnet + payload + flush. Concurrency=6 (well
  // under Anthropic tier limits; matches D-288 flushBatch pattern).
  await concurrentMap(candidates, async (c) => {
    const { prop, game, result, histPayload } = c;
    // D-756 — scoring_inputs was already attached to histPayload in Phase A
    // (gameHistPayload call site). Game Phase B doesn't need to thread `ctx`
    // because the snapshot is already inside histPayload by the time the
    // candidate is pushed.
    // D-270-C2 — Sonnet commentary for game-level markets (gated >=70
    // inside helper; sub-70 returns null → template fallback).
    // D-620 — Sonnet gating (game markets).
    const reusable620G = d620MaybeReuseSonnet(
      String(histPayload.player_name), prop.prop_type, prop.pick_side,
      prop.line, prop.odds, result.confidence,
    );
    let sonnetGameText: string | null;
    if (reusable620G !== null) { sonnetGameText = reusable620G; }
    else {
      _d620_sonnetCalled++;
      sonnetGameText = await getMlbPickCommentary({
        market,
        playerName: String(histPayload.player_name),
        team: histPayload.team as string | null,
        opponent: histPayload.opponent as string | null,
        isHome: histPayload.is_home === true,
        propType: prop.prop_type,
        line: prop.line,
        pickSide: prop.pick_side,
        odds: prop.odds,
        confidence: result.confidence,
        verdict: result.verdict,
        projectedStat: market === "game_total" ? result.projectedTotal : (result.projectedHomeRuns - result.projectedAwayRuns),
        seasonAvg: 0,
        recentAvg: 0,
        edge: result.edge,
        breakdown: result.breakdown as Record<string, number | string>,
      });
    }
    const finalAiAnalysis = sonnetGameText ?? String(histPayload.ai_analysis);
    histPayload.ai_analysis = finalAiAnalysis;

    // D-560 — same-(home, away) game books + best-price primary selection.
    const availableBooks3 = buildAvailableBooks(
      propsByDedupKey.get(`${prop.home_team}|${prop.away_team}|${prop.pick_side}|${prop.line}|${market}`) ?? [],
      prop.line,
      prop.pick_side,
    );
    const primary3 = selectBestSameLineBook(
      availableBooks3, prop.line, prop.pick_side, prop.bookmaker, prop.odds,
    );
    const primaryOdds3 = primary3?.odds ?? prop.odds;
    const primaryBook3 = primary3?.bookmaker ?? prop.bookmaker;
    histPayload.odds = primaryOdds3;
    const recPayload = {
      game_date: prop.game_date, game_id: prop.event_id, game_time: game.gameTime,
      player_name: histPayload.player_name, team: histPayload.team, opponent: histPayload.opponent,
      is_home: histPayload.is_home,
      prop_type: prop.prop_type, line: prop.line, pick_side: prop.pick_side, odds: primaryOdds3,
      confidence: result.confidence, verdict: result.verdict, ai_analysis: finalAiAnalysis,
      season_avg: null, recent_avg: null, floor_val: null, ceiling_val: null,
      breakdown: result.breakdown as Record<string, number | string>, bookmaker: primaryBook3, sport: "mlb",
      projected_stat: histPayload.projected_stat,
      // D-279 SHIP 1 (2026-05-21): write sanity flags to recommendations_cache.
      unbettable_juice_flag: result.unbettableJuiceFlag,
      coin_flip_flag: result.coinFlipFlag,
      negative_stacking_flag: result.negativeStackingFlag,
      negative_factor_count: result.negativeFactorCount,
      // D-381 SHIP 2 — same-line multi-book odds for line shopping.
      available_books: availableBooks3,
    };

    scored.push({
      market, player_name: String(histPayload.player_name),
      team: histPayload.team as string | null,
      opponent: histPayload.opponent as string | null,
      confidence: result.confidence, verdict: result.verdict, ai_narrative: finalAiAnalysis,
      rec_payload: recPayload, hist_payload: histPayload,
    });
    pendingBatch.push(scored[scored.length - 1]);
    if (onBatchReady && pendingBatch.length >= FLUSH_BATCH_SIZE) {
      await onBatchReady(pendingBatch.splice(0, pendingBatch.length));
    }
  }, 6);

  if (onBatchReady && pendingBatch.length > 0) {
    await onBatchReady(pendingBatch);
  }
  return scored;
}

// ============================================================
// Shared in-memory caches per cron tick
// ============================================================

interface SharedCaches {
  resolvePlayerId(name: string): Promise<number | null>;
  pitcherSeason(id: number, season: number): Promise<PitcherSeasonStats | null>;
  pitcherGameLog(id: number, season: number): Promise<PitcherGameLogEntry[]>;
  pitcherOpposing(id: number, season: number): Promise<OpposingPitcherContext | null>;
  batterSeason(id: number, season: number): Promise<BatterSeasonStats | null>;
  batterGameLog(id: number, season: number): Promise<BatterGameLogEntry[]>;
  batterTeam(id: number): Promise<string | null>;
  // D-282 SHIP 1 — hand-split accessor.
  batterSplits(id: number): Promise<{ vs_lhp_avg: number | null; vs_lhp_slg: number | null; vs_lhp_ops: number | null; vs_lhp_pa: number | null; vs_rhp_avg: number | null; vs_rhp_slg: number | null; vs_rhp_ops: number | null; vs_rhp_pa: number | null } | null>;
  // D-283 SHIP 1 — game-day catcher framing accessor. Looks up
  // pitcher's own team starting catcher via boxscore, returns that
  // catcher's framing rv_tot from cache_statcast_framing (Cat rows).
  catcherFramingForGame(gamePk: number, isHome: boolean): Promise<{ rv_tot: number | null; pitches: number | null } | null>;
  // D-283 SHIP 4 — opposing-team bullpen aggregates (most-recent
  // snapshot in last 7 days).
  opposingBullpen(teamName: string): Promise<{ bullpen_era: number | null; bullpen_whip: number | null; bullpen_ip: number | null } | null>;
  teamHitting(team: string): Promise<TeamHittingStats | null>;
  teamSeason(team: string): Promise<TeamSeasonContext>;
  // D-334 SHIP 5 — h2h_recent accessor. Keyed by (home|away|beforeCommence).
  h2hRecent(home: string, away: string, beforeCommence: string): Promise<H2HRecent | null>;
  ballpark(park: string | null): Promise<BallparkFactor | null>;
  scoreboard(gameDate: string, home: string, away: string): Promise<{ weather: GameWeather | null; umpireName: string | null }>;
  umpire(name: string | null): Promise<UmpireStats | null>;
  // D-284 SHIP 1 — bulk pre-loaders. Each performs ONE query that
  // populates the internal cache for all entities in the slate,
  // eliminating per-pick fetch overhead during the scoring loop.
  bulkLoadBullpens(): Promise<number>;
  bulkLoadBatterSplits(pids: number[]): Promise<number>;
  bulkLoadCatcherFraming(): Promise<number>;
  // D-286 SHIP 2 — bulk-load pitcher arsenal (most-recent per pid)
  // D-657 SHIP 1 — bulk loaders now require pitcher IDs to scope the query.
  // Pre-D-657 these pulled the entire cache_statcast_pitcher_arsenal /
  // cache_mlb_pitcher_splits tables every cron tick (~thousands of rows × 4
  // queries), pushing process-games-mlb past Supabase's edge-runtime memory
  // budget → WORKER_RESOURCE_LIMIT (status 546) every */5 tick.
  bulkLoadPitcherArsenal(pids?: number[]): Promise<number>;
  pitcherArsenal(pid: number): { breaking_ball_pct: number | null; offspeed_pct: number | null; total_pitches: number | null; csw_pct: number | null; total_pitches_csw: number | null } | null;
  // D-596 — bulk-load pitch-type matchup aggregates (most-recent per pid)
  bulkLoadPitchTypeMatchup(pids?: number[]): Promise<number>;
  pitchTypeMatchup(pid: number): { expected_whiff_pct: number | null; expected_k_pct: number | null; expected_put_away: number | null } | null;
  // D-349 — pitcher primary fastball velocity (max of ff_avg_speed, si_avg_speed). Bulk-loaded.
  bulkLoadPitcherVelocity(pids?: number[]): Promise<number>;
  pitcherPrimaryFbVelo(pid: number): number | null;
  // D-349 — pitcher splits vs L/R-handed batters. Bulk-loaded.
  bulkLoadPitcherSplits(pids?: number[]): Promise<number>;
  pitcherSplits(pid: number): { baa_vs_lhb: number | null; pa_vs_lhb: number | null; baa_vs_rhb: number | null; pa_vs_rhb: number | null } | null;
  // D-354 — consecutive games started for a batter (cache_mlb_boxscore_player_stats 14-day lookback).
  consecutiveStarts(playerId: number, todayDate: string): Promise<number | null>;
  // D-354 — opposing lineup K-rate composite for pitcher_strikeouts scoring.
  lineupKComposition(gamePk: number, pitcherIsHome: boolean): Promise<{ weighted_k_rate: number | null; batters_with_data: number } | null>;
  // D-287 SHIP 1 — bulk-load ballpark orientation reference
  bulkLoadBallparkOrientations(): Promise<number>;
  ballparkOrientation(venueName: string): { cf_compass_degrees: number; is_dome: boolean } | null;
  // D-817 — bulk-load park dimensions reference (30-row static table).
  bulkLoadParkDimensions(): Promise<number>;
  parkDimensions(venueName: string | null): { lf_distance: number; cf_distance: number; rf_distance: number } | null;
  // D-285 SHIP 1 — game-day lineup OPS-vs-hand accessor. Reads from
  // pre-computed map keyed by gamePk. Aggregator pre-runs at start of
  // run via preloadLineupVsHand (orchestrator below).
  // D-286 SHIP 1 — added home_source/away_source for transparency.
  lineupVsHand(gamePk: number): {
    home_vs_lhp_ops: number | null;
    home_vs_rhp_ops: number | null;
    away_vs_lhp_ops: number | null;
    away_vs_rhp_ops: number | null;
    home_lineup_pa: number;
    away_lineup_pa: number;
    home_source: "confirmed" | "projected" | "unavailable";
    away_source: "confirmed" | "projected" | "unavailable";
    // D-664 — lineup-depth (top3 vs bottom3 OPS averages, hand-blended).
    home_top3_ops: number | null;
    home_bottom3_ops: number | null;
    away_top3_ops: number | null;
    away_bottom3_ops: number | null;
  } | null;
  setLineupVsHand(gamePk: number, agg: {
    home_vs_lhp_ops: number | null;
    home_vs_rhp_ops: number | null;
    away_vs_lhp_ops: number | null;
    away_vs_rhp_ops: number | null;
    home_lineup_pa: number;
    away_lineup_pa: number;
    home_source: "confirmed" | "projected" | "unavailable";
    away_source: "confirmed" | "projected" | "unavailable";
    home_top3_ops: number | null;
    home_bottom3_ops: number | null;
    away_top3_ops: number | null;
    away_bottom3_ops: number | null;
  }): void;
  // D-285 SHIP 1 — exposed batterSplits map accessor for aggregator.
  getCachedBatterSplits(id: number): {
    vs_lhp_avg: number | null; vs_lhp_slg: number | null; vs_lhp_ops: number | null; vs_lhp_pa: number | null;
    vs_rhp_avg: number | null; vs_rhp_slg: number | null; vs_rhp_ops: number | null; vs_rhp_pa: number | null;
  } | null | undefined;
  // D-347 — 3 new batter factor accessors.
  // tonightLineupSpot: fetches /game/{gamePk}/boxscore once per gamePk; returns batter's 1-9 slot or null.
  tonightLineupSpot(gamePk: number, playerId: number): Promise<number | null>;
  // dayAfterNightFatigue: queries cache_mlb_historical_outcomes for team's prior game commence_time,
  // and cache_mlb_boxscore_player_stats to check player started that game. Returns true when
  // yesterday >=23:00 UTC + today <=19:00 UTC + player has batting_order_slot.
  dayAfterNightFatigue(teamName: string, todayCommenceTime: string, playerId: number): Promise<boolean>;
  // travelContext: distance + direction (EW/WE/null) since prior-day venue. null when no prior game.
  travelContext(teamName: string, todayGameDate: string, todayVenue: string | null): Promise<{ miles: number; direction: "EW" | "WE" | null } | null>;
  // D-807 — avg OPS of next 2 hitters batting behind in same-side lineup. POINT-IN-TIME forward read.
  nextHittersBehindOps(gamePk: number, playerId: number, season: number): Promise<number | null>;
  // D-807 — memoized batter team TeamSeasonContext (for opsSeason → score_batter_team_offense).
  batterTeamContext(teamName: string | null): Promise<TeamSeasonContext | null>;
  // D-808 — memoized batter sprint speed (cache_statcast_batters_sprint_speed).
  batterSprintSpeed(playerId: number): Promise<number | null>;
  // D-816 — memoized batter pull rate (cache_statcast_batters_pull_rate).
  batterPullRate(playerId: number): Promise<{ pull_rate: number; pull_air_rate: number | null } | null>;
  // D-824 — memoized batter contact rate (cache_statcast_batters_contact_rate).
  batterContactRate(playerId: number): Promise<{
    whiff_percent: number;
    contact_percent: number | null;
    z_contact_percent: number | null;
    oz_contact_percent: number | null;
  } | null>;
}

function buildCaches(): SharedCaches {
  const pidByName = new Map<string, number | null>();
  const pitcherSeasonCache = new Map<number, PitcherSeasonStats | null>();
  const pitcherLogCache = new Map<number, PitcherGameLogEntry[]>();
  const pitcherOppCache = new Map<number, OpposingPitcherContext | null>();
  const batterSeasonCache = new Map<number, BatterSeasonStats | null>();
  const batterLogCache = new Map<number, BatterGameLogEntry[]>();
  const batterTeamCache = new Map<number, string | null>();
  // D-282 SHIP 1 — batter splits per-pid cache.
  const batterSplitsCache = new Map<number, { vs_lhp_avg: number | null; vs_lhp_slg: number | null; vs_lhp_ops: number | null; vs_lhp_pa: number | null; vs_rhp_avg: number | null; vs_rhp_slg: number | null; vs_rhp_ops: number | null; vs_rhp_pa: number | null } | null>();
  // D-282 SHIP 2 — catcher framing cache (per-team starting catcher).
  // Keyed by team_id (since lineup lookup can resolve "today's catcher
  // for this team" → MLBAMID, then framing rv_tot). For v1 we key on
  // gamePk + isHome to avoid the lineup-fetch dependency; v2 (D-283)
  // wires real starting-catcher resolution.
  const catcherFramingCache = new Map<string, { rv_tot: number | null; pitches: number | null } | null>();
  // D-284 SHIP 1 — catcher framing keyed by catcher MLBAMID (bulk-loadable).
  const framingByPid = new Map<number, { rv_tot: number | null; pitches: number | null }>();
  let framingBulkLoaded = false;
  // D-283 SHIP 4 — opposing-team bullpen cache keyed by team name.
  const bullpenCache = new Map<string, { bullpen_era: number | null; bullpen_whip: number | null; bullpen_ip: number | null } | null>();
  // D-286 SHIP 2 — pitcher arsenal cache keyed by player_id.
  const pitcherArsenalCache = new Map<number, { breaking_ball_pct: number | null; offspeed_pct: number | null; total_pitches: number | null; csw_pct: number | null; total_pitches_csw: number | null }>();
  // D-596 — pitch-type matchup aggregates per pitcher (usage-weighted whiff/k/put_away).
  const pitchTypeMatchupCache = new Map<number, { expected_whiff_pct: number | null; expected_k_pct: number | null; expected_put_away: number | null }>();
  let pitchTypeMatchupBulkLoaded = false;
  // D-287 SHIP 1 — ballpark orientation cache keyed by venue_name.
  const ballparkOrientationCache = new Map<string, { cf_compass_degrees: number; is_dome: boolean }>();
  // D-349 — primary fastball velocity per pitcher (max of ff/si avg_speed). Most-recent snapshot.
  const pitcherVelocityCache = new Map<number, number | null>();
  let pitcherVelocityBulkLoaded = false;
  // D-349 — pitcher splits vs LHB/RHB. Most-recent snapshot per pid.
  const pitcherSplitsCache = new Map<number, { baa_vs_lhb: number | null; pa_vs_lhb: number | null; baa_vs_rhb: number | null; pa_vs_rhb: number | null } | null>();
  let pitcherSplitsBulkLoaded = false;
  // D-354 — consecutive-starts cache per (playerId|todayDate).
  const consecutiveStartsCache = new Map<string, number | null>();
  // D-354 — lineup K composition cache per (gamePk|isHome).
  const lineupKCompCache = new Map<string, { weighted_k_rate: number | null; batters_with_data: number } | null>();
  // D-285 SHIP 1 — lineup-vs-hand OPS aggregate keyed by gamePk.
  // D-286 SHIP 1 — added home_source/away_source ('confirmed' | 'projected' | 'unavailable').
  const lineupVsHandCache = new Map<number, {
    home_vs_lhp_ops: number | null; home_vs_rhp_ops: number | null;
    away_vs_lhp_ops: number | null; away_vs_rhp_ops: number | null;
    home_lineup_pa: number; away_lineup_pa: number;
    home_source: "confirmed" | "projected" | "unavailable";
    away_source: "confirmed" | "projected" | "unavailable";
    home_top3_ops: number | null; home_bottom3_ops: number | null;
    away_top3_ops: number | null; away_bottom3_ops: number | null;
  }>();
  const teamHitCache = new Map<string, TeamHittingStats | null>();
  const teamSeasonCache = new Map<string, TeamSeasonContext>();
  // D-334 SHIP 5 — h2h_recent cache keyed by (home|away|beforeCommence).
  const h2hCache = new Map<string, H2HRecent | null>();
  const parkCache = new Map<string, BallparkFactor | null>();
  const scoreboardCache = new Map<string, { weather: GameWeather | null; umpireName: string | null }>();
  const umpireCache = new Map<string, UmpireStats | null>();
  // D-347 — per-gamePk lineup spot map (player_id → 1-9 slot). Populated on first
  // tonightLineupSpot call per gamePk via /game/{pk}/boxscore.
  const lineupSpotCache = new Map<number, Map<number, number> | null>();
  // D-347 — yesterday-game lookup per team. Keyed by team_name+today_date.
  // Holds prior-game commence_time + the prior gamePk for batting_order_slot follow-up.
  const yesterdayGameCache = new Map<string, { commenceTime: string; gamePk: number; homeTeam: string; awayTeam: string } | null>();
  // D-347 — player-was-starter-yesterday lookup. Keyed by player_id+yesterday_gamePk.
  const playerStartedYesterdayCache = new Map<string, boolean>();
  // D-347 — travel context cache per team+gameDate.
  const travelCache = new Map<string, { miles: number; direction: "EW" | "WE" | null } | null>();
  // D-807 — side-aware lineup cache: per gamePk, map of slot→pid per side + pid→side.
  // Enables nextHittersBehindOps. Populated by buildSideAwareLineup on first call per gamePk.
  const lineupBySideCache = new Map<number, {
    homeSlotToPid: Map<number, number>;
    awaySlotToPid: Map<number, number>;
    pidToSide: Map<number, "home" | "away">;
  } | null>();
  // D-807 — per-team season-context cache (memoize readTeamSeasonContext for runs_scored).
  const teamCtxCache = new Map<string, TeamSeasonContext | null>();
  // D-808 — batter sprint speed (cache_statcast_batters_sprint_speed). Memoized per pid.
  const sprintSpeedCache = new Map<number, number | null>();
  // D-816 — batter pull rate (cache_statcast_batters_pull_rate). Memoized per pid.
  // Returns {pull_rate, pull_air_rate} — pull_air_rate is the dominant HR signal.
  const pullRateCache = new Map<number, { pull_rate: number; pull_air_rate: number | null } | null>();
  // D-824 — memoized contact-rate cache (per-pid). Cleared per-tick by caller.
  const contactRateCache = new Map<number, {
    whiff_percent: number;
    contact_percent: number | null;
    z_contact_percent: number | null;
    oz_contact_percent: number | null;
  } | null>();
  // D-817 — park dimensions (cache_mlb_park_dimensions). Bulk-loaded once,
  // 30-row static reference. Returns {lf_distance, cf_distance, rf_distance}
  // per venue_name. Powers handedness-aware pull × pull-side fence factor.
  const parkDimensionsByVenue = new Map<string, { lf_distance: number; cf_distance: number; rf_distance: number } | null>();
  let parkDimensionsLoaded = false;
  // D-812 — projected-lineup fallback. When tonight's MLB boxscore lineup is
  // empty (manager hasn't posted yet), fall back to the batter's most-recent
  // confirmed batting_order_slot from cache_mlb_boxscore_player_stats. Memoized
  // per playerId. Null = no confirmed slot history.
  const projectedSlotCache = new Map<number, number | null>();

  return {
    async resolvePlayerId(name) {
      const k = normalizeName(name);
      if (pidByName.has(k)) return pidByName.get(k)!;
      const id = await resolvePlayerIdByName(name);
      pidByName.set(k, id);
      return id;
    },
    async pitcherSeason(id, season) {
      if (pitcherSeasonCache.has(id)) return pitcherSeasonCache.get(id)!;
      const v = await fetchPitcherSeason(id, season);
      pitcherSeasonCache.set(id, v);
      return v;
    },
    async pitcherGameLog(id, season) {
      if (pitcherLogCache.has(id)) return pitcherLogCache.get(id)!;
      const v = await fetchPitcherGameLog(id, season);
      pitcherLogCache.set(id, v);
      return v;
    },
    async pitcherOpposing(id, season) {
      if (pitcherOppCache.has(id)) return pitcherOppCache.get(id)!;
      const v = await fetchPitcherSeasonAsOpposing(id, season);
      pitcherOppCache.set(id, v);
      return v;
    },
    async batterSeason(id, season) {
      if (batterSeasonCache.has(id)) return batterSeasonCache.get(id)!;
      const v = await fetchBatterSeason(id, season);
      batterSeasonCache.set(id, v);
      return v;
    },
    async batterGameLog(id, season) {
      if (batterLogCache.has(id)) return batterLogCache.get(id)!;
      const v = await fetchBatterGameLog(id, season);
      batterLogCache.set(id, v);
      return v;
    },
    async batterTeam(id) {
      if (batterTeamCache.has(id)) return batterTeamCache.get(id)!;
      // D-270-C1 (2026-05-19): MLB Stats API /people/{id} does NOT include
      // currentTeam in its default response — must add ?hydrate=currentTeam.
      // Pre-fix: every batterTeam() call returned null → fallback at
      // scoreBatterMarketProps line ~953 mis-assigned every batter to
      // prop.home_team, producing the Braves-as-Marlins swap on the
      // Dashboard for the entire 2026-05-19 Braves@Marlins slate.
      const { ok, text } = await quietFetch(`${MLB_STATS_BASE}/people/${id}?hydrate=currentTeam`);
      let team: string | null = null;
      if (ok) {
        try {
          const d = JSON.parse(text);
          team = d?.people?.[0]?.currentTeam?.name ?? null;
        } catch { /* ignore */ }
      }
      batterTeamCache.set(id, team);
      return team;
    },
    // D-283 SHIP 4 — opposing-team bullpen accessor. 7-day lookback
    // on cache_mlb_bullpen_stats. Returns null on cache miss → scoring
    // gracefully degrades to 0 factor.
    async opposingBullpen(teamName: string) {
      if (bullpenCache.has(teamName)) return bullpenCache.get(teamName)!;
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_bullpen_stats?team_name=eq.${encodeURIComponent(teamName)}&snapshot_date=gte.${sevenDaysAgo}&order=snapshot_date.desc&limit=1&select=bullpen_era,bullpen_whip,bullpen_ip`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) { bullpenCache.set(teamName, null); return null; }
        const rows = await res.json() as Array<{ bullpen_era: number | null; bullpen_whip: number | null; bullpen_ip: number | null }>;
        const v = rows.length > 0 ? rows[0] : null;
        bullpenCache.set(teamName, v);
        return v;
      } catch {
        bullpenCache.set(teamName, null);
        return null;
      }
    },
    // D-283 SHIP 1 / D-284 — game-day catcher framing accessor. Boxscore
    // lookup resolves catcher MLBAMID; framing rv_tot read from bulk-
    // loaded framingByPid map (D-284) when available, else per-catcher
    // DB query as fallback. Null degrade is graceful.
    async catcherFramingForGame(gamePk, isHome) {
      const key = `${gamePk}:${isHome ? "home" : "away"}`;
      if (catcherFramingCache.has(key)) return catcherFramingCache.get(key)!;
      try {
        const catchers = await fetchStartingCatchersForGame(gamePk);
        const catcherId = isHome ? catchers.home_id : catchers.away_id;
        if (!catcherId) {
          catcherFramingCache.set(key, null);
          return null;
        }
        // Bulk-loaded path (D-284): zero new DB calls
        if (framingBulkLoaded) {
          const v = framingByPid.get(catcherId) ?? null;
          catcherFramingCache.set(key, v);
          return v;
        }
        // Fallback path (per-catcher DB query, used when bulk loader didn't run)
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_framing?entity_id=eq.${catcherId}&entity_type=eq.Cat&order=snapshot_date.desc&limit=1&select=rv_tot,pitches`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) { catcherFramingCache.set(key, null); return null; }
        const rows = await res.json() as Array<{ rv_tot: number | null; pitches: number | null }>;
        const v = rows.length > 0 ? rows[0] : null;
        catcherFramingCache.set(key, v);
        return v;
      } catch {
        catcherFramingCache.set(key, null);
        return null;
      }
    },
    // D-282 SHIP 1 — fetch batter splits from cache_mlb_batter_splits.
    // Returns most-recent snapshot (within last 14 days). Null on cache
    // miss — scoring fn gracefully degrades.
    async batterSplits(id) {
      if (batterSplitsCache.has(id)) return batterSplitsCache.get(id)!;
      try {
        const fourteenDaysAgo = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_batter_splits?player_id=eq.${id}&snapshot_date=gte.${fourteenDaysAgo}&order=snapshot_date.desc&limit=1&select=vs_lhp_avg,vs_lhp_slg,vs_lhp_ops,vs_lhp_pa,vs_rhp_avg,vs_rhp_slg,vs_rhp_ops,vs_rhp_pa`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) { batterSplitsCache.set(id, null); return null; }
        const rows = await res.json() as Array<{ vs_lhp_avg: number | null; vs_lhp_slg: number | null; vs_lhp_ops: number | null; vs_lhp_pa: number | null; vs_rhp_avg: number | null; vs_rhp_slg: number | null; vs_rhp_ops: number | null; vs_rhp_pa: number | null }>;
        const v = rows.length > 0 ? rows[0] : null;
        batterSplitsCache.set(id, v);
        return v;
      } catch {
        batterSplitsCache.set(id, null);
        return null;
      }
    },
    async teamHitting(team) {
      if (teamHitCache.has(team)) return teamHitCache.get(team)!;
      const v = await readTeamHitting(team);
      teamHitCache.set(team, v);
      return v;
    },
    async teamSeason(team) {
      if (teamSeasonCache.has(team)) return teamSeasonCache.get(team)!;
      const v = await readTeamSeasonContext(team);
      teamSeasonCache.set(team, v);
      return v;
    },
    async h2hRecent(home, away, beforeCommence) {
      const k = `${home}|${away}|${beforeCommence}`;
      if (h2hCache.has(k)) return h2hCache.get(k)!;
      const v = await readH2HRecent(home, away, beforeCommence);
      h2hCache.set(k, v);
      return v;
    },
    async ballpark(park) {
      if (!park) return null;
      if (parkCache.has(park)) return parkCache.get(park)!;
      const v = await readBallparkFactor(park);
      parkCache.set(park, v);
      return v;
    },
    async scoreboard(gameDate, home, away) {
      const k = `${gameDate}|${home}|${away}`;
      if (scoreboardCache.has(k)) return scoreboardCache.get(k)!;
      const v = await readGameWeather(gameDate, home, away);
      scoreboardCache.set(k, v);
      return v;
    },
    async umpire(name) {
      if (!name) return null;
      if (umpireCache.has(name)) return umpireCache.get(name)!;
      const v = await readUmpireStats(name);
      umpireCache.set(name, v);
      return v;
    },
    // D-284 SHIP 1 — bulk loaders. Each fires ONE query, populates the
    // internal map for all slate-relevant entities, returns the row count
    // so the caller can log/checkpoint.
    async bulkLoadBullpens() {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_bullpen_stats?snapshot_date=gte.${sevenDaysAgo}&order=snapshot_date.desc&select=team_name,bullpen_era,bullpen_whip,bullpen_ip`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ team_name: string; bullpen_era: number | null; bullpen_whip: number | null; bullpen_ip: number | null }>;
        // Keep most-recent per team (rows are already date-desc ordered).
        for (const r of rows) {
          if (r.team_name && !bullpenCache.has(r.team_name)) {
            bullpenCache.set(r.team_name, { bullpen_era: r.bullpen_era, bullpen_whip: r.bullpen_whip, bullpen_ip: r.bullpen_ip });
          }
        }
        return rows.length;
      } catch { return 0; }
    },
    async bulkLoadBatterSplits(pids: number[]) {
      if (pids.length === 0) return 0;
      try {
        const fourteenDaysAgo = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
        const idList = pids.join(",");
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_batter_splits?player_id=in.(${idList})&snapshot_date=gte.${fourteenDaysAgo}&order=snapshot_date.desc&select=player_id,vs_lhp_avg,vs_lhp_slg,vs_lhp_ops,vs_lhp_pa,vs_rhp_avg,vs_rhp_slg,vs_rhp_ops,vs_rhp_pa`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ player_id: number; vs_lhp_avg: number | null; vs_lhp_slg: number | null; vs_lhp_ops: number | null; vs_lhp_pa: number | null; vs_rhp_avg: number | null; vs_rhp_slg: number | null; vs_rhp_ops: number | null; vs_rhp_pa: number | null }>;
        for (const r of rows) {
          if (!batterSplitsCache.has(r.player_id)) {
            const { player_id: _pid, ...splits } = r;
            batterSplitsCache.set(r.player_id, splits);
          }
        }
        // Negative-cache: pids requested but not returned, mark as null
        for (const pid of pids) {
          if (!batterSplitsCache.has(pid)) batterSplitsCache.set(pid, null);
        }
        return rows.length;
      } catch { return 0; }
    },
    // D-285 SHIP 1 — synchronous accessor + setter for game-day lineup
    // vs SP-hand aggregate. Populated by preloadLineupVsHand orchestrator
    // before scoring loop. Returns null when game not yet aggregated.
    lineupVsHand(gamePk: number) {
      return lineupVsHandCache.get(gamePk) ?? null;
    },
    setLineupVsHand(gamePk: number, agg) {
      lineupVsHandCache.set(gamePk, agg);
    },
    getCachedBatterSplits(id: number) {
      return batterSplitsCache.has(id) ? batterSplitsCache.get(id) : undefined;
    },
    // D-286 SHIP 2 — bulk-load pitcher arsenal (most-recent snapshot per pid)
    // D-657 SHIP 1 — REQUIRE pids filter (cache has thousands of rows; pulling
    // the whole table per tick OOMed the edge function — confirmed status 546
    // on every */5 tick post-D-654 SHIP 1).
    async bulkLoadPitcherArsenal(pids?: number[]) {
      try {
        const idFilter = pids && pids.length > 0
          ? `&player_id=in.(${pids.join(",")})`
          : ""; // empty filter retained as fallback for legacy callers; should be rare
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_pitcher_arsenal?order=snapshot_date.desc${idFilter}&select=player_id,breaking_ball_pct,offspeed_pct,total_pitches,csw_pct,total_pitches_csw`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ player_id: number; breaking_ball_pct: number | null; offspeed_pct: number | null; total_pitches: number | null; csw_pct: number | null; total_pitches_csw: number | null }>;
        for (const r of rows) {
          if (!pitcherArsenalCache.has(r.player_id)) {
            // D-750 — CSW% activated on LIVE picks. §19.3 CEO approval logged
            // in D-750. The historical_context_router already passes csw_pct
            // for re-scoring; LIVE path now also does. score_pitcher_csw
            // fires on tonight's slate at the next */5 process-games-mlb tick.
            // The merge-overlapping arsenal snapshots may have separate rows
            // per snapshot_date — csw_pct lives on the D-749 backfill snapshot
            // (typically the most recent), so the DESC sort picks it up.
            pitcherArsenalCache.set(r.player_id, { breaking_ball_pct: r.breaking_ball_pct, offspeed_pct: r.offspeed_pct, total_pitches: r.total_pitches, csw_pct: r.csw_pct, total_pitches_csw: r.total_pitches_csw });
          }
        }
        return pitcherArsenalCache.size;
      } catch { return 0; }
    },
    pitcherArsenal(pid: number) {
      return pitcherArsenalCache.get(pid) ?? null;
    },
    // D-596 — bulk-load pitch-type matchup aggregates (expected_whiff_pct,
    // expected_k_pct, expected_put_away) from cache_statcast_pitcher_arsenal.
    // Most-recent snapshot per pid where expected_put_away IS NOT NULL.
    async bulkLoadPitchTypeMatchup(pids?: number[]) {
      if (pitchTypeMatchupBulkLoaded) return pitchTypeMatchupCache.size;
      try {
        const idFilter = pids && pids.length > 0
          ? `&player_id=in.(${pids.join(",")})`
          : ""; // D-657 SHIP 1
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_pitcher_arsenal?order=snapshot_date.desc${idFilter}&select=player_id,expected_whiff_pct,expected_k_pct,expected_put_away&expected_put_away=not.is.null`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ player_id: number; expected_whiff_pct: number | null; expected_k_pct: number | null; expected_put_away: number | null }>;
        for (const r of rows) {
          if (pitchTypeMatchupCache.has(r.player_id)) continue;
          pitchTypeMatchupCache.set(r.player_id, {
            expected_whiff_pct: typeof r.expected_whiff_pct === "number" ? r.expected_whiff_pct : null,
            expected_k_pct:     typeof r.expected_k_pct === "number" ? r.expected_k_pct : null,
            expected_put_away:  typeof r.expected_put_away === "number" ? r.expected_put_away : null,
          });
        }
        pitchTypeMatchupBulkLoaded = true;
        return pitchTypeMatchupCache.size;
      } catch { return 0; }
    },
    pitchTypeMatchup(pid: number) {
      return pitchTypeMatchupCache.get(pid) ?? null;
    },
    // D-349 — bulk-load primary fastball velocity from cache_statcast_pitcher_arsenal.
    // Most-recent snapshot per pid. Primary FB = max of (ff_avg_speed, si_avg_speed)
    // since most starters use one or the other. Null when both missing.
    async bulkLoadPitcherVelocity(pids?: number[]) {
      if (pitcherVelocityBulkLoaded) return pitcherVelocityCache.size;
      try {
        const idFilter = pids && pids.length > 0
          ? `&player_id=in.(${pids.join(",")})`
          : ""; // D-657 SHIP 1
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_pitcher_arsenal?order=snapshot_date.desc${idFilter}&select=player_id,ff_avg_speed,si_avg_speed&or=(ff_avg_speed.not.is.null,si_avg_speed.not.is.null)`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ player_id: number; ff_avg_speed: number | null; si_avg_speed: number | null }>;
        for (const r of rows) {
          if (pitcherVelocityCache.has(r.player_id)) continue;
          const ff = typeof r.ff_avg_speed === "number" ? r.ff_avg_speed : null;
          const si = typeof r.si_avg_speed === "number" ? r.si_avg_speed : null;
          const primary = ff !== null && si !== null ? Math.max(ff, si) : (ff ?? si);
          pitcherVelocityCache.set(r.player_id, primary);
        }
        pitcherVelocityBulkLoaded = true;
        return pitcherVelocityCache.size;
      } catch { return 0; }
    },
    pitcherPrimaryFbVelo(pid: number) {
      return pitcherVelocityCache.get(pid) ?? null;
    },
    // D-349 — bulk-load pitcher splits (BAA vs LHB / RHB). Most-recent snapshot per pid.
    async bulkLoadPitcherSplits(pids?: number[]) {
      if (pitcherSplitsBulkLoaded) return pitcherSplitsCache.size;
      try {
        const idFilter = pids && pids.length > 0
          ? `&player_id=in.(${pids.join(",")})`
          : ""; // D-657 SHIP 1
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_pitcher_splits?order=snapshot_date.desc${idFilter}&select=player_id,baa_vs_lhb,pa_vs_lhb,baa_vs_rhb,pa_vs_rhb`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ player_id: number; baa_vs_lhb: number | null; pa_vs_lhb: number | null; baa_vs_rhb: number | null; pa_vs_rhb: number | null }>;
        for (const r of rows) {
          if (!pitcherSplitsCache.has(r.player_id)) {
            pitcherSplitsCache.set(r.player_id, { baa_vs_lhb: r.baa_vs_lhb, pa_vs_lhb: r.pa_vs_lhb, baa_vs_rhb: r.baa_vs_rhb, pa_vs_rhb: r.pa_vs_rhb });
          }
        }
        pitcherSplitsBulkLoaded = true;
        return pitcherSplitsCache.size;
      } catch { return 0; }
    },
    pitcherSplits(pid: number) {
      return pitcherSplitsCache.get(pid) ?? null;
    },
    // D-354 — consecutive games where the batter was a starter (batting_order_slot
    // not null), looking back ≤21 days from today. Returns null on cache miss.
    async consecutiveStarts(playerId, todayDate) {
      const key = `${playerId}|${todayDate}`;
      if (consecutiveStartsCache.has(key)) return consecutiveStartsCache.get(key) ?? null;
      let streak: number | null = null;
      try {
        // prop.game_date is YYYYMMDD format (no dashes). Normalize to ISO YYYY-MM-DD
        // so Date constructor + DB query (DATE column) both work correctly.
        const iso = todayDate.length === 8 && !todayDate.includes("-")
          ? `${todayDate.slice(0, 4)}-${todayDate.slice(4, 6)}-${todayDate.slice(6, 8)}`
          : todayDate;
        // 21-day lookback window keeps the streak honest (covers IL stints + off-days).
        const lookbackStart = new Date(`${iso}T00:00:00Z`);
        lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 21);
        const startStr = lookbackStart.toISOString().slice(0, 10);
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?player_id=eq.${playerId}&game_date=gte.${startStr}&game_date=lte.${iso}&batting_order_slot=not.is.null&select=game_date&order=game_date.desc&limit=30`;
        const r = await fetch(url, { headers: supaHeaders });
        if (r.ok) {
          const rows = await r.json() as Array<{ game_date: string }>;
          if (rows.length === 0) {
            streak = 0;
          } else {
            // Count consecutive games starting from most-recent. Gap > 3 days = streak ends.
            let count = 1;
            for (let i = 1; i < rows.length; i++) {
              const prev = new Date(rows[i - 1].game_date + "T00:00:00Z");
              const curr = new Date(rows[i].game_date + "T00:00:00Z");
              const gapDays = (prev.getTime() - curr.getTime()) / 86400000;
              if (gapDays <= 3) count++;
              else break;
            }
            streak = count;
          }
        }
      } catch { /* graceful degrade */ }
      consecutiveStartsCache.set(key, streak);
      return streak;
    },
    // D-354 — Position-weighted opposing-lineup K rate composite. Reads tonight's
    // OPPOSING lineup from /game/{pk}/boxscore (cached from D-347 lineupSpotCache
    // path), looks up each batter's season strikeOuts + plateAppearances via MLB
    // Stats API (batched in-memory), computes position-weighted avg K rate. Weights
    // proxy PA distribution by lineup slot (slot 1=1.20, 2=1.15, ..., 9=0.80).
    async lineupKComposition(gamePk, pitcherIsHome) {
      const key = `${gamePk}|${pitcherIsHome ? "home" : "away"}`;
      if (lineupKCompCache.has(key)) return lineupKCompCache.get(key) ?? null;
      let result: { weighted_k_rate: number | null; batters_with_data: number } | null = null;
      try {
        // Fetch boxscore for the opposing-side battingOrder.
        const r = await fetch(`${MLB_STATS_BASE}/game/${gamePk}/boxscore`);
        if (!r.ok) { lineupKCompCache.set(key, null); return null; }
        const d = await r.json();
        const oppSide = pitcherIsHome ? "away" : "home";
        const oppBattingOrder = (d?.teams?.[oppSide]?.battingOrder ?? []) as number[];
        if (oppBattingOrder.length < 6) { lineupKCompCache.set(key, null); return null; }
        // Per-slot weight: top of order gets more PAs. 9-slot pattern.
        const slotWeights = [1.20, 1.15, 1.10, 1.05, 1.00, 0.95, 0.90, 0.85, 0.80];
        let weightedSum = 0;
        let weightTotal = 0;
        let battersWithData = 0;
        // Fetch each batter's season K rate. Bounded ≤9 calls per game.
        await Promise.all(oppBattingOrder.slice(0, 9).map(async (pid, idx) => {
          try {
            const sr = await fetch(`${MLB_STATS_BASE}/people/${pid}/stats?stats=season&season=2026&group=hitting`);
            if (!sr.ok) return;
            const sd = await sr.json();
            const st = sd?.stats?.[0]?.splits?.[0]?.stat ?? {};
            const k = Number(st.strikeOuts);
            const pa = Number(st.plateAppearances);
            if (Number.isFinite(k) && Number.isFinite(pa) && pa >= 30) {
              const kRate = k / pa;
              const w = slotWeights[idx] ?? 1.0;
              weightedSum += kRate * w;
              weightTotal += w;
              battersWithData++;
            }
          } catch { /* per-batter graceful degrade */ }
        }));
        const weighted = weightTotal > 0 ? weightedSum / weightTotal : null;
        result = { weighted_k_rate: weighted, batters_with_data: battersWithData };
      } catch { result = null; }
      lineupKCompCache.set(key, result);
      return result;
    },
    // D-287 SHIP 1 — bulk-load ballpark orientation reference (30 rows)
    async bulkLoadBallparkOrientations() {
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_ballpark_orientation?select=venue_name,cf_compass_degrees,is_dome`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ venue_name: string; cf_compass_degrees: number; is_dome: boolean }>;
        for (const r of rows) {
          ballparkOrientationCache.set(r.venue_name, { cf_compass_degrees: r.cf_compass_degrees, is_dome: r.is_dome });
        }
        return ballparkOrientationCache.size;
      } catch { return 0; }
    },
    ballparkOrientation(venueName: string) {
      return ballparkOrientationCache.get(venueName) ?? null;
    },
    async bulkLoadCatcherFraming() {
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_framing?entity_type=eq.Cat&order=snapshot_date.desc&select=entity_id,rv_tot,pitches,snapshot_date`;
        const res = await fetch(url, { headers: supaHeaders });
        if (!res.ok) return 0;
        const rows = await res.json() as Array<{ entity_id: number; rv_tot: number | null; pitches: number | null; snapshot_date: string }>;
        // Most-recent-wins: rows date-desc, so first occurrence per entity_id stays.
        for (const r of rows) {
          if (r.entity_id && !framingByPid.has(r.entity_id)) {
            framingByPid.set(r.entity_id, { rv_tot: r.rv_tot, pitches: r.pitches });
          }
        }
        framingBulkLoaded = true;
        return framingByPid.size;
      } catch { return 0; }
    },
    // ============================================================
    // D-347 accessors — tonight's lineup_spot, day_after_night, travel
    // ============================================================
    async tonightLineupSpot(gamePk, playerId) {
      let pidToSlot = lineupSpotCache.get(gamePk);
      if (pidToSlot === undefined) {
        pidToSlot = null;
        try {
          const r = await fetch(`${MLB_STATS_BASE}/game/${gamePk}/boxscore`);
          if (r.ok) {
            const d = await r.json();
            const map = new Map<number, number>();
            for (const side of ["home", "away"] as const) {
              const bo = (d?.teams?.[side]?.battingOrder ?? []) as number[];
              for (let i = 0; i < bo.length && i < 9; i++) {
                if (typeof bo[i] === "number") map.set(bo[i], i + 1);
              }
            }
            pidToSlot = map.size > 0 ? map : null;
          }
        } catch { /* graceful degrade */ }
        lineupSpotCache.set(gamePk, pidToSlot);
      }
      const fromBoxscore = pidToSlot?.get(playerId);
      if (typeof fromBoxscore === "number") return fromBoxscore;

      // D-812 — projected-lineup fallback. Tonight's boxscore is empty (lineup
      // not posted yet by manager) — fall back to this batter's most recent
      // confirmed batting_order_slot from cache_mlb_boxscore_player_stats
      // (historical box scores). ~70-80% accurate for established starters
      // who play the same slot night-over-night. Returns null only when the
      // batter has NO confirmed slot history in the last 14 days.
      if (projectedSlotCache.has(playerId)) return projectedSlotCache.get(playerId)!;
      let projected: number | null = null;
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?player_id=eq.${playerId}&batting_order_slot=not.is.null&order=game_date.desc&limit=1&select=batting_order_slot`;
        const res = await fetch(url, { headers: supaHeaders });
        if (res.ok) {
          const rows = await res.json() as Array<{ batting_order_slot: number | null }>;
          if (rows.length > 0 && typeof rows[0].batting_order_slot === "number") {
            projected = rows[0].batting_order_slot;
          }
        }
      } catch { /* graceful degrade */ }
      projectedSlotCache.set(playerId, projected);
      return projected;
    },
    // D-807 — nextHittersBehindOps.
    // For a given pick (gamePk, playerId), return the avg OPS of the next 2
    // hitters BATTING BEHIND in the lineup (slot +1, +2 on same side, wrapping
    // 9→1). Reuses the memoized batterSeason cache (~10-30 extra MLB API calls
    // per slate for non-pick lineup members; pick-batters already cached).
    // POINT-IN-TIME: uses MLB Stats API season-to-date (live, no leakage for
    // forward scoring). Returns null if lineup unknown, batter not in lineup,
    // or no usable OPS data for behind-hitters.
    async nextHittersBehindOps(gamePk, playerId, season) {
      let lineup = lineupBySideCache.get(gamePk);
      if (lineup === undefined) {
        lineup = null;
        let homeTeamId: number | null = null;
        let awayTeamId: number | null = null;
        try {
          const r = await fetch(`${MLB_STATS_BASE}/game/${gamePk}/boxscore`);
          if (r.ok) {
            const d = await r.json();
            // D-813 PART 2 — capture team_id even when battingOrder is empty,
            // so the projected-fallback below can reconstruct per-team lineups.
            homeTeamId = (d?.teams?.home?.team?.id as number | undefined) ?? null;
            awayTeamId = (d?.teams?.away?.team?.id as number | undefined) ?? null;
            const homeSlotToPid = new Map<number, number>();
            const awaySlotToPid = new Map<number, number>();
            const pidToSide = new Map<number, "home" | "away">();
            for (const sideName of ["home", "away"] as const) {
              const bo = (d?.teams?.[sideName]?.battingOrder ?? []) as number[];
              const slotMap = sideName === "home" ? homeSlotToPid : awaySlotToPid;
              for (let i = 0; i < bo.length && i < 9; i++) {
                if (typeof bo[i] === "number") {
                  slotMap.set(i + 1, bo[i]);
                  pidToSide.set(bo[i], sideName);
                }
              }
            }

            // D-813 PART 2 — Projected-lineup fallback for nextHittersBehindOps.
            // When boxscore lineup is empty for either side (manager hasn't
            // posted lineup yet), fill from cache_mlb_boxscore_player_stats:
            // pick that team's MOST RECENT game (where they played as either
            // home or away) and use that lineup's slot→pid map as the projected
            // tonight's lineup. ~75-85% accurate for established starters.
            // POINT-IN-TIME CLEAN: cache_mlb_boxscore_player_stats holds only
            // finished-game data (game_date < today); no future-game leakage.
            for (const [sideName, teamId, slotMap] of [
              ["home", homeTeamId, homeSlotToPid] as const,
              ["away", awayTeamId, awaySlotToPid] as const,
            ]) {
              if (slotMap.size > 0 || teamId === null) continue;
              try {
                const url = `${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?team_id=eq.${teamId}&batting_order_slot=not.is.null&order=game_date.desc&limit=18&select=player_id,batting_order_slot,game_pk`;
                const r2 = await fetch(url, { headers: supaHeaders });
                if (r2.ok) {
                  const rows = await r2.json() as Array<{ player_id: number; batting_order_slot: number; game_pk: number }>;
                  if (rows.length > 0) {
                    const latestPk = rows[0].game_pk;
                    for (const row of rows) {
                      if (row.game_pk !== latestPk) break;
                      if (typeof row.batting_order_slot === "number" && !slotMap.has(row.batting_order_slot)) {
                        slotMap.set(row.batting_order_slot, row.player_id);
                        pidToSide.set(row.player_id, sideName);
                      }
                    }
                  }
                }
              } catch { /* graceful degrade */ }
            }

            if (homeSlotToPid.size + awaySlotToPid.size > 0) {
              lineup = { homeSlotToPid, awaySlotToPid, pidToSide };
            }
          }
        } catch { /* graceful degrade */ }
        lineupBySideCache.set(gamePk, lineup);
      }
      if (!lineup) return null;
      const side = lineup.pidToSide.get(playerId);
      if (!side) return null;
      const slotMap = side === "home" ? lineup.homeSlotToPid : lineup.awaySlotToPid;
      let playerSlot: number | null = null;
      for (const [slot, pid] of slotMap.entries()) {
        if (pid === playerId) { playerSlot = slot; break; }
      }
      if (playerSlot === null) return null;

      const opsValues: number[] = [];
      for (let off = 1; off <= 2; off++) {
        const nextSlot = ((playerSlot - 1 + off) % 9) + 1; // wrap 9→1
        const nextPid = slotMap.get(nextSlot);
        if (!nextPid) continue;
        const stats = await this.batterSeason(nextPid, season);
        if (!stats || stats.atBats < 50) continue;
        const slg = stats.atBats > 0 ? stats.totalBases / stats.atBats : 0;
        const ops = stats.obp + slg;
        if (ops > 0) opsValues.push(ops);
      }
      if (opsValues.length === 0) return null;
      return opsValues.reduce((a, b) => a + b, 0) / opsValues.length;
    },
    // D-817 — park dimensions accessor. Bulk-loads all 30 MLB parks once
    // per cron tick (static reference; parks don't change mid-season).
    parkDimensions(venueName) {
      if (!venueName) return null;
      return parkDimensionsByVenue.get(venueName) ?? null;
    },
    async bulkLoadParkDimensions() {
      if (parkDimensionsLoaded) return parkDimensionsByVenue.size;
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_park_dimensions?select=venue_name,lf_distance,cf_distance,rf_distance`;
        const r = await fetch(url, { headers: supaHeaders });
        if (r.ok) {
          const rows = await r.json() as Array<{ venue_name: string; lf_distance: number; cf_distance: number; rf_distance: number }>;
          for (const row of rows) {
            parkDimensionsByVenue.set(row.venue_name, {
              lf_distance: row.lf_distance,
              cf_distance: row.cf_distance,
              rf_distance: row.rf_distance,
            });
          }
        }
      } catch { /* graceful degrade */ }
      parkDimensionsLoaded = true;
      return parkDimensionsByVenue.size;
    },
    // D-816 — memoized batter pull rate (Baseball Savant batted-ball leaderboard).
    // Reads most recent snapshot from cache_statcast_batters_pull_rate.
    // Returns null on cache miss (factor returns 0 → graceful degrade).
    // POINT-IN-TIME: snapshot_date desc returns latest snapshot at scoring time.
    async batterPullRate(playerId) {
      if (pullRateCache.has(playerId)) return pullRateCache.get(playerId)!;
      let val: { pull_rate: number; pull_air_rate: number | null } | null = null;
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_batters_pull_rate?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=pull_rate,pull_air_rate`;
        const r = await fetch(url, { headers: supaHeaders });
        if (r.ok) {
          const rows = await r.json() as Array<{ pull_rate: number; pull_air_rate: number | null }>;
          if (rows.length > 0 && rows[0].pull_rate !== null) {
            val = {
              pull_rate: Number(rows[0].pull_rate),
              pull_air_rate: rows[0].pull_air_rate !== null ? Number(rows[0].pull_air_rate) : null,
            };
          }
        }
      } catch { /* graceful degrade */ }
      pullRateCache.set(playerId, val);
      return val;
    },
    // D-824 — memoized batter contact rate (Baseball Savant plate-discipline leaderboard).
    // Reads most recent snapshot from cache_statcast_batters_contact_rate.
    // Returns null on cache miss (factor returns 0 → graceful degrade).
    // POINT-IN-TIME: snapshot_date desc; LEAK-SAFE-ELIGIBLE because PK includes
    // snapshot_date (the D-820 lesson — table CAN be backfilled AS-OF).
    async batterContactRate(playerId) {
      if (contactRateCache.has(playerId)) return contactRateCache.get(playerId)!;
      let val: {
        whiff_percent: number;
        contact_percent: number | null;
        z_contact_percent: number | null;
        oz_contact_percent: number | null;
      } | null = null;
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_batters_contact_rate?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=whiff_percent,contact_percent,z_contact_percent,oz_contact_percent`;
        const r = await fetch(url, { headers: supaHeaders });
        if (r.ok) {
          const rows = await r.json() as Array<{ whiff_percent: number; contact_percent: number | null; z_contact_percent: number | null; oz_contact_percent: number | null }>;
          if (rows.length > 0 && rows[0].whiff_percent !== null) {
            val = {
              whiff_percent: Number(rows[0].whiff_percent),
              contact_percent: rows[0].contact_percent !== null ? Number(rows[0].contact_percent) : null,
              z_contact_percent: rows[0].z_contact_percent !== null ? Number(rows[0].z_contact_percent) : null,
              oz_contact_percent: rows[0].oz_contact_percent !== null ? Number(rows[0].oz_contact_percent) : null,
            };
          }
        }
      } catch { /* graceful degrade */ }
      contactRateCache.set(playerId, val);
      return val;
    },
    // D-808 — memoized batter sprint speed (Baseball Savant running leaderboard).
    // Reads most recent snapshot from cache_statcast_batters_sprint_speed.
    // Returns null on cache miss (factor returns 0 → graceful degrade).
    async batterSprintSpeed(playerId) {
      if (sprintSpeedCache.has(playerId)) return sprintSpeedCache.get(playerId)!;
      let speed: number | null = null;
      try {
        const url = `${SUPABASE_URL}/rest/v1/cache_statcast_batters_sprint_speed?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=sprint_speed`;
        const r = await fetch(url, { headers: supaHeaders });
        if (r.ok) {
          const rows = await r.json() as Array<{ sprint_speed: number }>;
          if (rows.length > 0 && rows[0].sprint_speed) {
            speed = Number(rows[0].sprint_speed);
          }
        }
      } catch { /* graceful degrade */ }
      sprintSpeedCache.set(playerId, speed);
      return speed;
    },
    // D-807 — memoized team context (TeamSeasonContext) for the batter's
    // own team. Powers score_batter_team_offense via opsSeason. Falls back
    // to null if the team name doesn't resolve or readTeamSeasonContext fails.
    async batterTeamContext(teamName) {
      if (!teamName) return null;
      if (teamCtxCache.has(teamName)) return teamCtxCache.get(teamName)!;
      let ctx: TeamSeasonContext | null = null;
      try {
        ctx = await readTeamSeasonContext(teamName);
      } catch { /* graceful degrade */ }
      teamCtxCache.set(teamName, ctx);
      return ctx;
    },
    async dayAfterNightFatigue(teamName, todayCommenceTime, playerId) {
      // Today must be a day game (commence <=19:00 UTC = 15:00 ET).
      const todayDt = new Date(todayCommenceTime);
      if (isNaN(todayDt.getTime()) || todayDt.getUTCHours() > 19) return false;
      const cacheKey = `${teamName}|${todayCommenceTime.slice(0, 10)}`;
      let yesterday = yesterdayGameCache.get(cacheKey);
      if (yesterday === undefined) {
        yesterday = null;
        try {
          // Find prior game for this team (any game where they were home or away) before today.
          const url = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?or=(home_team.eq.${encodeURIComponent(teamName)},away_team.eq.${encodeURIComponent(teamName)})&commence_time=lt.${todayCommenceTime}&order=commence_time.desc&limit=1&select=commence_time,game_pk,home_team,away_team`;
          const r = await fetch(url, { headers: supaHeaders });
          if (r.ok) {
            const rows = await r.json() as Array<{ commence_time: string; game_pk: number; home_team: string; away_team: string }>;
            if (rows.length > 0) {
              const row = rows[0];
              // Yesterday's game must be within last 24h AND have commenced >=23:00 UTC (=19:00 ET = night game).
              const yDt = new Date(row.commence_time);
              const hoursDiff = (todayDt.getTime() - yDt.getTime()) / 3600000;
              if (hoursDiff > 0 && hoursDiff <= 24 && yDt.getUTCHours() >= 23) {
                yesterday = { commenceTime: row.commence_time, gamePk: row.game_pk, homeTeam: row.home_team, awayTeam: row.away_team };
              }
            }
          }
        } catch { /* graceful degrade */ }
        yesterdayGameCache.set(cacheKey, yesterday);
      }
      if (!yesterday) return false;
      // Confirm player started yesterday (had batting_order_slot in boxscore cache).
      const startedKey = `${playerId}|${yesterday.gamePk}`;
      let started = playerStartedYesterdayCache.get(startedKey);
      if (started === undefined) {
        started = false;
        try {
          const url = `${SUPABASE_URL}/rest/v1/cache_mlb_boxscore_player_stats?player_id=eq.${playerId}&game_pk=eq.${yesterday.gamePk}&batting_order_slot=not.is.null&select=batting_order_slot&limit=1`;
          const r = await fetch(url, { headers: supaHeaders });
          if (r.ok) {
            const rows = await r.json() as Array<{ batting_order_slot: number | null }>;
            started = rows.length > 0;
          }
        } catch { /* graceful degrade */ }
        playerStartedYesterdayCache.set(startedKey, started);
      }
      return started;
    },
    async travelContext(teamName, todayGameDate, todayVenue) {
      const cacheKey = `${teamName}|${todayGameDate}`;
      let ctx = travelCache.get(cacheKey);
      if (ctx !== undefined) return ctx;
      ctx = null;
      try {
        if (!todayVenue) { travelCache.set(cacheKey, null); return null; }
        const todayV = venueByTeamName(teamName) ?? null;
        // For away team in today's game we still want today's GAME venue, not their home venue.
        // Use todayVenue arg to look up coordinates more reliably via venue_name match.
        const todayVenueObj = venueByVenueName(todayVenue) ?? todayV;
        if (!todayVenueObj) { travelCache.set(cacheKey, null); return null; }

        // Look up yesterday's game for this team.
        const url = `${SUPABASE_URL}/rest/v1/cache_mlb_historical_outcomes?or=(home_team.eq.${encodeURIComponent(teamName)},away_team.eq.${encodeURIComponent(teamName)})&commence_time=lt.${todayGameDate}T23:59:59Z&order=commence_time.desc&limit=1&select=commence_time,home_team,away_team`;
        const r = await fetch(url, { headers: supaHeaders });
        if (!r.ok) { travelCache.set(cacheKey, null); return null; }
        const rows = await r.json() as Array<{ commence_time: string; home_team: string; away_team: string }>;
        if (rows.length === 0) { travelCache.set(cacheKey, null); return null; }
        const y = rows[0];
        // Only consider games within last 36h (so we capture yesterday or today-earlier);
        // longer gaps imply an off-day, no travel-fatigue signal.
        const yDt = new Date(y.commence_time);
        const tDt = new Date(`${todayGameDate}T12:00:00Z`);  // midday today as anchor
        const hoursDiff = (tDt.getTime() - yDt.getTime()) / 3600000;
        if (hoursDiff < 0 || hoursDiff > 36) { travelCache.set(cacheKey, null); return null; }
        // Yesterday's venue = yesterday's HOME team's home venue.
        const yVenue = venueByTeamName(y.home_team);
        if (!yVenue) { travelCache.set(cacheKey, null); return null; }
        const miles = haversineMiles(yVenue.lat, yVenue.lon, todayVenueObj.lat, todayVenueObj.lon);
        const direction = travelDirection(yVenue.lon, todayVenueObj.lon);
        ctx = { miles: Math.round(miles), direction };
      } catch { ctx = null; }
      travelCache.set(cacheKey, ctx);
      return ctx;
    },
  };
}

// ============================================================
// Main handler
// ============================================================

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return jsonResponse({ success: false, error: "missing supabase env" }, 500);

  // D-253f: reset module-scope dry-run state at the top of every request.
  _dryRun = false;
  _resetDryRunCounts();
  // D-538: reset the hard-gate rejection counter for this run.
  _d538_resetGateCounter();

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL_TOKEN && bearer !== SUPABASE_KEY)) {
    return jsonResponse({ success: false, error: "unauthorized" }, 401);
  }

  // D-340 / T6 — load MLB scoring weights from algorithm_weights row 1.
  // Mirrors NBA loadWeightsFromDB pattern at _shared/scoring.ts:309.
  // Runs ONCE per cron tick before scoring fires. setMlbWeights() mutates
  // module-scope W / W_BATTER / W_GAME in scoring_mlb_v2.ts so all
  // downstream scorer invocations within this request use the same DB
  // values. On DB failure → falls back to TS defaults (defense in depth).
  //
  // D-534 — extended to also load the per-market overrides JSONB column
  // (algorithm_weights.mlb_market_weight_overrides). Default = '{}'
  // → every market resolves to the global weights → BYTE-IDENTICAL to
  // pre-D-534 scoring. The dispatcher calls setActiveMarket(market)
  // before each scoreBatter*/scorePitcher*/scoreGame* so the scorer
  // sees the right per-market set once overrides are populated (D-535+).
  const { global: dbWeights, perMarket: perMarketWeights } = await loadMlbWeightsWithPerMarket();
  setMlbWeightsWithPerMarket(dbWeights, perMarketWeights);
  // Backward-compat: legacy setMlbWeights() callers (analyze-pick,
  // replay-historical-mlb, backtest-mlb-v3-historical) still work
  // because setMlbWeightsWithPerMarket initializes W/W_BATTER/W_GAME
  // identically to setMlbWeights(global). No imports break.
  void setMlbWeights;  // silence unused-import lint; kept exported for the legacy callers

  const start = Date.now();
  let gameDate = todayYyyymmddEt();
  let bypassGate = false;
  // D-329 SHIP 1a — game_ids_filter for per-game scheduler (Phase A).
  // When provided as a non-empty array, the slate is filtered to ONLY those
  // gamePks AFTER fetchScheduleFull(). Empty/missing = full slate (production
  // cron jobid=21 behavior preserved). process-single-game-mlb calls in with
  // a 1-element array. Per-game invocations skip slate-wide work that isn't
  // theirs while reusing the rest of the function's scoring path.
  let gameIdsFilter: number[] | null = null;
  // D-789 — VERIFICATION-ONLY body params (backward-safe, default off):
  //   markets_only: string[]    — when set, only score these market buckets
  //   bypass_preview_filter: bool — when true, include Live/Final games too
  // Both default OFF. Without them, behavior is byte-identical to pre-D-789.
  let marketsOnly: Set<string> | null = null;
  let bypassPreviewFilter = false;
  // D-814 — verification-only force-rescore. When true, clears the D-617
  // alreadyScored gamePk set so all games re-score regardless of hash
  // dedup. Production cron NEVER sets this (default false); only used
  // for explicit verification firings (e.g., confirming D-813 PART 2 +
  // PART 3 on real picks after they were already scored earlier same day).
  // Scopes: only the D-617 hash-dedup filter; D-620 dead-hours and
  // D-508 volume sharding still apply.
  let bypassD617Dedup = false;
  try {
    const body = await req.json();
    if (body?.game_date && /^\d{8}$/.test(body.game_date)) gameDate = body.game_date;
    if (body?.bypass_cache_gate === true) bypassGate = true;
    // D-253f: caller-controlled dry-run gate. When true: run all reads +
    // scoring as normal but skip ALL writes (recommendations_cache,
    // pick_history RPC, error_log/checkpoint, notify()).
    if (body?.dry_run === true) _dryRun = true;
    if (Array.isArray(body?.game_ids_filter) && body.game_ids_filter.length > 0) {
      gameIdsFilter = body.game_ids_filter
        .map((v: unknown) => typeof v === "number" ? v : Number(v))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      if (gameIdsFilter && gameIdsFilter.length === 0) gameIdsFilter = null;
    }
    if (Array.isArray(body?.markets_only) && body.markets_only.length > 0) {
      marketsOnly = new Set(body.markets_only.filter((m: unknown) => typeof m === "string"));
      if (marketsOnly.size === 0) marketsOnly = null;
    }
    if (body?.bypass_preview_filter === true) bypassPreviewFilter = true;
    if (body?.bypass_d617_dedup === true) bypassD617Dedup = true;
  } catch { /* no body */ }
  // D-789 — surface to module-level for fetchScheduleFull.
  _d789_bypassPreview = bypassPreviewFilter;

  // D-723 — prefetch the cache_mlb_player_metadata unique-name → player_id map
  // ONCE per cron tick so canonicalWritePickHistory can auto-fill player_id on
  // every new pick (closes the writeback gap surfaced by D-722/D-724). Single
  // bulk REST call (~1,337 rows, ~50ms); ambiguous-name collisions stay null
  // by the HAVING COUNT(DISTINCT player_id)=1 guard in the helper. Best-effort:
  // a fetch failure logs and disables auto-fill for the run (status quo).
  await prefetchMlbPlayerIds(SUPABASE_URL, SUPABASE_KEY).catch((e) => {
    console.log(`[d723] prefetch error: ${e}`);
    return 0;
  });

  // D-326 SHIP 2 mutex REMOVED in d326-rollback (this revision).
  //
  // The mutex was intended as defense-in-depth against overlapping cron
  // firings. Measured fallout: when process-games-mlb hits the 150s edge
  // runtime cap (which it does on large slates — pre-existing condition
  // unrelated to D-326), the function is SIGKILLed and the `finally{}`
  // release never runs. Every kill leaves a 15-min orphan lock that
  // blocks the next cron tick.
  //
  // Cron schedule is `5,35 17-23,0-4 * * *` — 30 min between firings,
  // 12× the function's max runtime. Concurrent overlap is structurally
  // impossible. The mutex provided no defense in practice and orphaned
  // locks were a real regression. Removed.
  const isoDate = ymdToIsoDate(gameDate);
  const season = Number(isoDate.slice(0, 4));

  // D-214 Fix 3 — precondition gate. Skip MLB scoring if MLB cache tables
  // are unhealthy (any of the 4 factor-data caches has zero rows fresher
  // than 24h). This prevents calibration-corrupted picks while the data
  // infrastructure recovers. Self-healing: once caches populate, the
  // next cron tick passes the gate naturally. Pass {bypass_cache_gate:true}
  // in body for manual override (e.g., one-time backfill smoke test).
  if (!bypassGate) {
    const checks: Array<{ table: string; ageFilter: string }> = [
      // PK columns have no fetched_at (PK-driven, never re-refreshed) so
      // we check row-count only for ballpark factors.
      { table: "cache_ballpark_factors", ageFilter: "" },
      { table: "cache_team_batting_stats", ageFilter: "&fetched_at=gte." + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
      { table: "cache_pitcher_game_logs", ageFilter: "&fetched_at=gte." + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
      { table: "cache_umpire_stats", ageFilter: "&fetched_at=gte." + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
      { table: "cache_mlb_game_scoreboard", ageFilter: "&fetched_at=gte." + new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    ];
    const missing: string[] = [];
    for (const c of checks) {
      const url = `${SUPABASE_URL}/rest/v1/${c.table}?select=*${c.ageFilter}&limit=1`;
      try {
        const r = await fetch(url, { headers: { ...supaHeaders, Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" } });
        const cr = r.headers.get("content-range") ?? "";
        const total = parseInt(cr.split("/")[1] ?? "0", 10);
        if (!Number.isFinite(total) || total === 0) missing.push(c.table);
      } catch { missing.push(c.table); }
    }
    if (missing.length > 0) {
      // D-253f: skip notify() in dry-run (writes notifications_log).
      if (!_dryRun) {
        await notify({
          severity: "warning",
          title: "process-games-mlb gated — MLB caches unhealthy",
          message: `Skipping MLB scoring. Missing fresh data in: ${missing.join(", ")}. Self-healing once caches populate.`,
          metadata: { game_date: gameDate, missing_caches: missing },
        });
      }
      const skipBase = {
        success: true, skipped: true,
        reason: "D-214 cache_gate: MLB caches unhealthy",
        missing_caches: missing,
        game_date: gameDate, duration_ms: Date.now() - start,
      };
      if (_dryRun) return jsonResponse({ dry_run: true, ...skipBase, would_write: _dryRunCounts, elapsed_ms: Date.now() - start });
      return jsonResponse(skipBase);
    }
  }

  try {
    await checkpoint("entered_main_handler", start, { game_date: gameDate, iso_date: isoDate, season });

    // D-635 — load line-movement map once per scoring run. Reads
    // cache_odds_snapshots (D-634); applied as a confidence + breakdown
    // augmentation after each scorer call. Source-agnostic by virtue of
    // reading the normalized snapshot table, not any provider directly.
    // gameDate format here is YYYYMMDD (from the URL); cache_odds_snapshots
    // stores YYYY-MM-DD — normalize at this boundary.
    try {
      const isoGameDateForLM = gameDate.length === 8
        ? `${gameDate.slice(0,4)}-${gameDate.slice(4,6)}-${gameDate.slice(6,8)}`
        : gameDate;
      _d635_lineMovementMap = await loadLineMovementMap("mlb", isoGameDateForLM);
    } catch (_e) {
      // Best-effort. If snapshot table is unreachable, factor degrades
      // gracefully (no_data verdict per pick; no confidence delta).
      _d635_lineMovementMap = null;
    }
    // D-636 — sharp-money map (cross-book, both sides) loaded once.
    try {
      const isoGameDateForSM = gameDate.length === 8
        ? `${gameDate.slice(0,4)}-${gameDate.slice(4,6)}-${gameDate.slice(6,8)}`
        : gameDate;
      _d636_sharpMoneyMap = await loadSharpMoneyMap("mlb", isoGameDateForSM);
    } catch (_e) {
      _d636_sharpMoneyMap = null;
    }

    let games = await fetchScheduleFull(isoDate);
    // D-329 SHIP 1a — apply game_ids_filter if provided (per-game scheduler path).
    // When the filter is null (production cron jobid=21), all games proceed.
    if (gameIdsFilter !== null) {
      const filterSet = new Set(gameIdsFilter);
      games = games.filter(g => filterSet.has(g.gamePk));
      await checkpoint("post_apply_game_ids_filter", start, { requested: gameIdsFilter.length, matched: games.length });
    }
    await checkpoint("post_fetch_schedule", start, { games_count: games.length });

    // ============================================================
    // D-813 PART 1 — Permanent weather fix. fetch-weather runs every 4h
    // via cron; picks scored between cron ticks previously had null weather.
    // D-812 patched manually; D-813 invokes inline at process-games-mlb start
    // so EVERY scoring run guarantees fresh weather. ~2-3s latency overhead,
    // well within 150s function timeout.
    //
    // Skip when slate empty (no work to do). Best-effort: failures don't
    // block scoring (existing readGameWeather() degrades gracefully on null).
    // ============================================================
    let d813_weather_inline_ok = false;
    if (games.length > 0) {
      try {
        const wRes = await fetch(`${SUPABASE_URL}/functions/v1/fetch-weather`, {
          method: "POST",
          headers: { Authorization: `Bearer ${BACKFILL_TOKEN || SUPABASE_KEY}` },
        });
        if (wRes.ok) {
          const wBody = await wRes.json().catch(() => null);
          // fetch-weather returns { snapshot_date, games_attempted, weather_fetched,
          // rows_upserted, error } — no `success` field. ok = HTTP 200 + no error
          // string + at least 1 game attempted.
          d813_weather_inline_ok = wBody !== null
            && (wBody.error === null || wBody.error === undefined)
            && typeof wBody.games_attempted === "number" && wBody.games_attempted > 0;
          await checkpoint("post_d813_inline_weather", start, {
            ok: d813_weather_inline_ok,
            games_attempted: wBody?.games_attempted ?? null,
            weather_fetched: wBody?.weather_fetched ?? null,
            rows_upserted: wBody?.rows_upserted ?? null,
          });
        }
      } catch (e) {
        // Graceful degrade: if fetch-weather fails, scoring continues with
        // whatever weather is already in cache_mlb_game_scoreboard.
        await checkpoint("post_d813_inline_weather", start, { ok: false, error: String(e).slice(0, 200) });
      }
    }

    // D-473 + D-508 — Progressive cron sharding. Each cron tick processes
    // games until projected pick VOLUME (not raw game count) reaches a cap.
    //
    // D-473 (pre-D-508): hardcoded N=2 games/tick. Worked on average but
    // per-game picks vary 6-134 (7-day data: p50=96 p95=122 max=134). Two
    // heavy games together (e.g. 134+122=256 picks) brushed the 150s
    // ceiling: 4 runtime_approaching_timeout events in 7 days, max 142.4s,
    // 7.6s margin from kill.
    //
    // D-508 — replace N=2 with a volume cap. PREDICTOR: props_cache rows
    // per (home_team, away_team) × empirical 0.065 ≈ projected picks/game.
    //   Empirical fit (7-day MLB data, n=91 matchups):
    //     median: 1647 props → 96 picks  → ratio 0.058
    //     max:    2068 props → 134 picks → ratio 0.0648
    //   PICKS_PER_PROP_RATE = 0.065 (covers the heavy end, slight overproject)
    //   CAP_PROJECTED_PICKS = 220
    //     Sizing: 142s historical worst @ ~256 picks (N=2 with two heavies).
    //     Linear scale: cap=220 → ~122s = 28s margin from 150s ceiling.
    //   Counterfactual on 2026-06-10 15-game slate (sorted by gameTime ASC):
    //     cap=200 → 15 ticks × 5min = 75 min slate clear (regresses past 60min target)
    //     cap=220 → 10 ticks × 5min = 50 min slate clear (within target) ✓
    //     cap=240 → 8 ticks × 5min  = 40 min slate clear (matches old N=2)
    //                                 worst-case ~133s (12s ceiling margin — too close)
    //
    // Greedy fill: sort unscored by gameTime ASC, add games while running
    // projection <= cap. Always include the FIRST unscored game even if it
    // alone projects > cap (escalation 2: process solo + flag).
    //
    // NOT applied when gameIdsFilter is set (D-329 per-game scheduler path
    // is explicit — the caller already controls which games to score).
    //
    // Trade-off (unchanged from D-473): if a tick crashes mid-scoring, the
    // progress row is NOT written and the next tick re-scores those games.
    // rec_cache + pick_history upserts are idempotent (D-446 ON-CONFLICT fix)
    // so the only cost is wasted Sonnet credits.
    const D508_CAP_PROJECTED_PICKS = 220;
    const D508_PICKS_PER_PROP_RATE = 0.065;
    const D508_SOLO_FLAG_THRESHOLD = 200;
    const fullSlateGameCount = games.length;
    // D-617 — surfaced to the post-scoring upsert at line ~3520; populated
    // INSIDE the D-508 shard block below. Default empty when D-508 skipped
    // (e.g., single-game per-game shard runs).
    let _d617_currentHashByGamePk = new Map<number, string>();
    if (gameIdsFilter === null && games.length > 1) {
      const SUPA_URL_473 = Deno.env.get("SUPABASE_URL") || "";
      const SUPA_KEY_473 = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

      // 1. Fetch already-scored game_pks for this slate-cycle + cached input hashes.
      //    D-617 — pre-D-617 the alreadyScored Set + early-return was TOO COARSE:
      //    a game scored once at slate rollover was skipped for the rest of the day,
      //    regardless of mid-day line moves. D-617 adds a per-game input hash so
      //    games whose props_cache content changed since last score get RE-SCORED.
      //    D-814 — when bypassD617Dedup=true (verification-only body param),
      //    keep alreadyScored empty so every game re-scores. Production cron
      //    NEVER sets bypass_d617_dedup; only manual verification firings.
      let alreadyScored = new Set<number>();
      const cachedHashByGamePk = new Map<number, string>();
      if (bypassD617Dedup) {
        await checkpoint("d814_bypass_d617_dedup_active", start, {
          note: "verification-only: clearing alreadyScored to force re-rescore",
        });
      } else try {
        const res = await fetch(
          `${SUPA_URL_473}/rest/v1/mlb_scoring_progress?game_date=eq.${encodeURIComponent(gameDate)}&select=game_pk,last_score_hash`,
          { headers: { apikey: SUPA_KEY_473, Authorization: `Bearer ${SUPA_KEY_473}` } },
        );
        if (res.ok) {
          const rows = await res.json() as Array<{ game_pk: number; last_score_hash: string | null }>;
          alreadyScored = new Set(rows.map((r) => r.game_pk));
          for (const r of rows) {
            if (r.last_score_hash) cachedHashByGamePk.set(r.game_pk, r.last_score_hash);
          }
        }
      } catch (_e) { /* best-effort; on read failure shard fills as if none scored */ }

      // 2. Fetch FULL props_cache rows for today (line/odds/pick_side/prop_type/player/bookmaker).
      //    Pre-D-617 we only pulled (home_team, away_team) to count props.
      //    D-617 needs the full content to hash per game for the input-change skip.
      //    The cost: ~1 extra small fetch per cron tick. The savings: skip wasted
      //    re-scores when nothing has changed (the cron's dominant cost class).
      const propsByMatchup = new Map<string, number>();
      const propsByMatchupRaw = new Map<string, Array<{ line: number; odds: number; pick_side: string | null; prop_type: string; player_name: string; bookmaker: string | null }>>();
      try {
        let pStart = 0;
        const PAGE = 10000;
        let iters = 0;
        while (iters++ < 5) {
          const r = await fetch(
            `${SUPA_URL_473}/rest/v1/props_cache?sport=eq.mlb&game_date=eq.${encodeURIComponent(gameDate)}&select=home_team,away_team,line,odds,pick_side,prop_type,player_name,bookmaker`,
            { headers: { apikey: SUPA_KEY_473, Authorization: `Bearer ${SUPA_KEY_473}`, Range: `${pStart}-${pStart + PAGE - 1}`, "Range-Unit": "items" } },
          );
          if (!r.ok) break;
          const rows = await r.json() as Array<{ home_team: string; away_team: string; line: number; odds: number; pick_side: string | null; prop_type: string; player_name: string; bookmaker: string | null }>;
          for (const row of rows) {
            // D-619 — store BOTH raw and normalized keys. Raw key preserves
            // existing propsByMatchup behavior (used by D-508 projection).
            // Normalized key (lowercase + strip non-alphanumeric) is what
            // the hash lookup uses so trivial team-name format differences
            // (periods, "Oakland Athletics" vs "Athletics") don't ghost a game.
            const key = `${row.home_team}|${row.away_team}`;
            const keyN = `${normTeamKey(row.home_team)}|${normTeamKey(row.away_team)}`;
            propsByMatchup.set(key, (propsByMatchup.get(key) || 0) + 1);
            if (!propsByMatchupRaw.has(keyN)) propsByMatchupRaw.set(keyN, []);
            propsByMatchupRaw.get(keyN)!.push(row);
          }
          if (rows.length < PAGE) break;
          pStart += PAGE;
        }
      } catch (_e) { /* best-effort; on read failure fall back to N=2 below */ }

      // 2b. D-617 — compute current props-only hash per game; identify games
      //     where cached hash exists AND differs from current → input changed →
      //     force re-score even if alreadyScored.has(gamePk).
      // D-619 — odds bucketed to 10¢ (materiality gate before D-620 redesign).
      // D-619 — team keys normalized on both sides so format mismatches don't
      // ghost a game. When no props match even after normalization, write a
      // "NOPROPS" sentinel so ring (b) bootstrap doesn't loop forever (the
      // 288/day ghost-game leak from D-618b).
      const currentHashByGamePk = new Map<number, string>();
      const hashChangedGamePks = new Set<number>();
      const ghostGames: Array<{ gamePk: number; homeTeam: string; awayTeam: string }> = [];
      for (const g of games) {
        const key1 = `${normTeamKey(g.homeTeam)}|${normTeamKey(g.awayTeam)}`;
        const key2 = `${normTeamKey(g.awayTeam)}|${normTeamKey(g.homeTeam)}`;
        const props = propsByMatchupRaw.get(key1) ?? propsByMatchupRaw.get(key2) ?? [];
        if (props.length === 0) {
          // D-619 ghost-game fix — un-hashable game (no props for its matchup,
          // even after key normalization). Write a NOPROPS sentinel so the
          // cached hash will exist on the next tick and ring (b) bootstrap
          // won't fire forever. If props arrive later (fetch-odds runs at
          // 17:00 UTC), the next hash will differ from "NOPROPS" → ring (c)
          // fires → game re-scores. Closes the D-618b 288/day leak.
          currentHashByGamePk.set(g.gamePk, "NOPROPS");
          ghostGames.push({ gamePk: g.gamePk, homeTeam: g.homeTeam, awayTeam: g.awayTeam });
          const cachedG = cachedHashByGamePk.get(g.gamePk);
          if (cachedG && cachedG !== "NOPROPS") hashChangedGamePks.add(g.gamePk);
          continue;
        }
        const sorted = props.slice().sort((a, b) =>
          (a.player_name || "").localeCompare(b.player_name || "") ||
          (a.prop_type   || "").localeCompare(b.prop_type   || "") ||
          (a.line - b.line) ||
          (a.pick_side   || "").localeCompare(b.pick_side   || "") ||
          (a.bookmaker   || "").localeCompare(b.bookmaker   || ""),
        );
        const propsKey = sorted.map((p) =>
          `${p.player_name}|${p.prop_type}|${p.line}|${bucketOdds10c(p.odds)}|${p.pick_side ?? ""}|${p.bookmaker ?? ""}`,
        ).join("\n");
        try {
          const buf = new TextEncoder().encode(`gp=${g.gamePk}\n${propsKey}`);
          const hashBuf = await crypto.subtle.digest("SHA-1", buf);
          const hex = Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("").slice(0, 16);
          currentHashByGamePk.set(g.gamePk, hex);
          const cached = cachedHashByGamePk.get(g.gamePk);
          if (cached && cached !== hex) hashChangedGamePks.add(g.gamePk);
        } catch (_e) { /* err toward re-scoring: if hash can't compute, don't add to map */ }
      }

      // 3. Greedy fill by projected volume.
      //    D-617 + D-619 + D-620 — the unscored filter has FOUR concentric rings:
      //      (a) never-scored today → score (LINE-OPEN — always score once)
      //      (b) scored, in T-4h+ DEAD HOURS → SKIP (D-620 cadence gate)
      //      (c) scored, in PRE-GAME WINDOW + cached hash missing → bootstrap
      //      (d) scored, in PRE-GAME WINDOW + cached hash differs → re-score
      //    Ring (b) is the D-620 STOPGAP-superseder: until D-617, every
      //    5-min tick re-evaluated every game. D-619 stopped re-scoring
      //    on trivial odds jiggle, but the dispatcher still woke every 5
      //    min for every game's hash check. D-620 makes the dispatcher
      //    SKIP entirely for games whose first_pitch is > NOW + 4h —
      //    no fetch, no hash, no re-score. Pre-game window: T-4h → first_pitch.
      //
      //    REVERT: set D620_DISABLE_DEAD_HOURS=true to bypass the T-4h
      //    gate. The system reverts to the pre-D-620 behavior (always
      //    apply D-619 hash check on every tick for every game).
      const D620_DEAD_HOURS_DISABLED = (Deno.env.get("D620_DISABLE_DEAD_HOURS") || "").toLowerCase() === "true";
      const D620_PREGAME_WINDOW_MS = 4 * 60 * 60 * 1000; // T-4h before first_pitch
      const now620 = Date.now();
      let d620_deadHourSkipped = 0;
      let d620_pregameWindowCount = 0;
      let d620_lineOpenCount = 0;
      const unscored = games
        .filter((g) => {
          // (a) never-scored — always score (LINE-OPEN).
          if (!alreadyScored.has(g.gamePk)) {
            d620_lineOpenCount++;
            return true;
          }
          // D-620 — T-4h dead-hours gate. Skip if game is scored AND
          // first_pitch is > NOW + 4h. Skip BEFORE hash check (so we
          // don't even compute the hash, saving the props_cache fetch
          // round-trip for dead games on subsequent ticks).
          if (!D620_DEAD_HOURS_DISABLED && g.gameTime) {
            const firstPitchMs = Date.parse(g.gameTime);
            if (Number.isFinite(firstPitchMs) && firstPitchMs - now620 > D620_PREGAME_WINDOW_MS) {
              d620_deadHourSkipped++;
              return false; // (b) — dead hours, skip entirely
            }
          }
          // In pre-game window OR dead-hours disabled. Apply D-617 hash filter.
          d620_pregameWindowCount++;
          if (!cachedHashByGamePk.has(g.gamePk)) return true;  // (c) bootstrap
          if (hashChangedGamePks.has(g.gamePk)) return true;   // (d) hash changed
          return false;
        })
        .sort((a, b) => (a.gameTime || "").localeCompare(b.gameTime || ""));

      const selected: typeof games = [];
      let runningProjection = 0;
      const projections: Array<{ gamePk: number; matchup: string; projectedPicks: number }> = [];
      for (const g of unscored) {
        const key = `${g.homeTeam}|${g.awayTeam}`;
        const propCount = propsByMatchup.get(key) || 0;
        const projectedPicks = Math.ceil(propCount * D508_PICKS_PER_PROP_RATE);
        projections.push({ gamePk: g.gamePk, matchup: `${g.homeTeam} vs ${g.awayTeam}`, projectedPicks });

        if (selected.length === 0) {
          // Always include the first unscored game (escalation 2)
          selected.push(g);
          runningProjection += projectedPicks;
          if (projectedPicks > D508_SOLO_FLAG_THRESHOLD) {
            await logError("process-games-mlb", "d508_solo_heavy_game",
              `single game projection ${projectedPicks} picks exceeds ${D508_SOLO_FLAG_THRESHOLD} threshold (processed solo)`,
              { game_pk: g.gamePk, matchup: `${g.homeTeam} vs ${g.awayTeam}`, projected_picks: projectedPicks, props_count: propCount });
          }
        } else if (runningProjection + projectedPicks <= D508_CAP_PROJECTED_PICKS) {
          selected.push(g);
          runningProjection += projectedPicks;
        } else {
          break; // adding this game would exceed cap
        }
      }
      // Safety fallback: if projection layer returned zero data for everything
      // (props_cache fetch failed) and the picker selected only the first
      // game, behavior matches D-473 N=1. If we want to preserve N=2 behavior
      // on fallback, allow a second game when projection sums are all 0.
      if (selected.length === 1 && unscored.length > 1
          && projections.every((p) => p.projectedPicks === 0)) {
        selected.push(unscored[1]);
        await logError("process-games-mlb", "d508_projection_fallback",
          `props_cache projection returned zero for all games — fell back to N=2 game-count sharding`,
          { game_date: gameDate });
      }
      games = selected;

      await checkpoint("post_d508_volume_shard", start, {
        cap_projected_picks: D508_CAP_PROJECTED_PICKS,
        picks_per_prop_rate: D508_PICKS_PER_PROP_RATE,
        full_slate_game_count: fullSlateGameCount,
        already_scored_count: alreadyScored.size,
        unscored_remaining: unscored.length,
        selected_for_this_tick: games.length,
        running_projection: runningProjection,
        projections_preview: projections.slice(0, 5),
        // D-617 — hash-skip telemetry
        d617_cached_hashes: cachedHashByGamePk.size,
        d617_current_hashes: currentHashByGamePk.size,
        d617_hash_changed_games: hashChangedGamePks.size,
        d617_hash_changed_pks: [...hashChangedGamePks].slice(0, 10),
        // D-619 — materiality + ghost telemetry
        d619_odds_bucket_cents: 10,
        d619_ghost_count: ghostGames.length,
        d619_ghost_games: ghostGames.slice(0, 5),
        d619_props_matchup_keys_sample: [...propsByMatchupRaw.keys()].slice(0, 5),
        // D-620 — time-window cadence telemetry
        d620_dead_hours_disabled: D620_DEAD_HOURS_DISABLED,
        d620_pregame_window_hours: 4,
        d620_line_open_games: d620_lineOpenCount,
        d620_pregame_window_games: d620_pregameWindowCount,
        d620_dead_hour_skipped: d620_deadHourSkipped,
      });

      // D-617 — surface current hashes to outer scope for the upsert
      // (the existing scoring_progress upsert at the end of the function
      // writes back game_pk + last_score_hash for next tick's skip).
      _d617_currentHashByGamePk = currentHashByGamePk;
    }

    if (games.length === 0) {
      const skipBase = { success: true, skipped: true, reason: "no scheduled MLB games", game_date: gameDate, duration_ms: Date.now() - start };
      if (_dryRun) return jsonResponse({ dry_run: true, ...skipBase, would_write: _dryRunCounts, elapsed_ms: Date.now() - start });
      return jsonResponse(skipBase);
    }

    // D-230 Fix 1 — staged load. Game-level markets pulled in a tight
    // small query first so they always score within the 150s IDLE_TIMEOUT
    // budget, even on slates where player props blow up to 20K+ rows.
    const gameProps_raw = await loadMlbProps(gameDate, ["h2h", "spreads", "totals"]);
    // D-391 (2026-06-02) — restrict MLB spreads (run line) candidates to the
    // STANDARD ±1.5 runline only. Whole-number alt-lines (±1, ±2, ±3 …) and
    // other half-integer alt-lines (±2.5, ±3.5 …) are dropped here BEFORE
    // bucketize/scoring. WHY: D-390 confirmed M2 — the rec_cache upsert
    // conflict key (game_date, player_name, prop_type, pick_side) omits
    // `line`, so multiple line variants for the same (matchup, pick_side)
    // race for one row and last-writer wins. rebet (rank 999 in
    // BOOKMAKER_PRIORITY, sorts last, sub-70 conf skips Sonnet → fastest
    // write path) was winning ~44% of races on today's slate (8 of 18
    // spreads picks surfaced as whole-number ±1 instead of ±1.5). Push
    // exposure quantified on 30d resolved spreads: whole-number 21.0%
    // push (n=539) vs half-point 0.0% push (n=745) → ~3.8 excess
    // pushes/day = ~1,400/yr would otherwise feed the resolver push-jam
    // class #77 just drained.
    //
    // NEGATIVE SCOPE: h2h passes through (prop_type !== "spreads") and
    // totals pass through (prop_type !== "spreads"). Only `spreads` is
    // filtered. NOT a scoring/weight change — the ±1.5 candidates that
    // survive get scored exactly as before; only the competing alt-line
    // candidates are removed pre-scoring.
    //
    // PER D-390: ±1.5 confirmed available in props_cache for every
    // affected game (sampled 8 of 8 whole-number example matchups across
    // 3-12 bookmakers each), so this filter does NOT drop any game's
    // side coverage — each matchup still has a ±1.5 side candidate.
    const gameProps = gameProps_raw.filter((p) =>
      p.prop_type !== "spreads" || Math.abs(p.line) === 1.5
    );
    await checkpoint("post_load_game_props", start, {
      game_props_count: gameProps.length,
      d391_filtered_out: gameProps_raw.length - gameProps.length,
    });
    const playerProps = await loadMlbProps(gameDate, [
      "hits", "home_runs", "total_bases", "rbis", "runs_scored",
      "strikeouts", "pitcher_strikeouts", "pitcher_outs", "pitcher_record_a_win",
    ]);
    await checkpoint("post_load_player_props", start, { player_props_count: playerProps.length });
    const allProps = [...gameProps, ...playerProps];
    if (allProps.length === 0) {
      const skipBase = { success: true, skipped: true, reason: "no MLB props in props_cache", game_date: gameDate, duration_ms: Date.now() - start };
      if (_dryRun) return jsonResponse({ dry_run: true, ...skipBase, would_write: _dryRunCounts, elapsed_ms: Date.now() - start });
      return jsonResponse(skipBase);
    }

    // Bucketize
    const buckets: Record<string, PropRow[]> = {
      pitcher_k: [], batter_hits: [], batter_hr: [], batter_total_bases: [], batter_rbis: [],
      batter_strikeouts: [],   // D-474 — new market bucket
      batter_runs_scored: [],  // D-475 — new market bucket
      pitcher_outs: [],        // D-476 — new market bucket
      game_side: [], game_total: [],
    };
    for (const p of allProps) {
      const m = classifyMarket(p.prop_type);
      if (buckets[m]) buckets[m].push(p);
    }
    await checkpoint("post_bucketize", start, {
      game_side: buckets.game_side.length,
      game_total: buckets.game_total.length,
      pitcher_k: buckets.pitcher_k.length,
      batter_hits: buckets.batter_hits.length,
      batter_hr: buckets.batter_hr.length,
      batter_total_bases: buckets.batter_total_bases.length,
      batter_rbis: buckets.batter_rbis.length,
      batter_strikeouts: buckets.batter_strikeouts.length,   // D-474
      batter_runs_scored: buckets.batter_runs_scored.length, // D-475
      pitcher_outs: buckets.pitcher_outs.length,             // D-476
    });

    const caches = buildCaches();

    // ============================================================
    // D-284 SHIP 1 — concurrent pre-load. Bulk-loads cache tables in
    // single queries + concurrently warms MLB Stats API caches for all
    // slate-relevant entities BEFORE the sequential scoring loops run.
    // Eliminates the per-pick latency that drove the D-283 IDLE_TIMEOUT.
    // ============================================================
    const preloadStart = Date.now();

    // 1. Resolve all player names → pids concurrently
    const uniqueNames = [...new Set(allProps.map((p) => p.player_name))];
    await concurrentMap(uniqueNames, (n) => caches.resolvePlayerId(n), 12);
    const allPids: number[] = [];
    for (const n of uniqueNames) {
      const id = await caches.resolvePlayerId(n);
      if (id !== null) allPids.push(id);
    }

    // 2. Identify probable pitcher IDs from schedule
    const pitcherIds = [...new Set(
      games.flatMap((g) => [g.homeProbableId, g.awayProbableId])
        .filter((id): id is number => id !== null && id !== undefined),
    )];
    // Batter pids = allPids minus pitcher pids
    const pitcherIdSet = new Set(pitcherIds);
    const batterPids = allPids.filter((id) => !pitcherIdSet.has(id));

    // 3. Concurrent bulk + per-id pre-warms
    const gamePks = [...new Set(games.map((g) => g.gamePk))];
    const teamNames = [...new Set(games.flatMap((g) => [g.homeTeam, g.awayTeam]))];
    const venues = [...new Set(games.map((g) => g.venue).filter((v): v is string => v !== null))];

    const preloadResults = await Promise.all([
      // 1-query bulk loads
      caches.bulkLoadBullpens(),
      caches.bulkLoadBatterSplits(batterPids),
      caches.bulkLoadCatcherFraming(),
      // D-284 — bulk-load Statcast caches (was 2 DB queries per pick before)
      bulkLoadBatterStatcast(batterPids),
      bulkLoadPitcherStatcast(pitcherIds),
      // D-286 SHIP 2 — bulk-load pitcher arsenal (D-657 SHIP 1 — slate-scoped).
      caches.bulkLoadPitcherArsenal(pitcherIds),
      // D-596 — bulk-load pitch-type matchup aggregates (same table, distinct columns)
      caches.bulkLoadPitchTypeMatchup(pitcherIds),
      // D-349 — bulk-load pitcher primary FB velocity + splits vs L/R
      caches.bulkLoadPitcherVelocity(pitcherIds),
      caches.bulkLoadPitcherSplits(pitcherIds),
      // D-287 SHIP 1 — bulk-load ballpark orientation reference
      caches.bulkLoadBallparkOrientations(),
      caches.bulkLoadParkDimensions(),
      // D-366 SHIP 6 — parallelize per-game boxscore fetches.
      // Was sequential per game (fetchLineup → then fetchStartingCatchers).
      // Both endpoints are independent → run them in parallel within each task.
      concurrentMap(gamePks, async (pk) => {
        await Promise.all([
          fetchLineupForGame(pk),
          fetchStartingCatchersForGame(pk),
        ]);
      }, 6),
      // D-302 SHIP 2 — preload active 26-man rosters for defensive gate
      preloadActiveRosters(),
      // Concurrent pitcher MLB API warmup (season, gameLog, opposing)
      concurrentMap(pitcherIds, (pid) => caches.pitcherSeason(pid, season), 8),
      concurrentMap(pitcherIds, (pid) => caches.pitcherGameLog(pid, season), 8),
      concurrentMap(pitcherIds, (pid) => caches.pitcherOpposing(pid, season), 8),
      // Concurrent batter MLB API warmup (season, gameLog, team)
      concurrentMap(batterPids, (pid) => caches.batterSeason(pid, season), 12),
      concurrentMap(batterPids, (pid) => caches.batterGameLog(pid, season), 12),
      concurrentMap(batterPids, (pid) => caches.batterTeam(pid), 12),
      // Concurrent team-level warmup
      concurrentMap(teamNames, (t) => caches.teamHitting(t), 10),
      concurrentMap(teamNames, (t) => caches.teamSeason(t), 10),
      // Park + scoreboard + umpire (1 per game)
      concurrentMap(venues, (v) => caches.ballpark(v), 6),
      concurrentMap(games, async (g) => {
        const sb = await caches.scoreboard(gameDate, g.homeTeam, g.awayTeam);
        if (sb.umpireName) await caches.umpire(sb.umpireName);
      }, 6),
    ]);

    await checkpoint("d284_preload_complete", start, {
      preload_ms: Date.now() - preloadStart,
      unique_pids: allPids.length,
      pitcher_pids: pitcherIds.length,
      batter_pids: batterPids.length,
      games: gamePks.length,
      bullpens_loaded: preloadResults[0],
      splits_loaded: preloadResults[1],
      framing_loaded: preloadResults[2],
      batter_statcast_loaded: preloadResults[3],
      pitcher_statcast_loaded: preloadResults[4],
      pitcher_arsenal_loaded: preloadResults[5],
      // D-302 SHIP 2 — active-roster preload status
      active_roster_loaded: preloadResults[12] ? (preloadResults[12] as Set<string>).size : 0,
      active_roster_gate_enabled: preloadResults[12] !== null,
      ballpark_orientations_loaded: preloadResults[9],
    });

    // ============================================================
    // D-285 SHIP 1 + D-286 SHIP 1 — lineup-vs-hand aggregator pre-load.
    // For each game, fetch today's starting lineup; for any team
    // missing a confirmed lineup, fall back to the projected lineup
    // (most recent completed game). Bulk-load any missing splits.
    // Compute PA-weighted team OPS vs LHP / vs RHP.
    // Track source per team: 'confirmed' | 'projected' | 'unavailable'.
    // ============================================================
    const lineupStart = Date.now();

    // Step 1: fetch today's lineups concurrently (best-effort confirmed)
    const lineupIdsByGamePk = new Map<number, { home: number[]; away: number[] }>();
    await concurrentMap(games, async (g) => {
      const ids = await fetchLineupIdsForGame(g.gamePk);
      lineupIdsByGamePk.set(g.gamePk, ids);
    }, 6);

    // Step 2: D-286 — for any team with empty confirmed lineup, queue
    // projected-lineup fallback. Build set of team IDs needing fallback.
    const teamsNeedingProjection = new Set<number>();
    for (const g of games) {
      const ids = lineupIdsByGamePk.get(g.gamePk) ?? { home: [], away: [] };
      if (ids.home.length === 0) teamsNeedingProjection.add(g.homeTeamId);
      if (ids.away.length === 0) teamsNeedingProjection.add(g.awayTeamId);
    }
    const projectedLineupByTeam = new Map<number, number[]>();
    if (teamsNeedingProjection.size > 0) {
      await concurrentMap([...teamsNeedingProjection], async (tid) => {
        const lineup = await fetchLatestLineupForTeam(tid);
        projectedLineupByTeam.set(tid, lineup);
      }, 6);
    }

    // Step 3: collect ALL lineup PIDs (confirmed + projected) + bulk-load missing splits
    const allLineupPids = new Set<number>();
    for (const ids of lineupIdsByGamePk.values()) {
      for (const pid of ids.home) allLineupPids.add(pid);
      for (const pid of ids.away) allLineupPids.add(pid);
    }
    for (const pids of projectedLineupByTeam.values()) {
      for (const pid of pids) allLineupPids.add(pid);
    }
    const missingSplits = [...allLineupPids].filter((pid) => caches.getCachedBatterSplits(pid) === undefined);
    if (missingSplits.length > 0) {
      await caches.bulkLoadBatterSplits(missingSplits);
    }

    // Step 4: compute per-game team OPS aggregates with source tracking
    let confirmedTeams = 0, projectedTeams = 0, unavailableTeams = 0;
    let splitsCacheMisses = 0;
    const splitsMissingPids: number[] = [];
    for (const g of games) {
      const ids = lineupIdsByGamePk.get(g.gamePk) ?? { home: [], away: [] };
      // Resolve final lineup per side + source
      const resolveSide = (side: "home" | "away"): { pids: number[]; source: "confirmed" | "projected" | "unavailable" } => {
        const confirmed = side === "home" ? ids.home : ids.away;
        if (confirmed.length > 0) return { pids: confirmed, source: "confirmed" };
        const teamId = side === "home" ? g.homeTeamId : g.awayTeamId;
        const projected = projectedLineupByTeam.get(teamId) ?? [];
        if (projected.length > 0) return { pids: projected, source: "projected" };
        return { pids: [], source: "unavailable" };
      };
      const home = resolveSide("home");
      const away = resolveSide("away");
      if (home.source === "confirmed") confirmedTeams++;
      else if (home.source === "projected") projectedTeams++;
      else unavailableTeams++;
      if (away.source === "confirmed") confirmedTeams++;
      else if (away.source === "projected") projectedTeams++;
      else unavailableTeams++;

      const computeTeam = (pids: number[]) => {
        let lhpOpsNum = 0, lhpOpsDen = 0, rhpOpsNum = 0, rhpOpsDen = 0;
        // D-664 — also bucket top-3 (slots 1-3) vs bottom-3 (slots 7-9) OPS for depth signal.
        // Hand-blended (avg of vs_lhp + vs_rhp / 2 weighted by pa). Cheap: same iteration.
        let top3Num = 0, top3Den = 0, bot3Num = 0, bot3Den = 0;
        for (let i = 0; i < pids.length; i++) {
          const pid = pids[i];
          const sp = caches.getCachedBatterSplits(pid);
          if (sp === undefined || sp === null) {
            if (sp === null) {
              splitsCacheMisses++;
              splitsMissingPids.push(pid);
            }
            continue;
          }
          if (sp.vs_lhp_ops !== null && sp.vs_lhp_pa !== null && sp.vs_lhp_pa > 0) {
            lhpOpsNum += sp.vs_lhp_ops * sp.vs_lhp_pa;
            lhpOpsDen += sp.vs_lhp_pa;
          }
          if (sp.vs_rhp_ops !== null && sp.vs_rhp_pa !== null && sp.vs_rhp_pa > 0) {
            rhpOpsNum += sp.vs_rhp_ops * sp.vs_rhp_pa;
            rhpOpsDen += sp.vs_rhp_pa;
          }
          // D-664 — depth: blend vs_lhp + vs_rhp PA-weighted to get an overall OPS for slot bucketing.
          const batterPa = (sp.vs_lhp_pa ?? 0) + (sp.vs_rhp_pa ?? 0);
          let blendedOps: number | null = null;
          if (batterPa > 0) {
            const lhpC = (sp.vs_lhp_ops ?? 0) * (sp.vs_lhp_pa ?? 0);
            const rhpC = (sp.vs_rhp_ops ?? 0) * (sp.vs_rhp_pa ?? 0);
            blendedOps = (lhpC + rhpC) / batterPa;
          }
          if (blendedOps !== null && i < 3) {
            top3Num += blendedOps * batterPa;
            top3Den += batterPa;
          } else if (blendedOps !== null && i >= 6) {
            bot3Num += blendedOps * batterPa;
            bot3Den += batterPa;
          }
        }
        return {
          vs_lhp_ops: lhpOpsDen > 0 ? lhpOpsNum / lhpOpsDen : null,
          vs_rhp_ops: rhpOpsDen > 0 ? rhpOpsNum / rhpOpsDen : null,
          lhp_pa: lhpOpsDen, rhp_pa: rhpOpsDen,
          top3_ops: top3Den > 0 ? top3Num / top3Den : null,
          bottom3_ops: bot3Den > 0 ? bot3Num / bot3Den : null,
        };
      };
      const homeAgg = computeTeam(home.pids);
      const awayAgg = computeTeam(away.pids);
      caches.setLineupVsHand(g.gamePk, {
        home_vs_lhp_ops: homeAgg.vs_lhp_ops, home_vs_rhp_ops: homeAgg.vs_rhp_ops,
        away_vs_lhp_ops: awayAgg.vs_lhp_ops, away_vs_rhp_ops: awayAgg.vs_rhp_ops,
        home_lineup_pa: homeAgg.lhp_pa + homeAgg.rhp_pa,
        away_lineup_pa: awayAgg.lhp_pa + awayAgg.rhp_pa,
        home_source: home.source,
        away_source: away.source,
        // D-664 — depth fields.
        home_top3_ops: homeAgg.top3_ops,
        home_bottom3_ops: homeAgg.bottom3_ops,
        away_top3_ops: awayAgg.top3_ops,
        away_bottom3_ops: awayAgg.bottom3_ops,
      });
    }

    // D-286 SHIP 1 — log splits cache misses for D-287 backfill signal
    if (splitsCacheMisses > 0 && !_dryRun) {
      await logError("process-games-mlb", "splits_cache_miss",
        `${splitsCacheMisses} lineup-batter splits missing from cache_mlb_batter_splits`,
        { sample_pids: splitsMissingPids.slice(0, 20), total_missing: splitsCacheMisses });
    }

    await checkpoint("d286_lineup_vs_hand_preload", start, {
      preload_ms: Date.now() - lineupStart,
      teams_confirmed: confirmedTeams,
      teams_projected: projectedTeams,
      teams_unavailable: unavailableTeams,
      teams_needing_projection: teamsNeedingProjection.size,
      total_lineup_pids: allLineupPids.size,
      missing_splits_loaded: missingSplits.length,
      splits_cache_misses: splitsCacheMisses,
    });

    const all: ScoredPick[] = [];
    let recsWritten = 0, recsErrors = 0, histWritten = 0, histErrors = 0;

    // D-232 Fix 4 — incremental flush. Pre-D-232 the function scored
    // ALL markets into `all[]` then wrote at the end; pitcher_k + batter
    // loops blew past the 150s IDLE_TIMEOUT and the freshly-scored game-
    // level picks never got written. Now: write per-market immediately
    // after scoring completes so partial completion still produces output.
    // D-332 Phase D Day 1 — tag each cache row with the path that wrote it.
    // When gameIdsFilter is non-null, the function was invoked by process-single-game-mlb
    // (per-game path). Otherwise it's the production mega-cron (jobid=21).
    const writerTag = gameIdsFilter !== null ? "per-game" : "mega-cron";

    async function flushBatch(scored: ScoredPick[]): Promise<void> {
      // D-288 SHIP 1 — parallelize per-pick + per-pick-step writes.
      // Pre-D-288: 207 picks × ~200ms (2 sequential DB calls each) = 41s.
      // Post-D-288: concurrency=8 across picks + recs/history concurrent
      // per pick → ~3-5s typical for same workload.
      await concurrentMap(scored, async (s) => {
        // D-538 hard-gate. If projection direction disagrees with pick_side,
        // refuse BOTH writes (pick_history + rec_cache). This is the
        // structural fix the D-536 audit named — D-467's conf-cap-at-69
        // was leaky (max conf=100 observed on batter_rbis disagree picks);
        // the gate stops the bleed at write time instead.
        //
        // The counter / per-market map is consumed by the run-summary log
        // at the end of the handler so this never goes silent.
        if (_d538_disagreesWithProjection(s.hist_payload)) {
          _d538_gateRejections++;
          const m = (s.hist_payload.mlb_market_type as string | undefined)
            ?? s.market ?? "unknown";
          _d538_gateRejectionsByMarket[m] = (_d538_gateRejectionsByMarket[m] ?? 0) + 1;
          return;
        }
        // D-332: inject last_writer tag at flush time so callers don't have to
        // know about it. Mutation is on a per-pick payload that's about to be
        // POSTed once and discarded.
        const recPayloadTagged = { ...s.rec_payload, last_writer: writerTag };
        const [r, h] = await Promise.all([
          writeRecommendationsCache(recPayloadTagged),
          writePickHistory(s.hist_payload),
        ]);
        if (r.ok) recsWritten++; else { recsErrors++; await logError("write-recs", "post_failed", r.error || "", { player: s.player_name, market: s.market }); }
        if (h.ok) histWritten++;
        else if (h.code === "D538_GATED") {
          // Pre-write gate above SHOULD have caught it; this branch is a
          // belt-and-suspenders safety. Don't log as an error.
          _d538_gateRejections++;
        }
        else {
          histErrors++;
          // D-488: distinct error_type for validation vs RPC failures.
          // - "rpc_failed" preserved for Postgres rejection (D-481 health
          //   check looks at this exact string; alerting unchanged).
          // - "pick_history_validation_failed" for hour-0 client-side
          //   rejection; ready for STAGE 5 D-459 sibling check.
          const errType = h.code === "CLIENT_VALIDATION" ? "pick_history_validation_failed" : "rpc_failed";
          await logError("write-history", errType, h.error || "", { player: s.player_name, market: s.market });
        }
      }, 8);
    }

    // D-235 — per-bucket time budget. Every cron tick reaches every
    // market via early break-out when a bucket's deadline elapses.
    // Static 20s per bucket × 7 markets = 140s worst case, leaving
    // 10s safety margin to Supabase's 150s IDLE_TIMEOUT.
    // Self-heal: UPSERT idempotency means re-running a bucket on the
    // next cron tick picks up where the prior tick broke off (the
    // seen-set + dedup early-continue cheap path skips already-scored
    // picks fast on subsequent ticks).
    // PER_BUCKET 20s × 7 markets = 140s ceiling.
    // TOTAL 140s leaves 10s margin to Supabase 150s IDLE_TIMEOUT for
    // final writes + elog buffer-flush. Empirically: first smoke
    // post-D-235 completed in 121s while still 0-scoring the last 2
    // batter buckets because the previous TOTAL_BUDGET_MS=120s hit
    // before they entered. 140s gives the trailing markets a
    // breathing slot of ~10-15s for partial-completion picks.
    // D-241 — per-market budget map replaces D-235 single 20s constant.
    // CEO Path 3 from D-238 disclosure: fast markets (game-level +
    // pitcher_k) historically complete in 5-15s, slow batter markets
    // (total_bases + rbis) timed out at 20s. Reallocate: cap fast at
    // 12-15s, raise slow to 27s. Sum 137s within 140s global ceiling.
    // D-270-C2 — bumped game_side/game_total budgets from 12s → 18s to
    // accommodate Sonnet calls for game-level markets (newly wired in
    // D-270-C2). Pre-D-270 these markets never called Sonnet, so 12s
    // was plenty; post-fix each conf>=70 pick takes 3-5s on Sonnet.
    // Reduced batter_hr 22s→18s to keep TOTAL_BUDGET_MS=140s envelope.
    const BUCKET_BUDGETS_MS: Record<string, number> = {
      game_side:          18_000,
      game_total:         18_000,
      pitcher_k:          15_000,
      batter_hits:        20_000,
      batter_hr:          18_000,
      batter_total_bases: 25_000,
      batter_rbis:        25_000,
      // D-474 — Market 1. Same shape as batter_hits (low candidate count
      // post-conf-70 gate; Sonnet-dominated per-pick cost). 15s budget
      // matches pitcher_k / batter_hits class. Under D-473 N=2 sharding
      // the per-tick load adds ~7-10s for this market (per D-472 sizing
      // estimate), well within the ceiling.
      batter_strikeouts:  15_000,
      // D-475 — Market 2. Same class as batter_strikeouts; ~3,388 props/
      // day (per D-475 SHIP 1 probe) translates to ~280 candidates per
      // 5-game-slate, comparable to batter_rbis (3,670 candidates total
      // pre-D-473) before the conf-70 gate. 15s budget at N=2 sharding.
      batter_runs_scored: 15_000,
      // D-476 — Market 3. ~250-650 pitcher_outs props/day (per D-475
      // SHIP 1 probe). Shares the pitcher_k dispatcher (same per-pitcher
      // ctx already loaded for K bucket); incremental per-tick cost is
      // mainly the additional Sonnet calls + payload writes. 15s budget
      // at N=2 sharding (~1-2 pitchers/tick → 1-3 conf-≥70 picks/tick).
      pitcher_outs: 15_000,
    };
    const TOTAL_BUDGET_MS = 140_000;
    const globalDeadline = start + TOTAL_BUDGET_MS;
    const bucketDeadline = (market: keyof typeof BUCKET_BUDGETS_MS) =>
      Math.min(Date.now() + BUCKET_BUDGETS_MS[market], globalDeadline);

    // D-238 — load staleness map once, share across all bucket scorers.
    // Map key: (player_name|prop_type|pick_side); value: existing
    // recs_cache row's created_at. Scorers sort props oldest-first;
    // null-keys treated as infinitely stale, processed before any
    // existing row. After 1 cron tick, every staleest pick has been
    // re-scored.
    const staleness = await loadStalenessMap(gameDate);
    await checkpoint("post_load_staleness", start, { staleness_size: staleness.size });

    _marketMetrics = await cacheMarketTrainingFeatures();
    await checkpoint("post_load_market_metrics", start, { metrics_size: _marketMetrics.size });

    _gateMetrics = await cacheMarketGateMetrics();
    await checkpoint("post_load_gate_metrics", start, { gate_metrics_size: _gateMetrics.size });

    // D-234 incremental flush preserved — scorers flush every
    // FLUSH_BATCH_SIZE=25 picks. Partial bucket completion lands rows
    // even when the bucket deadline cuts off mid-loop.
    // D-789 — VERIFICATION-ONLY: when markets_only is set, skip non-matching buckets.
    const _d789_skip = (m: string): boolean => marketsOnly !== null && !marketsOnly.has(m);
    if (buckets.game_side.length > 0 && !_d789_skip("game_side")) {
      await checkpoint("pre_game_side", start, { count: buckets.game_side.length });
      const scored = await scoreGameMarketProps(buckets.game_side, games, caches, season, "game_side", flushBatch, bucketDeadline("game_side"), staleness);
      all.push(...scored);
      await checkpoint("post_game_side_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    if (buckets.game_total.length > 0 && !_d789_skip("game_total")) {
      await checkpoint("pre_game_total", start, { count: buckets.game_total.length });
      const scored = await scoreGameMarketProps(buckets.game_total, games, caches, season, "game_total", flushBatch, bucketDeadline("game_total"), staleness);
      all.push(...scored);
      await checkpoint("post_game_total_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    if (buckets.pitcher_k.length > 0 && !_d789_skip("pitcher_k")) {
      await checkpoint("pre_pitcher_k", start, { count: buckets.pitcher_k.length });
      const scored = await scorePitcherKMarket(buckets.pitcher_k, games, caches, season, flushBatch, bucketDeadline("pitcher_k"), staleness);
      all.push(...scored);
      await checkpoint("post_pitcher_k_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    if (buckets.batter_hits.length > 0 && !_d789_skip("batter_hits")) {
      await checkpoint("pre_batter_hits", start, { count: buckets.batter_hits.length });
      const scored = await scoreBatterMarketProps(buckets.batter_hits, games, caches, season, "batter_hits", flushBatch, bucketDeadline("batter_hits"), staleness);
      all.push(...scored);
      await checkpoint("post_batter_hits_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    if (buckets.batter_hr.length > 0 && !_d789_skip("batter_hr")) {
      await checkpoint("pre_batter_hr", start, { count: buckets.batter_hr.length });
      const scored = await scoreBatterMarketProps(buckets.batter_hr, games, caches, season, "batter_hr", flushBatch, bucketDeadline("batter_hr"), staleness);
      all.push(...scored);
      await checkpoint("post_batter_hr_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    if (buckets.batter_total_bases.length > 0 && !_d789_skip("batter_total_bases")) {
      await checkpoint("pre_batter_total_bases", start, { count: buckets.batter_total_bases.length });
      const scored = await scoreBatterMarketProps(buckets.batter_total_bases, games, caches, season, "batter_total_bases", flushBatch, bucketDeadline("batter_total_bases"), staleness);
      all.push(...scored);
      await checkpoint("post_batter_total_bases_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    if (buckets.batter_rbis.length > 0 && !_d789_skip("batter_rbis")) {
      await checkpoint("pre_batter_rbis", start, { count: buckets.batter_rbis.length });
      const scored = await scoreBatterMarketProps(buckets.batter_rbis, games, caches, season, "batter_rbis", flushBatch, bucketDeadline("batter_rbis"), staleness);
      all.push(...scored);
      await checkpoint("post_batter_rbis_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    // D-474 — Market 1 of D-468 SHIP 4 queue. Same dispatch wrapper as the
    // 4 existing batter markets (reuses active-roster gate, lineup gate,
    // Sonnet rotation, D-302 two-phase pattern). Scored via scoreBatterStrikeouts.
    // Bucket deadline budget: same allocation pattern as other batter markets.
    if (buckets.batter_strikeouts.length > 0 && !_d789_skip("batter_strikeouts")) {
      await checkpoint("pre_batter_strikeouts", start, { count: buckets.batter_strikeouts.length });
      const scored = await scoreBatterMarketProps(buckets.batter_strikeouts, games, caches, season, "batter_strikeouts", flushBatch, bucketDeadline("batter_strikeouts"), staleness);
      all.push(...scored);
      await checkpoint("post_batter_strikeouts_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    // D-475 — Market 2 of D-468 SHIP 4 queue. Same dispatch wrapper as the
    // other batter markets (reuses active-roster gate, lineup gate, Sonnet
    // rotation, D-302 two-phase pattern). Scored via scoreBatterRunsScored.
    if (buckets.batter_runs_scored.length > 0 && !_d789_skip("batter_runs_scored")) {
      await checkpoint("pre_batter_runs_scored", start, { count: buckets.batter_runs_scored.length });
      const scored = await scoreBatterMarketProps(buckets.batter_runs_scored, games, caches, season, "batter_runs_scored", flushBatch, bucketDeadline("batter_runs_scored"), staleness);
      all.push(...scored);
      await checkpoint("post_batter_runs_scored_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    // D-476 — Market 3 of D-468 SHIP 4 queue. Shares scorePitcherKMarket
    // dispatcher (same per-pitcher ctx already cached); switches internal
    // scorer to scorePitcherOuts via the market parameter. 8-factor scorer
    // (avg-IP + manager-pull APPROXIMATION + pitch-count-trend + opp K rate
    // + ballpark + weather). Manager-pull factor is a proxy not real data —
    // conservatively weighted 0.5x; flagged in breakdown.quality_tier="B+".
    if (buckets.pitcher_outs.length > 0 && !_d789_skip("pitcher_outs")) {
      await checkpoint("pre_pitcher_outs", start, { count: buckets.pitcher_outs.length });
      const scored = await scorePitcherKMarket(buckets.pitcher_outs, games, caches, season, flushBatch, bucketDeadline("pitcher_outs"), staleness, "pitcher_outs");
      all.push(...scored);
      await checkpoint("post_pitcher_outs_flush", start, { scored: scored.length, hist_written_cum: histWritten });
    }
    // D-789 verification flag — log if markets_only was active so it shows
    // in checkpoint stream (helps diff a verification tick from a normal one).
    if (marketsOnly !== null) {
      await checkpoint("d789_markets_only_active", start, { markets: [...marketsOnly], bypass_preview: bypassPreviewFilter });
    }

    await checkpoint("post_writes", start, { recsWritten, recsErrors, histWritten, histErrors });

    // D-473 — Mark these games as scored for this slate so subsequent ticks
    // skip them and pick up the next N=2. Only when (a) auto-shard path
    // applied (gameIdsFilter null) AND (b) writes actually landed (avoid
    // marking a failed-mid-tick attempt as "done"). ON-CONFLICT silent dedupe
    // makes the insert idempotent across crash-then-retry sequences.
    // D-616 — RELAXED gate: write hash on EVERY full-slate non-dry-run
    // tick (with no histErrors), regardless of recsWritten. Pre-D-616 the
    // upsert only fired when new picks were written → on post-rollover
    // ticks recsWritten=0 → hash never written → next tick had no cached
    // hash → couldn't skip → re-scored everything → same retry pattern.
    // Dropping recsWritten > 0 from the condition lets the hash cache
    // bootstrap on the FIRST tick after the rollover scoring completes.
    if (gameIdsFilter === null && !_dryRun && histErrors === 0 && _d617_currentHashByGamePk.size > 0) {
      try {
        const SUPA_URL_473W = Deno.env.get("SUPABASE_URL") || "";
        const SUPA_KEY_473W = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
        const tickLabel = new Date().toISOString();
        // D-617 — write each scored game's current input hash so the NEXT
        // tick's filter (`unscored = ...|| hashChangedGamePks.has(...)`)
        // can detect line moves. Pre-D-617 the upsert only wrote game_pk;
        // post-D-617 it writes game_pk + last_score_hash so the binary
        // skip becomes a HASH skip (skipped only when current props_hash
        // matches the cached one).
        const rows = games.map((g) => ({
          game_date: gameDate,
          game_pk: g.gamePk,
          tick_label: tickLabel,
          last_score_hash: _d617_currentHashByGamePk.get(g.gamePk) ?? null,
        }));
        if (rows.length > 0) {
          await fetch(`${SUPA_URL_473W}/rest/v1/mlb_scoring_progress?on_conflict=game_date,game_pk`, {
            method: "POST",
            headers: {
              apikey: SUPA_KEY_473W,
              Authorization: `Bearer ${SUPA_KEY_473W}`,
              "Content-Type": "application/json",
              // D-616 — switched from ignore-duplicates to merge-duplicates so
              // the upsert overwrites last_score_hash when inputs changed.
              // Pre-D-616 the row was append-once-per-day; post-D-616 each
              // successful tick refreshes the hash for affected games.
              Prefer: "resolution=merge-duplicates,return=minimal",
            },
            body: JSON.stringify(rows),
          });
        }
      } catch (_e) { /* best-effort; never block return on progress-marker failure */ }
      await checkpoint("post_d473_progress_marked", start, { games_marked: games.length });
    }

    const byMarket: Record<string, number> = {};
    for (const s of all) byMarket[s.market] = (byMarket[s.market] || 0) + 1;

    const result = {
      success: true, game_date: gameDate, iso_date: isoDate,
      scheduled_games: games.length, props_total: allProps.length,
      props_by_market: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
      picks_scored: all.length, picks_by_market: byMarket,
      recommendations_written: recsWritten, recommendations_errors: recsErrors,
      pick_history_written: histWritten, pick_history_errors: histErrors,
      // D-538 — hard-gate rejections (projection direction disagrees with pick_side).
      // These picks were scored but refused at the writer; they don't reach
      // pick_history or rec_cache. Visibility prevents the silent-suppression
      // class D-536 named.
      d538_gate_rejections: _d538_gateRejections,
      d538_gate_rejections_by_market: { ..._d538_gateRejectionsByMarket },
      duration_ms: Date.now() - start,
      top_picks: all.slice().sort((a, b) => b.confidence - a.confidence).slice(0, 5).map((s) => ({
        market: s.market, player: s.player_name, opp: s.opponent, confidence: s.confidence, verdict: s.verdict,
      })),
    };

    // D-538 — log gate rejections to error_log so they show up in
    // run-history queries (the silent-suppression class from D-536
    // becomes loudly visible). Skip if 0 (no-op runs stay quiet).
    if (!_dryRun && _d538_gateRejections > 0) {
      await logError(
        "d538-hard-gate-summary",
        "d538_gate_rejections",
        `D-538 hard-gate refused ${_d538_gateRejections} picks (projection disagreed with pick_side)`,
        {
          total_rejected: _d538_gateRejections,
          by_market: { ..._d538_gateRejectionsByMarket },
          game_date: gameDate,
        },
      );
    }

    // D-253f: suppress all notify() calls in dry-run (they write notifications_log).
    if (!_dryRun) {
      if (all.length === 0 && allProps.length > 0) {
        await captureError(new Error(`process-games-mlb scored 0 of ${allProps.length}`), { phase: "scoring", game_date: gameDate });
        await notify({ severity: "critical", title: "process-games-mlb produced 0 scored picks", message: `0 picks. ${allProps.length} MLB props loaded. Check error_log.`, metadata: { game_date: gameDate, buckets: result.props_by_market } });
      } else if (recsErrors > 0 || histErrors > 0) {
        await notify({ severity: "warning", title: "process-games-mlb partial-write errors", message: `Scored ${all.length}, recs err ${recsErrors}, hist err ${histErrors}.`, metadata: result });
      } else {
        await notify({ severity: "info", title: "process-games-mlb v1 7-market run", message: `${all.length} MLB picks scored across ${Object.keys(byMarket).length} markets in ${result.duration_ms}ms.`, metadata: result });
      }
    }
    // D-253f: dry-run response shape includes sample_pick + would_write counts.
    if (_dryRun) {
      const samplePick = all.length > 0 ? {
        market: all[0].market, player: all[0].player_name, opponent: all[0].opponent,
        confidence: all[0].confidence, verdict: all[0].verdict,
      } : null;
      // D-272-INF-2: heartbeat on dry-run path too.
      if (!_dryRun) await writeHeartbeat({ jobName: "process-games-mlb", status: "success", durationMs: Date.now() - start });
      return jsonResponse({
        dry_run: true,
        ...result,
        would_write: _dryRunCounts,
        sample_pick: samplePick,
        elapsed_ms: Date.now() - start,
      });
    }
    // D-272-INF-2: heartbeat success.
    await writeHeartbeat({ jobName: "process-games-mlb", status: "success", durationMs: Date.now() - start });

    // D-285 SHIP 2 — runtime monitoring. Alert when total runtime
    // approaches the Supabase 150s IDLE_TIMEOUT ceiling. Threshold
    // 130s leaves 20s buffer for response transit + heartbeat write.
    const totalRuntimeMs = Date.now() - start;
    if (totalRuntimeMs > 130_000 && !_dryRun) {
      await logError("process-games-mlb", "runtime_approaching_timeout",
        `Runtime ${totalRuntimeMs}ms exceeds 130s alert threshold (150s IDLE_TIMEOUT ceiling)`,
        { game_date: gameDate, runtime_ms: totalRuntimeMs, threshold_ms: 130_000, recs_written: recsWritten });
    }

    // D-288 deploy-lag diagnostic — top-level marker that propagates ONLY
    // when the new bundle is actually running. If response shows this
    // field, the deploy reached the runtime instance.
    // D-620 — Sonnet-gating counters bubble to the response so cost
    // measurement can be pulled from per-tick checkpoint/response.
    const resultWithMarker = {
      ...result,
      d288_deploy_marker: "live-v2.69",
      d620_sonnet_called: _d620_sonnetCalled,
      d620_sonnet_reused: _d620_sonnetReused,
      d620_existing_pick_cache_size: _d620_existingPickCache.size,
    };
    return jsonResponse(resultWithMarker);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await captureError(e instanceof Error ? e : new Error(msg), { phase: "top-level", game_date: gameDate });
    // D-253f: suppress notify in dry-run.
    if (!_dryRun) {
      await notify({ severity: "critical", title: "process-games-mlb top-level exception", message: msg, metadata: { game_date: gameDate } });
    }
    // D-272-INF-2: heartbeat error.
    if (!_dryRun) await writeHeartbeat({ jobName: "process-games-mlb", status: "error", durationMs: Date.now() - start, error: msg });
    if (_dryRun) return jsonResponse({ dry_run: true, success: false, error: msg, game_date: gameDate, would_write: _dryRunCounts, elapsed_ms: Date.now() - start }, 500);
    return jsonResponse({ success: false, error: msg, game_date: gameDate }, 500);
  }
  // D-326 SHIP 2 mutex removed — no lock release needed (no lock was acquired).
});
// D-287 marker 1779456899
// D-287 cache buster 1779457565
