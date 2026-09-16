// D-637 — Lineup source abstraction (D-634 pattern).
// ─────────────────────────────────────────────────────────────────────
// Same swap-clean-later philosophy as the odds adapter: callers
// (lineup-confirmation-watcher, future re-scorers) reference the
// normalized ConfirmedLineup shape and NEVER touch a raw provider
// payload. A future swap to OddsJam / SportsDataIO / Sportradar
// implements the same interface; downstream code stays unchanged.
//
// Default impl: MlbStatsApiAdapter reading /game/{gamePk}/boxscore.
// D-632 confirmed this is the only working MLB Stats source (the
// /schedule?hydrate=lineups endpoint returns nothing).
//
// SWAP procedure (mirror D-634):
//   1. Implement LineupSourceAdapter for the new provider.
//   2. Register it in getLineupSourceAdapter() factory.
//   3. Set Deno.env LINEUP_SOURCE=<name>.
//   4. Redeploy lineup-confirmation-watcher. No other change needed.

// ─────────────────────────────────────────────────────────────────────
// Normalized vocabulary
// ─────────────────────────────────────────────────────────────────────
export interface ConfirmedLineupPlayer {
  // Canonical, normalized name (lowercased, non-alphanumeric stripped)
  // so downstream matching against pick.player_name is consistent.
  name_normalized: string;
  // Original full name (for display + audit).
  name_full: string;
  // 1..9 batting-order position. Starters only.
  batting_order: number;
  // "home" | "away". Source determines which team this player is on.
  side: "home" | "away";
}

export interface ConfirmedLineup {
  game_pk: number;
  source_name: string;          // "mlb_stats_boxscore" by default
  // null = lineup not yet posted. Empty array = explicit "no lineup yet"
  // (some sources differ); the watcher treats both as "not confirmed".
  players: ConfirmedLineupPlayer[] | null;
  // For debug / audit only. UTC ISO string.
  fetched_at: string;
}

export interface LineupSourceAdapter {
  name: string;
  fetchConfirmedLineup(game_pk: number): Promise<ConfirmedLineup>;
}

// ─────────────────────────────────────────────────────────────────────
// MLB Stats API adapter (default)
// ─────────────────────────────────────────────────────────────────────
const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

// D-728: was a local impl (NFD + Unicode diacritic class + strip non-alphanum).
// Now wraps the shared canonical normalizer + strips spaces for hash use.
// One BEHAVIOR CHANGE: Jr./Sr./III suffix is now stripped before the space-strip.
// "Cedric Mullins II" → previously "cedricmullinsii"; post-D-728 "cedricmullins".
// Impact on persisted lineup_hash: rosters containing players with suffix will
// produce a different hash than pre-D-728. The watcher will log such lineups
// as "new" once, then stabilize. Hash is used for dedup, not for lineup truth —
// no betting-correctness impact.
// MLB Stats API returns "Firstname Lastname"; the canonical's Lastname,
// Firstname swap is a no-op for the live MLB source — forward-defense only.
import { canonicalNameKey as normalizeName } from "./name_normalizer.ts";

class MlbStatsApiAdapter implements LineupSourceAdapter {
  name = "mlb_stats_boxscore";

  async fetchConfirmedLineup(game_pk: number): Promise<ConfirmedLineup> {
    const fetched_at = new Date().toISOString();
    const url = `${MLB_STATS_BASE}/game/${game_pk}/boxscore`;
    let players: ConfirmedLineupPlayer[] | null = null;
    try {
      const r = await fetch(url);
      if (!r.ok) {
        return { game_pk, source_name: this.name, players: null, fetched_at };
      }
      const d = await r.json() as {
        teams?: {
          home?: { players?: Record<string, {
            person?: { fullName?: string };
            battingOrder?: string;
          }> };
          away?: { players?: Record<string, {
            person?: { fullName?: string };
            battingOrder?: string;
          }> };
        };
      };
      const collected: ConfirmedLineupPlayer[] = [];
      for (const side of ["home", "away"] as const) {
        const sideMap = d?.teams?.[side]?.players ?? {};
        for (const pid of Object.keys(sideMap)) {
          const p = sideMap[pid];
          const order = p?.battingOrder ?? "";
          // D-632 finding: starters have battingOrder == "X00" (3 chars,
          // X in {1..9}, ending in 00). Bench players carry "X01", "X02"
          // for substitution position. Empty string = not yet posted.
          if (order.length === 3 && order.endsWith("00")) {
            const bo = Number(order.charAt(0));
            if (!Number.isFinite(bo) || bo < 1 || bo > 9) continue;
            const full = p?.person?.fullName || "";
            if (!full) continue;
            collected.push({
              name_full: full,
              name_normalized: normalizeName(full),
              batting_order: bo,
              side,
            });
          }
        }
      }
      // Empty collection here means MLB Stats returned the boxscore but
      // the battingOrder fields are still empty (lineup not posted yet).
      // That's a valid "not confirmed" signal — keep players = null so
      // the watcher's transition detector treats it identically to a
      // missing payload.
      players = collected.length > 0 ? collected : null;
    } catch {
      players = null;
    }
    return { game_pk, source_name: this.name, players, fetched_at };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────
const _registry: Record<string, () => LineupSourceAdapter> = {
  mlb_stats_boxscore: () => new MlbStatsApiAdapter(),
  // Future: oddsjam: () => new OddsJamLineupAdapter(),
  //          sportsdataio: () => new SportsDataIoLineupAdapter(),
};

export function getLineupSourceAdapter(): LineupSourceAdapter {
  const name = (Deno.env.get("LINEUP_SOURCE") || "mlb_stats_boxscore").toLowerCase();
  const factory = _registry[name];
  if (!factory) {
    throw new Error(
      `Unknown LINEUP_SOURCE='${name}'. Registered: ${Object.keys(_registry).join(", ")}`,
    );
  }
  return factory();
}

// Stable hash of a confirmed lineup for idempotency. Same lineup
// (regardless of player ordering inside the array) → same hash.
export async function hashConfirmedLineup(lineup: ConfirmedLineup): Promise<string> {
  if (!lineup.players || lineup.players.length === 0) return "EMPTY";
  const sorted = lineup.players
    .map((p) => `${p.side}|${p.batting_order}|${p.name_normalized}`)
    .sort();
  const buf = new TextEncoder().encode(sorted.join("\n"));
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("").slice(0, 16);
}

// Re-export normalizeName for the watcher's pick-matching path.
export { normalizeName };
