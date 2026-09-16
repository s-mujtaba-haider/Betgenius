DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'now=% UTC', now();
  RAISE NOTICE '';
  RAISE NOTICE '[Verify D-624] d609_page_fetch status (latest):';
  FOR r IN
    SELECT status, LEFT(detail, 250) AS detail, created_at, metadata
      FROM public.health_status
     WHERE check_name = 'd609_page_fetch'
     ORDER BY created_at DESC LIMIT 2
  LOOP
    RAISE NOTICE '  at=% status=% detail=%', r.created_at, r.status, r.detail;
    RAISE NOTICE '    metadata=%', LEFT(r.metadata::text, 300);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[D-624 BEFORE comparison] d609_page_fetch at 16:12 UTC (pre-deploy):';
  FOR r IN
    SELECT status, LEFT(detail, 250) AS detail, created_at
      FROM public.health_status
     WHERE check_name = 'd609_page_fetch'
       AND created_at < '2026-06-19 16:30:00+00'
     ORDER BY created_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '  at=% status=% detail=%', r.created_at, r.status, r.detail;
  END LOOP;
END $$;
