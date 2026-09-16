-- D-199 — ai_verdict parser v2: relaxes the regex patterns to catch the
-- verdict word anywhere in the final ~250 chars, then maps to canonical
-- TAKE/PASS/LEAN. v1 was too strict (50.8% coverage); inspection of the
-- 414 unparsed rows showed verdict words like "LEAN Detroit, but don't
-- mortgage anything" or "TAKE" alone at end without trailing newline
-- discipline.
--
-- v2 strategy: scan the LAST 300 chars (the prose's verdict zone in
-- Sonnet's actual output). Order: PASS first (FADE/AVOID), then LEAN
-- (more specific than TAKE), then TAKE.
--
-- §1.12 verification at end re-checks coverage.

UPDATE public.pick_history
SET ai_verdict = (
  WITH tail AS (SELECT RIGHT(ai_analysis, 300) AS s)
  SELECT CASE
    -- PASS / FADE / AVOID — match anywhere in the final 300 chars
    WHEN (SELECT s FROM tail) ~* '\b(FADE|AVOID|^\s*PASS\s*$|\bPASS\s+(this|the))\b' THEN 'PASS'
    -- LEAN — broad: "LEAN" as standalone word anywhere in final 300 chars
    WHEN (SELECT s FROM tail) ~* '\bLEAN\b' THEN 'LEAN'
    -- TAKE — last by priority (TAKE often appears in other contexts too)
    WHEN (SELECT s FROM tail) ~* '\bTAKE\b' THEN 'TAKE'
    -- RECOMMENDED (rare variant)
    WHEN (SELECT s FROM tail) ~* '\bRECOMMENDED\b' THEN 'TAKE'
    ELSE NULL
  END
)
WHERE ai_analysis IS NOT NULL;

-- Verification: re-check parse coverage.
DO $$
DECLARE
  total_with_ai INT;
  total_parsed INT;
  pct_parsed NUMERIC;
  take_count INT;
  pass_count INT;
  lean_count INT;
BEGIN
  SELECT COUNT(*) INTO total_with_ai FROM public.pick_history
    WHERE ai_analysis IS NOT NULL;
  SELECT COUNT(*) INTO total_parsed FROM public.pick_history
    WHERE ai_analysis IS NOT NULL AND ai_verdict IS NOT NULL;
  SELECT COUNT(*) INTO take_count FROM public.pick_history WHERE ai_verdict = 'TAKE';
  SELECT COUNT(*) INTO pass_count FROM public.pick_history WHERE ai_verdict = 'PASS';
  SELECT COUNT(*) INTO lean_count FROM public.pick_history WHERE ai_verdict = 'LEAN';
  pct_parsed := CASE WHEN total_with_ai > 0 THEN ROUND(total_parsed::numeric / total_with_ai * 100, 1) ELSE 0 END;
  RAISE NOTICE 'D-199 v2 PARSE: % of % rows parsed (%.1f%%) — TAKE=% PASS=% LEAN=%',
    total_parsed, total_with_ai, pct_parsed, take_count, pass_count, lean_count;
  IF pct_parsed < 70 THEN
    RAISE WARNING 'D-199 v2 PARSE: coverage % still below 70%% threshold', pct_parsed;
  END IF;
END $$;
