DO $$ DECLARE r RECORD; BEGIN
  FOR r IN
    SELECT id, status_code, content
    FROM net._http_response
    WHERE created >= NOW() - INTERVAL '10 minutes'
    ORDER BY created DESC LIMIT 2
  LOOP
    DECLARE c JSONB := r.content::JSONB; BEGIN
      RAISE NOTICE 'resp id=% status=%', r.id, r.status_code;
      RAISE NOTICE '  claimed=% dispatched=% failed=% skipped=% success=% duration_ms=%',
        c->>'claimed', c->>'dispatched', c->>'failed', c->>'skipped', c->>'success', c->>'duration_ms';
    END;
  END LOOP;
END $$;
