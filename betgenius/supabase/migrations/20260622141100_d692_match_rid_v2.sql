DO $$ DECLARE r RECORD; BEGIN
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='net' AND table_name='http_request_queue'
  LOOP RAISE NOTICE 'req-queue col: %', r.column_name; END LOOP;
END $$;
