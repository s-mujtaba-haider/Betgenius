DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'now=%', now();
  RAISE NOTICE '';
  RAISE NOTICE 'last 4 ticks (look for d620 fields):';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'unscored_remaining' AS unscored,
           context->>'d620_dead_hour_skipped' AS d620_dead,
           context->>'d620_pregame_window_games' AS d620_pre,
           context->>'d620_line_open_games' AS d620_open
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 4
  LOOP
    RAISE NOTICE '  at=% sel=% unsc=% d620 dead=% pre=% open=%',
      r.created_at, r.sel, r.unscored,
      COALESCE(r.d620_dead,'(MISSING)'), COALESCE(r.d620_pre,'(MISSING)'), COALESCE(r.d620_open,'(MISSING)');
  END LOOP;
END $$;
