DO $$ DECLARE r RECORD; v_hashes bigint; v_total bigint; BEGIN
  RAISE NOTICE 'now=%', now();
  RAISE NOTICE '';
  RAISE NOTICE 'last 8 post_d508_volume_shard with d617 fields:';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'unscored_remaining' AS unscored,
           context->>'d617_cached_hashes' AS d617_cached,
           context->>'d617_current_hashes' AS d617_current,
           context->>'d617_hash_changed_games' AS d617_changed
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 8
  LOOP
    RAISE NOTICE '  at=% sel=%/14 unscored=% d617_cached=% d617_current=% d617_changed=%',
      r.created_at, r.sel, r.unscored,
      COALESCE(r.d617_cached,'-'), COALESCE(r.d617_current,'-'), COALESCE(r.d617_changed,'-');
  END LOOP;

  SELECT count(*) FILTER (WHERE last_score_hash IS NOT NULL), count(*)
    INTO v_hashes, v_total
    FROM public.mlb_scoring_progress
   WHERE game_date = to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  RAISE NOTICE '';
  RAISE NOTICE 'today hashes populated: % / %', v_hashes, v_total;

  RAISE NOTICE '';
  RAISE NOTICE 'sample 5 mlb_scoring_progress rows today:';
  FOR r IN
    SELECT game_pk, LEFT(COALESCE(last_score_hash,'(null)'), 24) AS hash, scored_at
      FROM public.mlb_scoring_progress
     WHERE game_date = to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD')
     ORDER BY scored_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=%', r.game_pk, r.hash, r.scored_at;
  END LOOP;

  FOR r IN
    SELECT
      coalesce(sum(computed_cost_usd) FILTER (WHERE created_at >= now()-interval '15 minutes'),0)::numeric(10,4) AS last_15m,
      count(*) FILTER (WHERE created_at >= now()-interval '15 minutes') AS last_15m_n
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick' AND created_at >= now()-interval '15 minutes'
  LOOP
    RAISE NOTICE '';
    RAISE NOTICE 'Sonnet last 15m: % calls $%', r.last_15m_n, r.last_15m;
  END LOOP;
END $$;
