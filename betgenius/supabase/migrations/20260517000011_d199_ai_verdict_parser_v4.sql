-- D-199 — ai_verdict parser v4: uses substring + upper() + LIKE patterns
-- instead of regex word-boundary which appeared not to match against
-- production text in v3. Diagnostic-first: probe a single row to confirm
-- text contains TAKE/LEAN/FADE substrings before applying mass UPDATE.

-- Probe: find a known-parseable sample row and inspect.
DO $$
DECLARE
  probe TEXT;
BEGIN
  SELECT RIGHT(ai_analysis, 300) INTO probe FROM public.pick_history
    WHERE ai_analysis IS NOT NULL LIMIT 1;
  RAISE NOTICE 'D-199 v4 PROBE last-300: %', LEFT(probe, 200);
END $$;

-- Use case-insensitive POSITION on uppercase-normalized tail to dodge
-- any regex word-boundary subtlety. Order: PASS > LEAN > TAKE (priority).
UPDATE public.pick_history
SET ai_verdict = CASE
  WHEN POSITION('FADE' IN UPPER(RIGHT(ai_analysis, 300))) > 0
    OR POSITION('AVOID' IN UPPER(RIGHT(ai_analysis, 300))) > 0
    THEN 'PASS'
  WHEN POSITION('LEAN' IN UPPER(RIGHT(ai_analysis, 300))) > 0
    THEN 'LEAN'
  WHEN POSITION('TAKE' IN UPPER(RIGHT(ai_analysis, 300))) > 0
    OR POSITION('RECOMMENDED' IN UPPER(RIGHT(ai_analysis, 300))) > 0
    THEN 'TAKE'
  ELSE NULL
END
WHERE ai_analysis IS NOT NULL;

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
  RAISE NOTICE 'D-199 v4 PARSE: % of % rows parsed (%s%%) — TAKE=% PASS=% LEAN=%',
    total_parsed, total_with_ai, pct_parsed::text, take_count, pass_count, lean_count;
END $$;
