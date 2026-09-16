DO $$
DECLARE v_body TEXT; v_status INT;
BEGIN
  SET LOCAL statement_timeout TO '300s';
  PERFORM pg_sleep(90);

  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
    INTO v_body, v_status FROM net._http_response WHERE id=13972;
  RAISE NOTICE '[D-515 verify] resolve-picks response: status=%', v_status;
  IF v_body IS NOT NULL THEN
    RAISE NOTICE '  body[0..400]=%', substring(v_body, 1, 400);
  END IF;
END $$;
