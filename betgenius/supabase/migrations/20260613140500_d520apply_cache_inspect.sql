-- D-520-APPLY SHIP 2 — inspect recommendations_cache more carefully
-- E.2 returned 0 batter picks even though prop_type exists. Either the
-- cache is empty, or prop_type values use a different naming convention.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '[D-520-APPLY §E.4] recommendations_cache row count + age:';
  FOR r IN
    SELECT count(*) AS n,
           MIN(created_at) AS oldest, MAX(created_at) AS newest
    FROM public.recommendations_cache WHERE sport='mlb'
  LOOP RAISE NOTICE '  n=% oldest=% newest=%', r.n, r.oldest, r.newest; END LOOP;

  RAISE NOTICE '[D-520-APPLY §E.5] prop_type distinct values:';
  FOR r IN
    SELECT prop_type, count(*) AS n
    FROM public.recommendations_cache WHERE sport='mlb'
    GROUP BY prop_type ORDER BY n DESC LIMIT 20
  LOOP RAISE NOTICE '  prop_type=% n=%', r.prop_type, r.n; END LOOP;

  RAISE NOTICE '[D-520-APPLY §E.6] sample cache batter rows with new factor:';
  FOR r IN
    SELECT prop_type, confidence,
           (breakdown ? 'score_batter_line_hit_rate') AS has_new_factor,
           breakdown->>'last10_hit_rate_pct' AS l10,
           breakdown->>'score_batter_line_hit_rate' AS lhr_score,
           created_at
    FROM public.recommendations_cache
    WHERE sport='mlb' AND breakdown IS NOT NULL
    ORDER BY created_at DESC LIMIT 5
  LOOP RAISE NOTICE '  prop_type=% conf=% has_new_factor=% l10=% lhr=% created=%',
    r.prop_type, r.confidence, r.has_new_factor, r.l10, r.lhr_score, r.created_at;
  END LOOP;
END $$;
