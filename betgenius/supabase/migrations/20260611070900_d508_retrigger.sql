DO $$
DECLARE v_rid BIGINT; r RECORD; v_body TEXT; v_status INT;
BEGIN
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_rid;
  RAISE NOTICE '[D-508 retrigger] rid=%', v_rid;

  PERFORM pg_sleep(15);

  SELECT regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), status_code
    INTO v_body, v_status FROM net._http_response WHERE id = v_rid;
  RAISE NOTICE '[D-508 retrigger] status=% body=%', v_status, substring(v_body, 1, 400);

  RAISE NOTICE '[D-508 retrigger] checkpoint payload:';
  FOR r IN
    SELECT created_at, error_message, context->>'cap_projected_picks' AS cap,
           context->>'picks_per_prop_rate' AS rate,
           context->>'full_slate_game_count' AS slate,
           context->>'already_scored_count' AS scored,
           context->>'unscored_remaining' AS unscored,
           context->>'selected_for_this_tick' AS picked,
           context->>'running_projection' AS proj,
           context->>'projections_preview' AS preview
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '2 minutes'
      AND function_name = 'process-games-mlb'
      AND error_type = 'checkpoint'
      AND error_message = 'post_d508_volume_shard'
    ORDER BY created_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '  cap=% rate=% slate=% scored=% unscored=% picked=% proj=%',
      r.cap, r.rate, r.slate, r.scored, r.unscored, r.picked, r.proj;
    RAISE NOTICE '  preview=%', r.preview;
  END LOOP;
END $$;
