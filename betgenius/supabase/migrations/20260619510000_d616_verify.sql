DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-616 verify (now D-617 live, same purpose) — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- (a) mlb_scoring_progress hashes today
  RAISE NOTICE '';
  RAISE NOTICE '[a] mlb_scoring_progress today — hash population:';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE last_score_hash IS NOT NULL) AS with_hash,
      count(*) AS total,
      min(scored_at) AS first_scored, max(scored_at) AS last_scored
    FROM public.mlb_scoring_progress
    WHERE game_date = v_today
  LOOP
    RAISE NOTICE '  with_hash=% / total=% (first=% last=%)',
      r.with_hash, r.total, r.first_scored, r.last_scored;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[a.detail] 14 rows today:';
  FOR r IN
    SELECT game_pk,
           CASE WHEN last_score_hash IS NULL THEN '(null)' ELSE LEFT(last_score_hash, 16) END AS hash,
           scored_at, tick_label
      FROM public.mlb_scoring_progress
     WHERE game_date = v_today
     ORDER BY scored_at DESC LIMIT 14
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=% tick=%',
      r.game_pk, r.hash, r.scored_at, r.tick_label;
  END LOOP;

  -- (b) post_d508_volume_shard checkpoints last 60 min (D-617's equivalent of d616_hash_skip)
  RAISE NOTICE '';
  RAISE NOTICE '[b] post_d508_volume_shard checkpoints last 60 min:';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'already_scored_count' AS already,
           context->>'unscored_remaining' AS unscored,
           context->>'d617_cached_hashes' AS d617_cached,
           context->>'d617_current_hashes' AS d617_curr,
           context->>'d617_hash_changed_games' AS d617_chg
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
       AND created_at >= now() - interval '60 minutes'
     ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  at=% sel=% already=% unscored=% d617_cached=% d617_curr=% d617_chg=%',
      r.created_at, r.sel, r.already, r.unscored,
      COALESCE(r.d617_cached,'(missing)'), COALESCE(r.d617_curr,'(missing)'), COALESCE(r.d617_chg,'(missing)');
  END LOOP;

  -- (b.aux) Confirm no legacy d616_hash_skip checkpoint exists (since D-617 deleted that block)
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS legacy_d616_skip_rows
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='d616_hash_skip'
       AND created_at >= now() - interval '24 hours'
  LOOP
    RAISE NOTICE '[b.aux] legacy d616_hash_skip rows last 24h (expect 0 since D-617 deleted that block): %',
      r.legacy_d616_skip_rows;
  END LOOP;

  -- (c) Sonnet usage last 60 min vs prior 60 min
  RAISE NOTICE '';
  FOR r IN
    SELECT
      coalesce(sum(computed_cost_usd) FILTER (WHERE created_at >= now()-interval '60 minutes'),0)::numeric(10,4) AS last_60m_usd,
      count(*) FILTER (WHERE created_at >= now()-interval '60 minutes') AS last_60m_calls,
      coalesce(sum(computed_cost_usd) FILTER (WHERE created_at >= now()-interval '120 minutes' AND created_at < now()-interval '60 minutes'),0)::numeric(10,4) AS prior_60m_usd,
      count(*) FILTER (WHERE created_at >= now()-interval '120 minutes' AND created_at < now()-interval '60 minutes') AS prior_60m_calls
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick' AND created_at >= now()-interval '120 minutes'
  LOOP
    RAISE NOTICE '[c] Sonnet (mlb_pick):';
    RAISE NOTICE '    last 60 min:  % calls $%', r.last_60m_calls, r.last_60m_usd;
    RAISE NOTICE '    prior 60 min: % calls $%', r.prior_60m_calls, r.prior_60m_usd;
    IF r.prior_60m_calls > 0 THEN
      RAISE NOTICE '    drop: % calls ($% absolute, % %% relative)',
        r.prior_60m_calls - r.last_60m_calls,
        r.prior_60m_usd - r.last_60m_usd,
        round(100.0 * (1.0 - r.last_60m_calls::numeric / NULLIF(r.prior_60m_calls,0)), 1);
    END IF;
  END LOOP;

  -- (d) pick_history writes last 60 min — picks still being served
  RAISE NOTICE '';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE created_at >= now()-interval '60 minutes') AS last_60m_picks,
      count(*) FILTER (WHERE created_at >= now()-interval '120 minutes' AND created_at < now()-interval '60 minutes') AS prior_60m_picks,
      min(created_at) FILTER (WHERE created_at >= now()-interval '60 minutes') AS first_pick_60m,
      max(created_at) FILTER (WHERE created_at >= now()-interval '60 minutes') AS last_pick_60m
    FROM public.pick_history
    WHERE created_at >= now()-interval '120 minutes'
      AND sport = 'mlb'
  LOOP
    RAISE NOTICE '[d] pick_history (mlb) writes:';
    RAISE NOTICE '    last 60 min:  % picks (first=% last=%)', r.last_60m_picks, r.first_pick_60m, r.last_pick_60m;
    RAISE NOTICE '    prior 60 min: % picks', r.prior_60m_picks;
  END LOOP;

END $$;
