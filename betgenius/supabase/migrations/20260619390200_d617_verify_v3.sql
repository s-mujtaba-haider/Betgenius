DO $$ DECLARE r RECORD; v_hashes bigint; v_total bigint; BEGIN
  RAISE NOTICE 'now=%', now();
  RAISE NOTICE '';
  RAISE NOTICE 'last 6 post_d508_volume_shard with d617 fields:';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'already_scored_count' AS already,
           context->>'unscored_remaining' AS unscored,
           context->>'d617_cached_hashes' AS d617_cached,
           context->>'d617_current_hashes' AS d617_current,
           context->>'d617_hash_changed_games' AS d617_changed
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 6
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

  -- Sonnet last 30 min vs prior 30 min (cost monitor)
  FOR r IN
    SELECT
      coalesce(sum(computed_cost_usd) FILTER (WHERE created_at >= now()-interval '30 minutes'),0)::numeric(10,4) AS last_30m,
      count(*) FILTER (WHERE created_at >= now()-interval '30 minutes') AS last_30m_n,
      coalesce(sum(computed_cost_usd) FILTER (WHERE created_at >= now()-interval '60 minutes' AND created_at < now()-interval '30 minutes'),0)::numeric(10,4) AS prior_30m,
      count(*) FILTER (WHERE created_at >= now()-interval '60 minutes' AND created_at < now()-interval '30 minutes') AS prior_30m_n
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick' AND created_at >= now()-interval '60 minutes'
  LOOP
    RAISE NOTICE 'Sonnet last 30m: % calls $% | prior 30m: % calls $%',
      r.last_30m_n, r.last_30m, r.prior_30m_n, r.prior_30m;
  END LOOP;
END $$;
