// D-560 (2026-06-19) — Multi-book line shopping: select the best-available
// same-line price for a pick, with Hard Rock preserved when it's within
// a small odds window of the best.
//
// Background:
//   * fetch-odds / fetch-odds-mlb already write ONE ROW PER BOOK per
//     (player, prop_type, pick_side) to props_cache.
//   * process-games / process-games-mlb already collect all same-(player,
//     prop_type) entries into the `available_books` JSONB on
//     recommendations_cache (D-381 SHIP 2/4).
//   * BUT the PRIMARY `odds` and `bookmaker` written to both rec cache
//     and pick_history were chosen by bookmaker priority (Hard Rock
//     first) — which means the bet GRADING and edge_pp calc used HRB's
//     odds even when another book offered higher payout on the same
//     line/side. D-560 fixes this so edge_pp reflects obtainable EV.
//
// The HRB window: if Hard Rock's same-line/same-side odds are within
// `hrbWindowCents` of the best book's odds, KEEP Hard Rock as primary
// (Matt's priority book; the small price diff isn't worth churning the
// chosen book). Otherwise use the highest-payout book as primary.
//
// 5 cents = 1 American-odds unit. Reasonable default: HRB at -110 vs
// best at -107 → diff = 3 cents → HRB still primary. HRB at -115 vs
// best at -105 → diff = 10 cents → best wins.

export interface AvailableBook {
  bookmaker: string;
  line: number;
  odds: number;
  pick_side: string;
}

export interface PrimaryPriceResult {
  odds: number;
  bookmaker: string;
  /** Was the chosen primary BETTER than the original (before this fn)? */
  liftCents: number;
  /** Highest-payout same-line book ignoring HRB priority — for telemetry. */
  bestBookmaker: string;
  bestOdds: number;
  /** HRB row found among same-line same-side options (null if HRB absent). */
  hrbBookmaker: string | null;
  hrbOdds: number | null;
}

/**
 * Choose the primary book for storage + grading.
 *
 * @param availableBooks  All same-(player, prop_type) book rows the cron
 *                        has collected. Will be filtered internally to
 *                        same-line + same-side.
 * @param currentLine     The pick's line value.
 * @param currentSide     The pick's side ("over"/"under"/"home"/"away").
 * @param originalBookmaker  The currently-selected primary bookmaker
 *                        (used to compute liftCents for telemetry).
 * @param originalOdds       The currently-selected primary odds value.
 * @param hrbWindowCents  If HRB is within this many cents of best, keep
 *                        HRB as primary. Default 5 (= 1 American unit).
 *
 * Returns `null` if no same-line same-side book offers a valid quote
 * (caller should fall back to whatever the original prop carried).
 */
export function selectBestSameLineBook(
  availableBooks: AvailableBook[] | null | undefined,
  currentLine: number,
  currentSide: string,
  originalBookmaker: string,
  originalOdds: number,
  hrbWindowCents = 5,
): PrimaryPriceResult | null {
  if (!availableBooks || availableBooks.length === 0) return null;

  // Filter to same line + same side. The book that gives a different
  // line (e.g. 5.5 vs 6.5) is a different bet; we don't substitute it.
  const sameLine = availableBooks
    .filter((b) => b.pick_side === currentSide && b.line === currentLine);
  if (sameLine.length === 0) return null;

  // Sort by odds DESC (highest payout first).
  const sorted = [...sameLine].sort((a, b) => b.odds - a.odds);
  const best = sorted[0];

  // Find any Hard Rock variant (hardrockbet, hardrockbet_oh, etc.).
  const hrb = sorted.find((b) => b.bookmaker.startsWith("hardrockbet")) ?? null;

  // If HRB is present AND within hrbWindow of best, keep HRB as primary.
  // (Matt's priority book preference per D-381.)
  let chosen: AvailableBook;
  if (hrb && (best.odds - hrb.odds) <= hrbWindowCents) {
    chosen = hrb;
  } else {
    chosen = best;
  }

  return {
    odds: chosen.odds,
    bookmaker: chosen.bookmaker,
    liftCents: chosen.odds - originalOdds,
    bestBookmaker: best.bookmaker,
    bestOdds: best.odds,
    hrbBookmaker: hrb?.bookmaker ?? null,
    hrbOdds: hrb?.odds ?? null,
  };
}
