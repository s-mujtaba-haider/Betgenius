// Kelly action — the final voice for §15.10 Critical #1 voice reconciliation.
// CEO §19.3 approval May 12, 2026.
//
// Wraps the existing kellyBreakdown() math with the AI verdict modifier and
// classifies the output into a single subscriber-facing verdict:
//   BET         → Kelly recommends a positive stake at these odds
//   SKIP_PRICE  → algorithm + AI agree on an edge but the price doesn't
//                 support it (Kelly fraction ≤ 0)
//   PASS_NO_EDGE → effective confidence too low for any tier (< 60)
//
// Compute on render. No backend storage of action/stake — bankroll +
// kelly_fraction are per-user localStorage, and the AI modifier mapping
// may tune in the coming weeks (CTO call, spec TASK 6).

import { extractAIVerdict, type AIVerdict } from "./ai_verdict";
import { aiModifier } from "./ai_modifier";
import { kellyBreakdown, type KellyFractionMode } from "./kelly";

export type KellyAction = "BET" | "SKIP_PRICE" | "PASS_NO_EDGE";

export interface KellyActionResult {
  action: KellyAction;
  stake: number;                // $ — 0 unless action === 'BET'
  reason: string;               // short, human-readable
  algoConfidence: number;       // input passthrough
  aiVerdict: AIVerdict;         // extracted from prose
  aiModifierApplied: number;    // +5 / +2 / 0 / -5
  effectiveConfidence: number;  // clamp(algo + modifier, 50, 100)
  edgePercent: number;          // (probability − breakEvenProb) × 100
  fractionMode: KellyFractionMode;
}

export function computeKellyAction(params: {
  algoConfidence: number;
  aiProse: string | null | undefined;
  odds: number;
  bankroll: number;
  fraction?: number;
}): KellyActionResult {
  const verdict = extractAIVerdict(params.aiProse);
  const modifier = aiModifier(verdict);
  const effective = Math.max(50, Math.min(100, params.algoConfidence + modifier));

  // PROBABILITY_BY_CONFIDENCE has no <60 tier — anything below the floor is
  // PASS regardless of price.
  if (effective < 60) {
    return {
      action: "PASS_NO_EDGE",
      stake: 0,
      reason: "Effective confidence below 60 floor",
      algoConfidence: params.algoConfidence,
      aiVerdict: verdict,
      aiModifierApplied: modifier,
      effectiveConfidence: effective,
      edgePercent: 0,
      fractionMode: "quarter",
    };
  }

  const bd = kellyBreakdown({
    confidence: effective,
    odds: params.odds,
    bankroll: params.bankroll,
    fraction: params.fraction,
  });

  // kellyFraction ≤ 0 → price doesn't support an edge at this effective conf.
  // bd.fullKellyPct mirrors that gate; finalStake will also be 0 in this case.
  if (bd.fullKellyPct <= 0) {
    return {
      action: "SKIP_PRICE",
      stake: 0,
      reason: `Kelly ≤ 0 at ${params.odds} — price too steep for ${effective} effective`,
      algoConfidence: params.algoConfidence,
      aiVerdict: verdict,
      aiModifierApplied: modifier,
      effectiveConfidence: effective,
      edgePercent: bd.edgePct,
      fractionMode: bd.fractionMode,
    };
  }

  // Stake-rounding can push tiny positive Kelly down to $0 after the $5
  // rounding (e.g. 0.3% Kelly × $1000 = $3 → rounds to $0). Treat that as
  // SKIP_PRICE — the math says yes but the recommended stake is functionally
  // zero, and showing "BET $0" would be a worse subscriber experience.
  if (bd.finalStake <= 0) {
    return {
      action: "SKIP_PRICE",
      stake: 0,
      reason: `Kelly stake rounds to $0 at ${params.odds} (edge too thin)`,
      algoConfidence: params.algoConfidence,
      aiVerdict: verdict,
      aiModifierApplied: modifier,
      effectiveConfidence: effective,
      edgePercent: bd.edgePct,
      fractionMode: bd.fractionMode,
    };
  }

  return {
    action: "BET",
    stake: bd.finalStake,
    reason: `${bd.fractionMode} Kelly · $${bd.finalStake} · ${bd.edgePct.toFixed(1)}% edge`,
    algoConfidence: params.algoConfidence,
    aiVerdict: verdict,
    aiModifierApplied: modifier,
    effectiveConfidence: effective,
    edgePercent: bd.edgePct,
    fractionMode: bd.fractionMode,
  };
}
