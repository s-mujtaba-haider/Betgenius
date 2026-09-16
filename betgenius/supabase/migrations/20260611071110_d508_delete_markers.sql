-- D-508 SHIP 2 verify, step 1: delete 3 mlb_scoring_progress markers for today.
-- Function will re-insert them upon successful re-scoring (idempotent).
DELETE FROM public.mlb_scoring_progress
 WHERE id IN (
   SELECT id FROM public.mlb_scoring_progress
   WHERE game_date='20260611' ORDER BY scored_at LIMIT 3
 );
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-508 verify step1] today scored count after delete:';
  FOR r IN SELECT count(*) AS n FROM public.mlb_scoring_progress WHERE game_date='20260611'
  LOOP RAISE NOTICE '  %', r.n; END LOOP;
END $$;
