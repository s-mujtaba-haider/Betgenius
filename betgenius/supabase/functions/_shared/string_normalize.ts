// _shared/string_normalize.ts — string-normalization helpers.
//
// Per the Chat-17 string-normalization trap log: this is the 4th time string
// normalization has bitten us (NBA GSW/GS team key, MLB YYYYMMDD date format
// in pitch_count_trend, again in hitter_streak_fatigue, now diacritics in
// player names like "Eury Pérez"). Put the folds here so future code reuses
// them instead of re-discovering the bug.
//
// Keep these PURE and SMALL — no IO, no caching, no side effects. Anything
// that wants to use a fold for indexing builds its own Map keyed by the fold
// result.

/**
 * Diacritic fold + casefold.
 *
 * Maps "Eury Pérez" → "eury perez", "Germán Márquez" → "german marquez",
 * "Ronald Acuña Jr." → "ronald acuna jr.".
 *
 * Use this when matching player names across data sources that disagree
 * about diacritics (Odds API tends to be ASCII-only; MLB Stats API
 * preserves Unicode). Match BOTH sides through this fold so a "Pérez" in
 * one source matches a "Perez" in the other.
 */
export function foldDiacritics(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  // NFD splits "é" → "e" + combining acute accent.
  // \p{Diacritic} matches the combining marks; remove them.
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

/**
 * Normalize a YYYYMMDD or YYYY-MM-DD or ISO date string to YYYY-MM-DD.
 *
 * Returns the input unchanged if it's already in YYYY-MM-DD form or any
 * other shape we don't recognize. The pitch_count_trend + hitter_streak_fatigue
 * bug was the inverse: code assumed YYYY-MM-DD but got YYYYMMDD, which broke
 * `new Date()` parsing. Use this when bridging the two formats.
 *
 * Examples:
 *   "20260515" → "2026-05-15"
 *   "2026-05-15" → "2026-05-15"
 *   "2026-05-15T22:30:00Z" → "2026-05-15"
 */
export function normalizeDateYYYYMMDD(d: string | null | undefined): string {
  if (d === null || d === undefined) return "";
  const s = String(d).trim();
  // Already YYYY-MM-DD?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYYMMDD?
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  // ISO timestamp? Take just the date portion.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s;
}

/**
 * Build a Map<foldedName, value> for fast diacritic-tolerant lookups.
 *
 * Pass an array of records and a (record → name) accessor. Returns a Map
 * keyed by the foldDiacritics of the name, with the raw record as value.
 * Conflict policy: last-write-wins (so if two records fold to the same key,
 * the later one overrides the earlier).
 */
export function buildFoldedNameIndex<T>(
  records: T[],
  nameOf: (r: T) => string | null | undefined,
): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of records) {
    const folded = foldDiacritics(nameOf(r));
    if (folded) out.set(folded, r);
  }
  return out;
}
