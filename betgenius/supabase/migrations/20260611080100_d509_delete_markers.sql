-- D-509 SHIP 2 verify, step 1: clear today's 8 markers so a fresh
-- score-pass writes new rec_cache rows under D-509 logic. Idempotent.
DELETE FROM public.mlb_scoring_progress WHERE game_date='20260611';
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-509 verify step1] cleared markers for 20260611';
  FOR r IN SELECT count(*) AS n FROM public.mlb_scoring_progress WHERE game_date='20260611'
  LOOP RAISE NOTICE '  scored_count=%', r.n; END LOOP;
END $$;
