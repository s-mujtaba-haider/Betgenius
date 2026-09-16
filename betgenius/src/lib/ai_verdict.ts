// AI verdict parser — §15.10 Critical #1 voice reconciliation (May 12, 2026).
//
// Extracts TAKE / LEAN / FADE from the trailing prose of ai_analysis. Both
// emission paths follow the same convention:
//   - Rule-based templates in process-games:2836-3015 end with a confidence-
//     gated `... TAKE.` or `... LEAN.` or `... FADE.` suffix.
//   - Gemini 2.0 Flash live LLM in analyze-pick:1441 is prompt-instructed:
//     "End with TAKE, LEAN, or FADE the {SIDE}".
//
// The verdict feeds aiModifier() which becomes a +/- adjustment to the
// algorithm confidence before Kelly. Parser MUST be conservative: prefer
// null over wrong-verdict on ambiguous prose so Kelly stays honest.
//
// Reading strategy: scan the last ~120 chars (where the verdict lives by
// convention) and take the LAST recognized token. This handles cases like
// "TAKE but the FADE risk is real" → FADE wins (most recent / cautious).
// If both TAKE and FADE appear in the tail, FADE wins on ties — same
// rationale, conservative bias.

export type AIVerdict = "TAKE" | "LEAN" | "FADE" | null;

export function extractAIVerdict(aiProse: string | null | undefined): AIVerdict {
  if (!aiProse) return null;
  const tail = aiProse.slice(-160).toUpperCase();

  // Scan for explicit verdict tokens. \b-bounded to avoid matching
  // "STAKE" / "RETAKE" / "FADED" etc.
  const tokens: AIVerdict[] = [];
  for (const m of tail.matchAll(/\b(TAKE|LEAN|FADE)\b/g)) {
    tokens.push(m[1] as AIVerdict);
  }
  if (tokens.length === 0) return null;

  // If multiple distinct verdicts appear, conservative bias: FADE > LEAN > TAKE.
  // Real reason: a "TAKE but watch the FADE risk" prose contains both; we don't
  // want to act on the rosy half. If only one verdict appears, return it.
  if (tokens.includes("FADE")) return "FADE";
  if (tokens.includes("LEAN")) return "LEAN";
  return "TAKE";
}
