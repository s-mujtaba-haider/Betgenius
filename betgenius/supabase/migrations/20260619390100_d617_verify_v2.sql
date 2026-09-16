DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE 'now=%', now();
  RAISE NOTICE 'most recent 4 post_d508 checkpoints (showing d617 fields):';
  FOR r IN
    SELECT created_at, context->>'d617_cached_hashes' AS d617_cached,
           context->>'d617_current_hashes' AS d617_current,
           context->>'d617_hash_changed_games' AS d617_changed,
           context->>'selected_for_this_tick' AS selected,
           context->>'already_scored_count' AS already
      FROM public.error_log
     WHERE error_type = 'checkpoint' AND error_message = 'post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 4
  LOOP
    RAISE NOTICE '  at=% sel=% already=% d617_cached=% d617_current=% d617_changed=%',
      r.created_at, r.selected, r.already,
      COALESCE(r.d617_cached,'(null)'), COALESCE(r.d617_current,'(null)'), COALESCE(r.d617_changed,'(null)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'mlb_scoring_progress today hashes populated:';
  FOR r IN
    SELECT count(*) FILTER (WHERE last_score_hash IS NOT NULL) AS with_hash,
           count(*) AS total
      FROM public.mlb_scoring_progress
     WHERE game_date = to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD')
  LOOP
    RAISE NOTICE '  with_hash=% / total=%', r.with_hash, r.total;
  END LOOP;
END $$;
