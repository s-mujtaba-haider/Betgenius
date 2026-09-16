DO $$ DECLARE r RECORD; v_keys TEXT; BEGIN
  FOR r IN
    SELECT id, status_code, content
    FROM net._http_response
    WHERE created >= NOW() - INTERVAL '5 minutes'
    ORDER BY created DESC LIMIT 1
  LOOP
    -- list top-level JSON keys
    SELECT string_agg(k, ', ') INTO v_keys
    FROM jsonb_object_keys(r.content::JSONB) AS k;
    RAISE NOTICE 'resp id=% top-keys: %', r.id, v_keys;

    -- enumerate each key + value brief
    DECLARE c JSONB := r.content::JSONB; BEGIN
      RAISE NOTICE '  processed: %', c->>'processed';
      RAISE NOTICE '  resolved: %', c->>'resolved';
      RAISE NOTICE '  voided: %', c->>'voided';
      RAISE NOTICE '  unresolved: %', c->>'unresolved';
      RAISE NOTICE '  skipped: %', c->>'skipped';
      RAISE NOTICE '  errors: %', c->>'errors';
      RAISE NOTICE '  total_seen: %', c->>'total_seen';
      RAISE NOTICE '  success: %', c->>'success';
    END;
  END LOOP;
END $$;
