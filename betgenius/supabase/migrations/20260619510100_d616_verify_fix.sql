DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '[d-fix] pick_history sport values today:';
  FOR r IN
    SELECT COALESCE(sport,'(null)') AS sport, count(*) AS n
      FROM public.pick_history
     WHERE created_at >= now()-interval '120 minutes'
     GROUP BY sport
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  sport=% count=%', r.sport, r.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[d-fix] pick_history writes (NO sport filter):';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE created_at >= now()-interval '60 minutes') AS last_60m_picks,
      count(*) FILTER (WHERE created_at >= now()-interval '120 minutes' AND created_at < now()-interval '60 minutes') AS prior_60m_picks,
      max(created_at) FILTER (WHERE created_at >= now()-interval '60 minutes') AS last_pick_60m
    FROM public.pick_history
    WHERE created_at >= now()-interval '120 minutes'
  LOOP
    RAISE NOTICE '  last 60 min: % picks (last=%)', r.last_60m_picks, r.last_pick_60m;
    RAISE NOTICE '  prior 60 min: % picks', r.prior_60m_picks;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[d-fix] recommendations_cache columns:';
  FOR r IN SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='recommendations_cache' ORDER BY ordinal_position LOOP
    RAISE NOTICE '  % (%)', r.column_name, r.data_type;
  END LOOP;
END $$;
