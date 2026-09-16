DO $$
DECLARE v_body TEXT; v_status INT; r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';
  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code INTO v_body, v_status
   FROM net._http_response WHERE id = 14001;
  RAISE NOTICE '[D-515 observe4b] rid=14001 status=% body_null=%', v_status, (v_body IS NULL);
  IF v_body IS NOT NULL THEN
    FOR i IN 1..14 LOOP
      EXIT WHEN (i-1)*400 >= length(v_body);
      RAISE NOTICE 'body[%]: %', i, substring(v_body, (i-1)*400+1, 400);
    END LOOP;
  END IF;

  -- Also pull fresh health_status rows for the 5 new checks
  RAISE NOTICE '[D-515 observe4b] latest health_status rows for 5 new checks:';
  FOR r IN
    SELECT check_name, status, left(detail, 250) AS detail, created_at
    FROM public.health_status
    WHERE check_name IN ('props_cache_write_velocity','clv_stamp_velocity',
                         'mlb_scoring_progress_velocity','odds_api_quota_low','mlb_stats_api_failure')
    ORDER BY check_name, created_at DESC
    LIMIT 10
  LOOP RAISE NOTICE '  check=% status=% at=% detail=%',
    r.check_name, r.status, r.created_at, r.detail; END LOOP;
END $$;
