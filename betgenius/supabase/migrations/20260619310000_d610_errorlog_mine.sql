-- D-610 SHIP 1 — mine error_log over the last 30 days, ranked by count.
-- Surfaces the REAL list of what breaks recurringly. D-609 coverage gaps
-- are everything count>10 NOT already mapped to a d609_* check.
--
-- READ-ONLY.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-610 SHIP 1 — error_log 30d coverage mining';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  RAISE NOTICE '';
  RAISE NOTICE '[A] error_log GROUP BY (function_name, error_type) over last 30d, count>10:';
  RAISE NOTICE '    (rank by count desc; rank only, threshold=10)';

  FOR r IN
    SELECT
      function_name,
      error_type,
      count(*) AS n,
      max(created_at) AS latest,
      min(created_at) AS earliest,
      LEFT(string_agg(DISTINCT LEFT(COALESCE(error_message,''), 80), ' || ' ORDER BY LEFT(COALESCE(error_message,''), 80)), 400) AS sample_msgs
    FROM public.error_log
    WHERE created_at >= (now() - interval '30 days')
    GROUP BY function_name, error_type
    HAVING count(*) > 10
    ORDER BY count(*) DESC
    LIMIT 40
  LOOP
    RAISE NOTICE '  fn=% type=% n=% latest=% sample=%',
      r.function_name, r.error_type, r.n, r.latest, r.sample_msgs;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[B] error_log last 24h (recent only, count>0):';
  FOR r IN
    SELECT function_name, error_type, count(*) AS n, max(created_at) AS latest
    FROM public.error_log
    WHERE created_at >= (now() - interval '24 hours')
    GROUP BY function_name, error_type
    ORDER BY count(*) DESC LIMIT 25
  LOOP
    RAISE NOTICE '  fn=% type=% n=% latest=%',
      r.function_name, r.error_type, r.n, r.latest;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'D-610 SHIP 1 mine complete.';
END $$;
