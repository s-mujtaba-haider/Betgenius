DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-620 verify — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  RAISE NOTICE '';
  RAISE NOTICE '[1] last 6 post_d508_volume_shard ticks (D-620 telemetry):';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'unscored_remaining' AS unscored,
           context->>'d617_hash_changed_games' AS d617_chg,
           context->>'d620_line_open_games' AS d620_open,
           context->>'d620_pregame_window_games' AS d620_pregame,
           context->>'d620_dead_hour_skipped' AS d620_dead,
           context->>'d620_dead_hours_disabled' AS d620_revert
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 6
  LOOP
    RAISE NOTICE '  at=% sel=% unsc=% d617chg=% d620 open=% pregame=% dead=% revert=%',
      r.created_at, r.sel, r.unscored, r.d617_chg,
      COALESCE(r.d620_open,'(missing)'), COALESCE(r.d620_pregame,'(missing)'),
      COALESCE(r.d620_dead,'(missing)'), COALESCE(r.d620_revert,'(missing)');
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[2] Sonnet last 15 min (post-D-620 deploy):';
  FOR r IN
    SELECT
      count(*) AS calls,
      coalesce(sum(computed_cost_usd),0)::numeric(10,4) AS cost,
      max(created_at) AS last_call
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick' AND created_at >= now()-interval '15 minutes'
  LOOP
    RAISE NOTICE '  last 15 min: % calls $% (last=%)', r.calls, r.cost, r.last_call;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[3] Sonnet TODAY (cumulative, to date):';
  FOR r IN
    SELECT
      count(*) AS calls,
      coalesce(sum(computed_cost_usd),0)::numeric(10,4) AS cost
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick'
      AND created_at::date = (now() AT TIME ZONE 'America/New_York')::date
  LOOP
    RAISE NOTICE '  today: % calls $%', r.calls, r.cost;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[4] mlb_scoring_progress today (hash population):';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE last_score_hash IS NOT NULL AND last_score_hash <> 'NOPROPS') AS with_real_hash,
      count(*) FILTER (WHERE last_score_hash = 'NOPROPS') AS ghosts_with_sentinel,
      count(*) AS total
    FROM public.mlb_scoring_progress
    WHERE game_date = v_today
  LOOP
    RAISE NOTICE '  real_hash=% / NOPROPS_sentinel=% / total=%', r.with_real_hash, r.ghosts_with_sentinel, r.total;
  END LOOP;
END $$;
