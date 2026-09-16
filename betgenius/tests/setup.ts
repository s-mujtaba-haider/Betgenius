// D-195 — Vitest setup. The Deno global isn't present in node tests; stub
// the only Deno.env.get site in scoring.ts (loadWeightsFromDB) so importing
// the module doesn't throw. Tests that exercise loadWeightsFromDB explicitly
// are skipped (integration scope) — pure scorers don't touch Deno.
(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (_k: string) => undefined },
  serve: () => undefined,
};
