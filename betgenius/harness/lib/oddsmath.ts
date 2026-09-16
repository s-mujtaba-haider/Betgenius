// Phase 1 backtest harness — odds math.
//
// Reuses the canonical implied-probability / net-odds formulas already
// shipped in production (src/lib/odds.ts's impliedProb, src/lib/kelly.ts's
// americanToDecimal) rather than re-deriving them, plus the CLV formula
// from the D-511 capture function (migrations/20260611100200_d511_capture_fn.sql).
// Both source files are pure (no top-level side effects), so importing them
// into this standalone Deno script is safe.

export { impliedProb } from "../../src/lib/odds.ts";
export { americanToDecimal } from "../../src/lib/kelly.ts";

import { impliedProb } from "../../src/lib/odds.ts";
import { americanToDecimal } from "../../src/lib/kelly.ts";

/** Net profit in stake units for a single 1-unit bet at `odds`.
 *  Win  -> americanToDecimal(odds)  (e.g. +150 -> 1.5u, -110 -> 0.909u)
 *  Loss -> -1u
 *  Mirrors backtest_weights_v3.sql's roi_pct CASE expression exactly:
 *    CASE WHEN odds > 0 THEN odds ELSE 10000/ABS(odds) END / 100 for a win,
 *    -100/100 for a loss. */
export function unitProfit(odds: number, won: boolean): number {
  return won ? americanToDecimal(odds) : -1;
}

/** Two-sided no-vig ("fair") probability for one side, removing the
 *  bookmaker's overround by normalizing both implied probabilities to sum
 *  to 1. Distinct from raw implied prob (break-even rate) — this is the
 *  harness's estimate of the market's true fair probability for the side
 *  actually bet. */
export function noVigProb(sideOdds: number, otherSideOdds: number): number {
  const pSide = impliedProb(sideOdds);
  const pOther = impliedProb(otherSideOdds);
  const overround = pSide + pOther;
  if (!Number.isFinite(overround) || overround <= 0) return 0.5;
  return pSide / overround;
}

/** CLV in implied-probability points. Mirrors _d511_implied_prob /
 *  capture_closing_odds_mlb exactly:
 *    clv_pct = (implied(closing_odds) - implied(entry_odds)) * 100
 *  Positive = beat the close (you got a number the market later agreed
 *  was worse for the other side, i.e. line moved your way). */
export function clvPct(entryOdds: number, closingOdds: number): number {
  return (impliedProb(closingOdds) - impliedProb(entryOdds)) * 100;
}

/** Under-side heavy juice flag — mirrors scoring_mlb_v2.ts unbettableJuiceFlag
 *  (D-164). Only applies to under picks; over-side juice is never flagged. */
export function isUnbettableJuice(
  confidence: number,
  odds: number,
  side: "over" | "under" | "home" | "away",
): boolean {
  if (side !== "under") return false;
  if (confidence >= 90 && odds <= -350) return true;
  if (confidence >= 80 && odds <= -300) return true;
  if (confidence >= 70 && odds <= -250) return true;
  if (confidence >= 60 && odds <= -200) return true;
  return false;
}

/** Over-side EV gate: calibrated win prob must clear book implied break-even.
 *  Uses post-D-823 confidence (0–100) as calibrated WR — NOT Kelly tier table. */
export function passesOverBreakeven(confidence: number, odds: number): boolean {
  return confidence / 100 >= impliedProb(odds);
}
