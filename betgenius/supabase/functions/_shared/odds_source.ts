// D-634 — Source-abstracted odds-snapshot interface.
// ─────────────────────────────────────────────────────────────────────
// The contract here is the ONE place downstream code (snapshot writer,
// line-movement factor, RLM detector, "opened → now" display) reads.
// Adapters normalize their upstream provider (The Odds API today;
// potentially OddsJam / Sportradar / SportsDataIO / OpticOdds later)
// into the OddsSnapshot shape. To swap sources:
//   1. Implement OddsSourceAdapter for the new provider.
//   2. Register it in getOddsSourceAdapter() (env-config).
//   3. Done — no factor / scoring / display changes needed.
// See docs/loop/reports/d634_source_abstraction.md for the full
// swap procedure and the contract spec each adapter must respect.

// ─────────────────────────────────────────────────────────────────────
// NORMALIZED SHAPE — the canonical odds-snapshot row that ALL adapters
// must produce. Mirrors the cache_odds_snapshots table columns 1:1 so
// downstream readers can use either type interchangeably.
// ─────────────────────────────────────────────────────────────────────
export interface OddsSnapshot {
  // Sport key. Canonical lowercase: "mlb" | "nba". Adapters must map
  // provider-specific keys (e.g. The Odds API's "baseball_mlb") to this.
  sport: string;

  // Provider's game / event identifier. Stable for the lifetime of the
  // game across snapshots. Format varies by provider — the writer uses
  // it as a join key, never parses it.
  event_id: string;

  // YYYY-MM-DD (Eastern Time game date). Used by every downstream
  // query so it MUST be ET-anchored regardless of provider TZ.
  game_date: string;

  // ISO 8601 commence time (UTC). Null if provider didn't return one.
  game_time: string | null;

  // Team names as the provider supplies them. Adapters SHOULD normalize
  // to a single canonical spelling per team (the in-house normalization
  // table) so home_team / away_team match across snapshots.
  home_team: string;
  away_team: string;

  // Canonical market label. The set of values across adapters MUST
  // match the in-house market vocabulary:
  //   "batter_hits", "batter_total_bases", "batter_hr", "batter_rbis",
  //   "batter_runs_scored", "batter_strikeouts", "pitcher_k",
  //   "pitcher_outs", "game_side", "game_total"
  // Adapters mapping from provider strings (e.g. "batter_total_bases"
  // already canonical for The Odds API; OddsJam uses
  // "batter_total_bases_ou" — adapter normalizes).
  market: string;

  // Book-vocabulary prop_type. Mirrors props_cache.prop_type:
  //   "hits", "total_bases", "home_runs", "rbis", "runs_scored",
  //   "batter_strikeouts", "pitcher_strikeouts", "pitcher_outs",
  //   "spreads", "h2h", "totals"
  prop_type: string;

  // Player full name for player markets; team name for game markets.
  // Adapters MUST resolve to the canonical name spelling per the
  // in-house player_metadata table (no nicknames, no Jr./Sr. variation
  // across snapshots).
  player_name: string;

  // Pick side. "over" | "under" for total-type markets;
  // "home" | "away" for h2h; "spread" markets use "over"/"under" too
  // (D-540 normalization). Adapters MUST normalize to lowercase.
  pick_side: string;

  // Numeric line. Adapters MUST convert American notation (e.g. "1.5")
  // to a JS number. Zero-line markets (e.g. h2h) use line=0.
  line: number;

  // American odds as integer (-110, +120, etc.). Decimal-only providers
  // adapters MUST convert (decimal_to_american).
  odds: number;

  // Canonical bookmaker key. Lowercase, no spaces.
  //   "hardrockbet" | "fanduel" | "draftkings" | "betmgm" | "caesars" | ...
  // Adapters MUST map provider book keys to the in-house canonical set.
  // Unknown books → snake_case the provider name.
  bookmaker: string;
}

// ─────────────────────────────────────────────────────────────────────
// SOURCE ADAPTER — every provider implements this. The writer is
// adapter-agnostic; it only ever reads from .fetchCurrentSnapshots().
// ─────────────────────────────────────────────────────────────────────
export interface OddsSourceAdapter {
  // Human-readable identifier. Used for telemetry + log breadcrumbs:
  //   "the-odds-api" | "oddsjam" | "sportradar" | "sportsdataio" | "opticodds"
  readonly name: string;

  // Sports the adapter supports today. Writer skips sports not in this
  // set (returns []) rather than throwing — so a partial-coverage adapter
  // is a valid choice (e.g. an MLB-only feed).
  readonly supportedSports: readonly string[];

  // Returns the CURRENT snapshot of odds for the given sport+game_date.
  // "Current" means: latest observed values per (event, market, player,
  // side, book). The writer compares these to the most recent
  // cache_odds_snapshots row to decide whether to persist (delta-only).
  // Implementations MUST:
  //   - Return [] if sport not in supportedSports (don't throw).
  //   - Normalize ALL fields per the OddsSnapshot contract above.
  //   - Be idempotent — calling twice in quick succession returns the
  //     same data (up to upstream refresh cadence).
  // The writer does NOT pass auth tokens; adapters self-configure via
  // Deno.env (each adapter reads its own provider's secret).
  fetchCurrentSnapshots(opts: { sport: string; gameDate: string }):
    Promise<OddsSnapshot[]>;
}

// ─────────────────────────────────────────────────────────────────────
// THE-ODDS-API ADAPTER — D-634 first concrete implementation.
//
// Current data path: `fetch-odds-mlb` cron pulls The Odds API every
// 30 min into `props_cache`. This adapter reads from `props_cache`
// (which IS the normalized The Odds API output) rather than re-fetching
// HTTP. That makes the writer's snapshot cadence independent of the
// upstream HTTP cadence — and gives a single point where any provider
// can plug in (a future provider's fetch-odds writes to props_cache;
// the snapshot writer consumes via this same adapter).
//
// For OddsJam / Sportradar / etc.: the cleanest swap is to implement a
// parallel `fetch-odds-mlb-oddsjam` (or whatever) that ALSO writes to
// props_cache (idempotent UPSERT). Then this adapter swaps to the new
// provider by name only — see d634_source_abstraction.md "Swap
// procedure" for the step-by-step.
//
// If a future adapter wants to bypass props_cache and read provider HTTP
// directly, it can — the OddsSourceAdapter contract doesn't constrain
// where the data lives, only the shape returned.
// ─────────────────────────────────────────────────────────────────────
export class TheOddsApiAdapter implements OddsSourceAdapter {
  readonly name = "the-odds-api";
  readonly supportedSports = ["mlb"] as const;

  async fetchCurrentSnapshots(opts: { sport: string; gameDate: string }):
    Promise<OddsSnapshot[]> {
    if (!this.supportedSports.includes(opts.sport)) return [];
    const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };
    const out: OddsSnapshot[] = [];
    let pStart = 0;
    const PAGE = 10000;
    // props_cache.game_date is stored as 8-digit text "YYYYMMDD"
    // (not ISO YYYY-MM-DD). The OddsSnapshot contract uses
    // YYYY-MM-DD, so normalize on the way out below.
    const propsCacheDate = opts.gameDate.replace(/-/g, "");
    // Iteration cap of 5 = up to 50K rows per snapshot pull. Today's
    // MLB slate is ~22K rows so 1 page typically. Generous bound.
    for (let i = 0; i < 5; i++) {
      const url = `${SUPA_URL}/rest/v1/props_cache?sport=eq.${opts.sport}` +
        `&game_date=eq.${encodeURIComponent(propsCacheDate)}` +
        `&select=event_id,game_time,home_team,away_team,player_name,prop_type,line,odds,bookmaker,pick_side`;
      const r = await fetch(url, {
        headers: { ...headers, Range: `${pStart}-${pStart + PAGE - 1}`, "Range-Unit": "items" },
      });
      if (!r.ok) break;
      const rows = await r.json() as Array<{
        event_id: string; game_time: string | null;
        home_team: string; away_team: string;
        player_name: string; prop_type: string;
        line: number; odds: number;
        bookmaker: string; pick_side: string;
      }>;
      for (const row of rows) {
        out.push({
          sport: opts.sport,
          event_id: String(row.event_id),
          game_date: opts.gameDate,
          game_time: row.game_time,
          home_team: row.home_team,
          away_team: row.away_team,
          // Normalize prop_type → market label (canonical in-house vocabulary).
          market: propTypeToMarket(row.prop_type),
          prop_type: row.prop_type,
          player_name: row.player_name,
          pick_side: (row.pick_side ?? "").toLowerCase(),
          line: Number(row.line),
          odds: Number(row.odds),
          bookmaker: (row.bookmaker ?? "").toLowerCase(),
        });
      }
      if (rows.length < PAGE) break;
      pStart += PAGE;
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────
// FACTORY — single point where the active source is chosen. Defaults
// to TheOddsApiAdapter; the env var lets ops swap without code change
// once a second adapter ships. See d634_source_abstraction.md.
// ─────────────────────────────────────────────────────────────────────
export function getOddsSourceAdapter(): OddsSourceAdapter {
  const choice = (Deno.env.get("ODDS_SOURCE") || "the-odds-api").toLowerCase();
  switch (choice) {
    // case "oddsjam":      return new OddsJamAdapter();         // future
    // case "sportradar":   return new SportradarAdapter();      // future
    // case "sportsdataio": return new SportsDataIoAdapter();    // future
    // case "opticodds":    return new OpticOddsAdapter();       // future
    case "the-odds-api":
    default:
      return new TheOddsApiAdapter();
  }
}

// ─────────────────────────────────────────────────────────────────────
// PROP_TYPE → MARKET helper. Adapters that already get a canonical
// market label from their provider can skip this; The Odds API gives
// us prop_type at the book level, so we collapse to the in-house
// market vocabulary here. Kept exported so future adapters can reuse
// the same mapping when their provider uses prop_type-style keys.
// ─────────────────────────────────────────────────────────────────────
export function propTypeToMarket(propType: string): string {
  const p = (propType ?? "").toLowerCase();
  if (p === "hits") return "batter_hits";
  if (p === "total_bases") return "batter_total_bases";
  if (p === "home_runs") return "batter_hr";
  if (p === "rbis") return "batter_rbis";
  if (p === "runs_scored") return "batter_runs_scored";
  if (p === "batter_strikeouts") return "batter_strikeouts";
  if (p === "pitcher_strikeouts" || p === "strikeouts") return "pitcher_k";
  if (p === "pitcher_outs") return "pitcher_outs";
  if (p === "spreads" || p === "spread") return "game_side";
  if (p === "h2h") return "game_side";
  if (p === "totals") return "game_total";
  return p; // unknown — pass through; downstream filters/aggregators handle it.
}
