// D-162 (May 14, 2026): DST-safe ET game-date helper.
//
// Pre-D-162 the codebase had 7+ inline copies of
//   new Date(now.getTime() - 4 * 60 * 60 * 1000)
// to compute "today in ET". That offset is correct only during EDT
// (Mar 9 – Nov 1, 2026). EST (Nov 2 onward) is UTC−5, so during the
// 04:00–04:59 UTC hour the raw-offset version returns the wrong
// ET date by one day — breaking cache lookups, "tonight's picks"
// queries, and game-date filters.
//
// Single source of truth via Intl's IANA-zone-aware formatter.

// Returns YYYYMMDD for today (or today + offsetDays) in America/New_York.
// offsetDays = 0 → today; +1 → tomorrow; -1 → yesterday.
export function etGameDateYmd(offsetDays = 0): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (offsetDays === 0) return today.replace(/-/g, "");
  const [y, m, d] = today.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return target.toISOString().slice(0, 10).replace(/-/g, "");
}

// Converts an ISO timestamp to YYYYMMDD in ET. Used by Performance.tsx's
// toGameDate (pre-D-162 was raw -4h on the passed iso, same DST bug).
export function isoToEtGameDateYmd(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replace(/-/g, "");
}
