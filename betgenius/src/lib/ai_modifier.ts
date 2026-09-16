// AI verdict → confidence modifier mapping.
// §15.10 Critical #1, CEO §19.3 approval May 12, 2026.
//
// CEO answer to spec Q1: ship +5/-5 magnitude; STRONG_TAKE/STRONG_FADE tier
// deferred until we see real verdict distributions in production.
// CEO answer to spec Q4: +5/-5 (not +2/-2 conservative). Small enough to be
// honest, large enough to materially shift Kelly when it should.
//
// The modifier is added to algorithm confidence before Kelly. Result is
// clamped to [50, 100] (kelly_action.ts handles the clamp); below 60
// effective → PASS.

import type { AIVerdict } from "./ai_verdict";

export function aiModifier(verdict: AIVerdict): number {
  if (verdict === "TAKE") return 5;
  if (verdict === "LEAN") return 2;
  if (verdict === "FADE") return -5;
  return 0;
}
