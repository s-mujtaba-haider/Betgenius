DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'All checkpoint names last 30 min by process-games-mlb:';
  FOR r IN
    SELECT error_message, count(*) AS n, max(created_at) AS latest
      FROM public.error_log
     WHERE function_name = 'process-games-mlb'
       AND error_type = 'checkpoint'
       AND created_at >= (now() - interval '30 minutes')
     GROUP BY error_message
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  step=% n=% latest=%', r.error_message, r.n, r.latest;
  END LOOP;
END $$;
