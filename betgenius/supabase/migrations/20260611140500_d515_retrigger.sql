DO $$
DECLARE v_rid BIGINT; r RECORD; v_body TEXT; v_status INT;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/sonnet-health-monitor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_rid;
  RAISE NOTICE '[D-515 re-verify] trigger rid=%', v_rid;

  PERFORM pg_sleep(15);

  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
    INTO v_body, v_status FROM net._http_response WHERE id = v_rid;
  RAISE NOTICE '[D-515 re-verify] status=%', v_status;
  IF v_body IS NOT NULL THEN
    FOR i IN 1..12 LOOP
      EXIT WHEN (i-1)*400 >= length(v_body);
      RAISE NOTICE 'body[%]: %', i, substring(v_body, (i-1)*400+1, 400);
    END LOOP;
  END IF;
END $$;
