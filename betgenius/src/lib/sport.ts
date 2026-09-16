// Shared sport-selection types + helpers. Used by Dashboard, Games,
// Performance, and the SportSelector component.
//
// D-049 (May 1, 2026): Sport persistence to localStorage was disabled
// because MLB scoring wasn't online — selecting MLB trapped Dashboard on
// an empty cohort.
//
// D-204 T3.1+T3.5 (May 17, 2026): MLB Beta scoring shipped (7 markets:
// pitcher_k, batter_hits, batter_total_bases, batter_rbis, batter_hr,
// game_side, game_total). Restoring localStorage-backed persistence so a
// CEO/subscriber switching to MLB stays on MLB across refresh.

export type Sport = "nba" | "mlb";

export const SPORT_KEY = "betgenius_user_sport";
export const DEFAULT_SPORT: Sport = "nba";

export function readStoredSport(): Sport {
  if (typeof window === "undefined") return DEFAULT_SPORT;
  try {
    const v = window.localStorage.getItem(SPORT_KEY);
    return v === "mlb" ? "mlb" : DEFAULT_SPORT;
  } catch {
    return DEFAULT_SPORT;
  }
}

export function writeStoredSport(s: Sport): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SPORT_KEY, s);
  } catch { /* noop */ }
}
