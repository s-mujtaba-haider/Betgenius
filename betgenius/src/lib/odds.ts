// D-548 (2026-06-18) — Real per-pick break-even helpers.
//
// Replaces the D-541 measurement bug class (BREAK_EVEN = 0.524 nominal
// -110). The dashboards in Performance.tsx + Admin.tsx had this
// hardcoded in 18 sites, biasing every operator-facing edge metric on
// heavily-juiced markets (TB at avg -143 → real BE 60.7%, not 52.4%).
//
// Matches the established correct pattern in src/lib/kelly.ts:209
// (breakEvenProb = 1 / (b + 1)) and the existing impliedProb in
// Performance.tsx:203 (which is duplicated here as the canonical home).

/**
 * Implied probability (= break-even rate) from a single American-odds
 * line. Returns a value in [0, 1].
 *
 * -110 → 0.5238    (the historical hardcoded value)
 * -143 → 0.5885    (TB avg odds)
 * -159 → 0.6139    (TB median odds)
 * +110 → 0.4762
 * +150 → 0.4000
 */
export function impliedProb(odds: number): number {
  if (odds < 0) return -odds / (-odds + 100);
  return 100 / (odds + 100);
}

/**
 * Stake-weighted average implied probability across a set of bets.
 * This is the correct break-even reference for aggregate WR vs juice
 * comparisons (e.g., per-tier or per-prop-type cards).
 *
 * Falls back to the unweighted average when no stakes are present
 * (e.g., pick_history rows that don't track stake — Admin pages).
 *
 * Returns 0 when the input is empty.
 */
export function avgImpliedProb(items: { odds: number; stake?: number | null }[]): number {
  if (items.length === 0) return 0;
  let stakeSum = 0;
  let weighted = 0;
  let unweightedSum = 0;
  for (const it of items) {
    const p = impliedProb(it.odds);
    unweightedSum += p;
    const s = it.stake ?? 0;
    if (s > 0) {
      stakeSum += s;
      weighted += s * p;
    }
  }
  return stakeSum > 0 ? weighted / stakeSum : unweightedSum / items.length;
}
