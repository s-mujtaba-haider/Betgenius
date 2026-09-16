-- D-199 — ai_verdict parser v3: corrects v2 which inadvertently NULLed
-- all rows via a buggy WITH/CTE pattern inside the UPDATE SET subquery.
-- v3 uses direct expressions referencing the outer-row ai_analysis.

UPDATE public.pick_history
SET ai_verdict = CASE
  -- PASS / FADE / AVOID first (specific)
  WHEN RIGHT(ai_analysis, 300) ~* '\b(FADE|AVOID)\b' THEN 'PASS'
  -- LEAN (broad — anywhere in final 300 chars)
  WHEN RIGHT(ai_analysis, 300) ~* '\bLEAN\b' THEN 'LEAN'
  -- TAKE (broadest — last by priority since TAKE can appear in other contexts)
  WHEN RIGHT(ai_analysis, 300) ~* '\bTAKE\b' THEN 'TAKE'
  -- RECOMMENDED rare variant
  WHEN RIGHT(ai_analysis, 300) ~* '\bRECOMMENDED\b' THEN 'TAKE'
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
  RAISE NOTICE 'D-199 v3 PARSE: % of % rows parsed (%.1f%%) — TAKE=% PASS=% LEAN=%',
    total_parsed, total_with_ai, pct_parsed, take_count, pass_count, lean_count;
END $$;
