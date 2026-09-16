DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'now=%', now();

  RAISE NOTICE '';
  RAISE NOTICE '[ghost-re-confirm] mlb_scoring_progress for game_pk=823853:';
  FOR r IN
    SELECT game_pk, COALESCE(last_score_hash,'(null)') AS hash, scored_at, tick_label
      FROM public.mlb_scoring_progress
     WHERE game_pk = 823853
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=% tick=%', r.game_pk, r.hash, r.scored_at, r.tick_label;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[latest tick] post_d508_volume_shard last 3:';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'unscored_remaining' AS unscored,
           context->>'d617_cached_hashes' AS d617_cached,
           context->>'d617_current_hashes' AS d617_curr,
           context->>'d617_hash_changed_games' AS d617_chg,
           context->>'d619_ghost_count' AS d619_ghosts
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
       AND context ? 'd619_ghost_count'
     ORDER BY created_at DESC LIMIT 3
  LOOP
    RAISE NOTICE '  at=% sel=% unsc=% d617c=% d617cu=% d617chg=% d619ghosts=%',
      r.created_at, r.sel, r.unscored, r.d617_cached, r.d617_curr, r.d617_chg, r.d619_ghosts;
  END LOOP;
END $$;
