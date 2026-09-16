// D-728 — Canonical name normalizer. ONE source of truth for player name
// canonicalization across the codebase. Replaces three drifted local copies:
//   1. resolve-picks/index.ts:28 (D-716 robust — this is the upstream source)
//   2. process-games-mlb/index.ts:191 (weak one-liner — lost accents entirely)
//   3. _shared/lineup_source.ts:54 (space-free hash format)
//
// Identical input → identical canonical output everywhere. No more silent drift
// when one module canonicalizes "Andrés" → "andres" and another → "andrs".
//
// HISTORICAL CONTEXT — this bug class has surfaced 5+ times:
//   D-704: backtest whiff lookup failed across cache name-format mismatch
//   D-706: production whiff lookup audit found same root cause
//   D-715: resolver audit on stuck-pending picks
//   D-716: resolver Lastname/Firstname fix (forward-prevention only)
//   D-718: SHIP 1 storage audit named "3 different normalizer impls" as a
//          systemic gap
// D-728 closes it by eliminating the divergence at the source.

/**
 * D-728: Canonical name normalizer. Use this for ANY cross-module name
 * comparison, dedup key, or set membership check.
 *
 * Operations performed (in order):
 *   1. lowercase + trim
 *   2. "Lastname, Firstname" → "Firstname Lastname" (D-716: Baseball Savant
 *      vs MLB Stats API convention drift)
 *   3. Unicode NFD normalize + combining-mark strip ("Andrés" → "Andres")
 *   4. Explicit Slavic/special-char replacements (ć→c, ñ→n, ü→u, ø→o…)
 *      — defensive: NFD covers most accents, but some Slavic chars decompose
 *      to non-ASCII; these explicit substitutions guarantee ASCII output
 *   5. Common suffix strip (Jr., Sr., III, II, IV)
 *   6. Period strip ("Jr." → "Jr" → stripped by step 5 — defense in depth)
 *
 * OUTPUT FORMAT: lowercase ASCII, spaces preserved between tokens. Example:
 *   "García, Adolís Jr." → "adolis garcia"
 *   "Andrés Giménez"    → "andres gimenez"
 *   "Pete Crow-Armstrong" → "pete crow-armstrong"
 *
 * For use cases needing a space-free key (e.g. hashing), apply
 * `nameKey(canonicalNormalizeName(name))` — preserves the canonical core
 * while removing the space.
 */
export function canonicalNormalizeName(name: string): string {
  let s = (name || "").toLowerCase().trim();
  // D-716 — Lastname, Firstname → Firstname Lastname
  if (s.includes(",")) {
    const parts = s.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 2) {
      s = `${parts[1]} ${parts[0]}`;
    }
  }
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ć/g, "c")
    .replace(/č/g, "c")
    .replace(/š/g, "s")
    .replace(/ž/g, "z")
    .replace(/đ/g, "d")
    .replace(/ñ/g, "n")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ä/g, "a")
    .replace(/é/g, "e")
    .replace(/è/g, "e")
    .replace(/ê/g, "e")
    .replace(/ë/g, "e")
    .replace(/í/g, "i")
    .replace(/ì/g, "i")
    .replace(/î/g, "i")
    .replace(/ï/g, "i")
    .replace(/ó/g, "o")
    .replace(/ò/g, "o")
    .replace(/ô/g, "o")
    .replace(/ú/g, "u")
    .replace(/ù/g, "u")
    .replace(/û/g, "u")
    .replace(/á/g, "a")
    .replace(/à/g, "a")
    .replace(/â/g, "a")
    .replace(/\s+(jr\.?|sr\.?|iii|ii|iv)$/i, "")
    .replace(/\./g, "");
}

/**
 * D-728: Space-free variant for hash/key use cases (lineup_source). Built on
 * top of canonicalNormalizeName so callers always benefit from
 * Lastname/Firstname swap, Slavic char handling, and suffix stripping.
 */
export function canonicalNameKey(name: string): string {
  return canonicalNormalizeName(name).replace(/\s+/g, "");
}
