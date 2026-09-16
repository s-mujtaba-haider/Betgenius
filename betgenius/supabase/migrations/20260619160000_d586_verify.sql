-- D-586 verify — show shape of NBA result.breakdown via recommendations_cache,
-- which already writes it (line 2743) even though pick_history didn't.
-- Confirms (a) the data flows correctly out of scoreOneSide, and (b) what
-- the new pickHistoryRow.breakdown column will hold once NBA games resume.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-586 §A: NBA rec_cache breakdown coverage (last 90d) ========';
  FOR r IN
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE breakdown IS NOT NULL AND breakdown <> '{}'::jsonb) AS n_w_breakdown,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown IS NOT NULL AND breakdown <> '{}'::jsonb)
        / NULLIF(count(*), 0)::numeric, 1) AS pct
    FROM public.recommendations_cache
    WHERE sport='nba' AND game_date >= (now() - interval '90 days')::date
  LOOP RAISE NOTICE '[D-586 §A.1] n=% w_breakdown=% pct=%', r.n, r.n_w_breakdown, r.pct; END LOOP;

  RAISE NOTICE '======== D-586 §B: NBA recommendations_cache breakdown KEY universe ========';
  FOR r IN
    SELECT j.key AS bk_key, count(*) AS rows_with_key
    FROM public.recommendations_cache rc,
         LATERAL jsonb_each(COALESCE(rc.breakdown, '{}'::jsonb)) AS j
    WHERE rc.sport='nba' AND rc.game_date >= (now() - interval '90 days')::date
      AND rc.breakdown IS NOT NULL AND rc.breakdown <> '{}'::jsonb
    GROUP BY j.key ORDER BY count(*) DESC LIMIT 40
  LOOP RAISE NOTICE '[D-586 §B.1] %  (rows=%)', r.bk_key, r.rows_with_key; END LOOP;

  RAISE NOTICE '======== D-586 §C: sample NBA rec_cache breakdown (1 random recent pick) ========';
  FOR r IN
    SELECT player_name, prop_type, line, pick_side, confidence,
      breakdown::text AS breakdown_text
    FROM public.recommendations_cache
    WHERE sport='nba' AND game_date >= (now() - interval '90 days')::date
      AND breakdown IS NOT NULL AND breakdown <> '{}'::jsonb
    ORDER BY game_date DESC, player_name LIMIT 1
  LOOP RAISE NOTICE '[D-586 §C.1] % / % @ % (% conf=%)',
    r.player_name, r.prop_type, r.line, r.pick_side, r.confidence;
    RAISE NOTICE '[D-586 §C.1 BREAKDOWN] %', LEFT(r.breakdown_text, 1200); END LOOP;
END $$;
