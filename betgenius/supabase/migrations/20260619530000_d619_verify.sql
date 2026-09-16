DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-619 verify — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- (1) Last 6 post_d508_volume_shard ticks with d619 telemetry
  RAISE NOTICE '';
  RAISE NOTICE '[1] last 6 post_d508_volume_shard ticks (d619 telemetry):';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'unscored_remaining' AS unscored,
           context->>'d617_cached_hashes' AS d617_cached,
           context->>'d617_current_hashes' AS d617_curr,
           context->>'d617_hash_changed_games' AS d617_chg,
           context->>'d619_ghost_count' AS d619_ghosts,
           context->>'d619_odds_bucket_cents' AS d619_bucket
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 6
  LOOP
    RAISE NOTICE '  at=% sel=% unsc=% d617c=% d617cu=% d617chg=% d619ghosts=% bucket=%¢',
      r.created_at, r.sel, r.unscored,
      COALESCE(r.d617_cached,'-'), COALESCE(r.d617_curr,'-'), COALESCE(r.d617_chg,'-'),
      COALESCE(r.d619_ghosts,'(missing)'), COALESCE(r.d619_bucket,'(missing)');
  END LOOP;

  -- (2) Ghost games detail from latest tick
  RAISE NOTICE '';
  RAISE NOTICE '[2] ghost games from MOST RECENT tick (D-619 telemetry):';
  FOR r IN
    SELECT created_at,
           context->'d619_ghost_games' AS ghost_games,
           context->'d619_props_matchup_keys_sample' AS props_keys_sample
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
       AND context ? 'd619_ghost_count'
     ORDER BY created_at DESC LIMIT 1
  LOOP
    RAISE NOTICE '  at=%', r.created_at;
    RAISE NOTICE '    ghost_games=%', r.ghost_games;
    RAISE NOTICE '    props_keys_sample (normalized)=%', r.props_keys_sample;
  END LOOP;

  -- (3) mlb_scoring_progress — did the ghost (823853) get a NOPROPS hash yet?
  RAISE NOTICE '';
  RAISE NOTICE '[3] mlb_scoring_progress hash for ghost game game_pk=823853:';
  FOR r IN
    SELECT game_pk, last_score_hash, scored_at, tick_label
      FROM public.mlb_scoring_progress
     WHERE game_pk = 823853
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=% tick=%',
      r.game_pk, COALESCE(r.last_score_hash, '(null)'), r.scored_at, r.tick_label;
  END LOOP;

  -- (4) Sonnet cost LAST 15 min — should approach $0 post-deploy
  RAISE NOTICE '';
  FOR r IN
    SELECT
      count(*) AS calls,
      coalesce(sum(computed_cost_usd),0)::numeric(10,4) AS cost,
      max(created_at) AS last_call
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick' AND created_at >= now()-interval '15 minutes'
  LOOP
    RAISE NOTICE '[4] Sonnet last 15 min: % calls $% (last=%)', r.calls, r.cost, r.last_call;
  END LOOP;

  -- (5) total hash population today
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) FILTER (WHERE last_score_hash IS NOT NULL) AS with_hash,
           count(*) AS total
      FROM public.mlb_scoring_progress
     WHERE game_date = v_today
  LOOP
    RAISE NOTICE '[5] mlb_scoring_progress today: % with hash / % total', r.with_hash, r.total;
  END LOOP;
END $$;
