DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'now=% UTC', now();
  RAISE NOTICE '';
  RAISE NOTICE '[D-620 LIVE — last 5 ticks]';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'unscored_remaining' AS unscored,
           context->>'d617_hash_changed_games' AS d617_chg,
           context->>'d620_dead_hour_skipped' AS d620_dead,
           context->>'d620_pregame_window_games' AS d620_pre,
           context->>'d620_line_open_games' AS d620_open
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '  at=% sel=% unsc=% d617chg=% d620 dead=% pre=% open=%',
      r.created_at, r.sel, r.unscored, r.d617_chg,
      COALESCE(r.d620_dead,'(MISSING)'),
      COALESCE(r.d620_pre,'(MISSING)'),
      COALESCE(r.d620_open,'(MISSING)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[Sonnet last 10 min]';
  FOR r IN
    SELECT count(*) AS calls, coalesce(sum(computed_cost_usd),0)::numeric(10,4) AS cost,
           max(created_at) AS last_call
      FROM public.sonnet_usage_log
     WHERE source = 'mlb_pick' AND created_at >= now()-interval '10 minutes'
  LOOP
    RAISE NOTICE '  % calls $% (last_call=%)', r.calls, r.cost, r.last_call;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[Sonnet last 5 min — should be 0 if D-620 quiet]';
  FOR r IN
    SELECT count(*) AS calls, coalesce(sum(computed_cost_usd),0)::numeric(10,4) AS cost
      FROM public.sonnet_usage_log
     WHERE source = 'mlb_pick' AND created_at >= now()-interval '5 minutes'
  LOOP
    RAISE NOTICE '  % calls $%', r.calls, r.cost;
  END LOOP;
END $$;
