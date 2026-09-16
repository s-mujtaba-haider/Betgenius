-- D-199 (Batch 2 Task 2.1) — ai_verdict structured column on pick_history.
--
-- Closes the deferred analysis from Batch 1 Task 1.1: AI verdict was
-- only embedded in ai_analysis prose (per D-168), preventing structured
-- cross-tab against algorithm tier + Kelly fraction. Adds a TEXT column
-- with values in {'TAKE','PASS','LEAN'} or NULL when AI didn't run /
-- text didn't parse.
--
-- §1.17 audit:
--   - NULLable TEXT, no NOT NULL DEFAULT → safe to add without backfill
--     pressure. Pre-D-199 rows are NULL.
--   - Writer paths (3) updated in this migration's paired code commit:
--     1. upsert_pick_history RPC — see 20260517000008 (regenerated RPC
--        with ai_verdict in INSERT VALUES + DO UPDATE SET, COALESCE-
--        wrapped on UPDATE to preserve prior value when caller omits).
--     2. process-games writer — pickHistoryRow gains ai_verdict from
--        the parsed Sonnet response.
--     3. analyze-pick writer — same pattern on the RPC payload.
--   - backfill-bdl-historical NOT updated (it doesn't run AI analysis —
--     ai_analysis is always NULL on backfill rows, so ai_verdict stays NULL).
--   - Backfill SQL UPDATE on existing ai_analysis text runs in this
--     migration (see end of file).
--
-- §1.14 N/A — no views touched.

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS ai_verdict TEXT;

COMMENT ON COLUMN public.pick_history.ai_verdict IS
  'D-199 — parsed AI verdict. TAKE | PASS | LEAN | NULL. Per D-168, AI verdict was previously only in ai_analysis prose; this column structures the same signal for cross-tab queries against algorithm tier + Kelly. NULL means AI did not run on this pick OR text didn''t match any known verdict pattern.';

-- Backfill from existing ai_analysis text. Pattern priorities (first
-- match wins):
--   1. Trailing FADE / FADE.\n / FADE alone → PASS (per Sonnet's actual
--      verdict vocab — D-168 "FADE on Elite" framing)
--   2. PASS / AVOID alone → PASS
--   3. STRONG TAKE / TAKE the / TAKE\n / trailing TAKE → TAKE
--   4. LEAN / MARGINAL → LEAN
--   5. Otherwise NULL
--
-- Case-insensitive across the board. POSIX ERE since PostgreSQL
-- regex doesn't support look-ahead.

UPDATE public.pick_history
SET ai_verdict = CASE
  -- FADE/PASS-like — must come BEFORE TAKE because "DON'T TAKE" / "FADE" can co-occur
  WHEN ai_analysis ~* '(FADE\.?\s*$|FADE\b[^a-z]|\bAVOID\b|\bPASS\b\s*$)' THEN 'PASS'
  -- LEAN — match trailing or standalone (Sonnet wraps with newline)
  WHEN ai_analysis ~* '(LEAN\.?\s*$|\nLEAN\b|\bLEAN\b\s*the\b|\bMARGINAL\b)' THEN 'LEAN'
  -- TAKE — broadest pattern, catches "TAKE", "TAKE the over", "TAKE the UNDER", "STRONG TAKE", "RECOMMENDED"
  WHEN ai_analysis ~* '(\bSTRONG\s+TAKE\b|\bTAKE\b\s+(the\s+)?(over|under|UNDER|OVER|this)?\.?\s*$|TAKE\.\s*$|^\s*TAKE\s|\nTAKE\b|\bRECOMMENDED\b)' THEN 'TAKE'
  ELSE NULL
END
WHERE ai_analysis IS NOT NULL
  AND ai_verdict IS NULL;

-- Verification — surface backfill coverage.
DO $$
DECLARE
  total_with_ai INT;
  total_parsed INT;
  pct_parsed NUMERIC;
BEGIN
  SELECT COUNT(*) INTO total_with_ai FROM public.pick_history
    WHERE ai_analysis IS NOT NULL;
  SELECT COUNT(*) INTO total_parsed FROM public.pick_history
    WHERE ai_analysis IS NOT NULL AND ai_verdict IS NOT NULL;
  pct_parsed := CASE WHEN total_with_ai > 0 THEN ROUND(total_parsed::numeric / total_with_ai * 100, 1) ELSE 0 END;
  RAISE NOTICE 'D-199 VERIFY: % of % ai_analysis rows parsed to ai_verdict (%.1f%%)',
    total_parsed, total_with_ai, pct_parsed;
  IF pct_parsed < 70 THEN
    RAISE WARNING 'D-199 VERIFY: parse coverage % below 70%% threshold — parser may be too strict', pct_parsed;
  END IF;
END $$;
