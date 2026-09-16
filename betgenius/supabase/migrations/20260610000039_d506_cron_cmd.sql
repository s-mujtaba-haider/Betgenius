DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-506] resolve-picks cron command full inspect:';
  FOR r IN
    SELECT jobid, jobname, schedule, length(command) AS clen,
           command AS cmd, active
    FROM cron.job WHERE jobname ILIKE '%resolve%' OR jobname ILIKE '%pick%'
    ORDER BY jobid
  LOOP
    RAISE NOTICE 'jobid=% name=% active=% sched=% clen=%',
      r.jobid, r.jobname, r.active, r.schedule, r.clen;
    -- Hash to be safer if command contains tokens
    RAISE NOTICE '  cmd_sha=%', md5(r.cmd);
    -- Show command split by newline so the URL/method line is visible
    DECLARE
      line TEXT;
      lines TEXT[] := regexp_split_to_array(r.cmd, E'\n');
      i INT;
    BEGIN
      FOR i IN 1..array_length(lines, 1) LOOP
        line := lines[i];
        IF length(line) > 0 THEN
          -- Redact anything that looks like a Bearer token
          line := regexp_replace(line, 'Bearer\s+[A-Za-z0-9._-]{20,}', 'Bearer <redacted>', 'g');
          line := regexp_replace(line, 'apikey[''"][^''"]*[''"]', 'apikey<redacted>', 'g');
          RAISE NOTICE '   L%: %', i, line;
        END IF;
      END LOOP;
    END;
  END LOOP;
END $$;
