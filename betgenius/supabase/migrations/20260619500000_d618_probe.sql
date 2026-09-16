DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD'); BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-618 probe — hash sensitivity vs real re-score rate';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'now=%  today=%', now(), v_today;
  RAISE NOTICE '';

  FOR r IN
    SELECT
      count(*) AS total_ticks,
      count(*) FILTER (WHERE (context->>'d617_cached_hashes')::int > 0) AS post_bootstrap_ticks,
      count(*) FILTER (WHERE (context->>'d617_hash_changed_games')::int > 0) AS ticks_with_change,
      COALESCE(sum((context->>'d617_hash_changed_games')::int), 0) AS total_hash_change_events,
      COALESCE(sum((context->>'selected_for_this_tick')::int), 0) AS total_games_selected,
      min(created_at) AS earliest, max(created_at) AS latest
    FROM public.error_log
    WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
      AND created_at::date = (now() AT TIME ZONE 'America/New_York')::date
      AND context ? 'd617_cached_hashes'
  LOOP
    RAISE NOTICE '[A] d617 checkpoint rollup (today, NY date):';
    RAISE NOTICE '  total ticks with d617 fields: %', r.total_ticks;
    RAISE NOTICE '  ticks AFTER bootstrap (d617_cached>0): %', r.post_bootstrap_ticks;
    RAISE NOTICE '  ticks WITH hash change firing: % (of % post-bootstrap)',
      r.ticks_with_change, r.post_bootstrap_ticks;
    RAISE NOTICE '  total games-selected-for-rescore today: %', r.total_games_selected;
    RAISE NOTICE '  earliest=% latest=%', r.earliest, r.latest;
  END LOOP;
  RAISE NOTICE '';

  RAISE NOTICE '[B] last 16 d617 ticks:';
  FOR r IN
    SELECT created_at,
           context->>'selected_for_this_tick' AS sel,
           context->>'d617_cached_hashes' AS cached,
           context->>'d617_current_hashes' AS curr,
           context->>'d617_hash_changed_games' AS chg
      FROM public.error_log
     WHERE error_type='checkpoint' AND error_message='post_d508_volume_shard'
       AND created_at::date = (now() AT TIME ZONE 'America/New_York')::date
       AND context ? 'd617_cached_hashes'
     ORDER BY created_at DESC LIMIT 16
  LOOP
    RAISE NOTICE '  at=% sel=% cached=% curr=% changed=%', r.created_at, r.sel, r.cached, r.curr, r.chg;
  END LOOP;
  RAISE NOTICE '';

  RAISE NOTICE '[C] picks_created today (hourly bucket):';
  FOR r IN
    SELECT date_trunc('hour', created_at) AS hour, count(*) AS picks_created
      FROM public.pick_history
     WHERE created_at >= (now() AT TIME ZONE 'America/New_York')::date
     GROUP BY date_trunc('hour', created_at)
     ORDER BY date_trunc('hour', created_at)
  LOOP
    RAISE NOTICE '  hour=% picks=%', r.hour, r.picks_created;
  END LOOP;
  RAISE NOTICE '';

  FOR r IN
    SELECT
      count(*) AS calls,
      round(coalesce(sum(computed_cost_usd),0)::numeric, 4) AS cost,
      min(created_at) AS first_call, max(created_at) AS last_call
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick'
      AND created_at::date = (now() AT TIME ZONE 'America/New_York')::date
  LOOP
    RAISE NOTICE '[D] Sonnet today (mlb_pick): % calls $% (first=% last=%)',
      r.calls, r.cost, r.first_call, r.last_call;
  END LOOP;
  RAISE NOTICE '';

  RAISE NOTICE '[E] odds movement per prop today (top 10 by distinct odds count):';
  FOR r IN
    SELECT player_name, prop_type, line, pick_side, bookmaker,
           count(DISTINCT odds) AS distinct_odds_today,
           min(odds) AS min_odds, max(odds) AS max_odds,
           count(*) AS rows_today
      FROM public.props_cache
     WHERE sport='mlb' AND game_date = v_today
     GROUP BY player_name, prop_type, line, pick_side, bookmaker
     HAVING count(*) > 1
     ORDER BY count(DISTINCT odds) DESC LIMIT 10
  LOOP
    RAISE NOTICE '  %|%|line=%|%|%: distinct_odds=% min=% max=% rows=%',
      r.player_name, r.prop_type, r.line, r.pick_side, r.bookmaker,
      r.distinct_odds_today, r.min_odds, r.max_odds, r.rows_today;
  END LOOP;
  RAISE NOTICE '';

  FOR r IN
    SELECT count(*) AS total_rows,
           count(DISTINCT (player_name, prop_type, line, pick_side, bookmaker)) AS distinct_props,
           round(100.0 * (count(*) - count(DISTINCT (player_name, prop_type, line, pick_side, bookmaker)))::numeric
                       / NULLIF(count(*),0), 2) AS pct_duplicates
      FROM public.props_cache
     WHERE sport='mlb' AND game_date = v_today
  LOOP
    RAISE NOTICE '[F] props_cache today: % total rows, % distinct tuples, % %% are duplicates',
      r.total_rows, r.distinct_props, r.pct_duplicates;
  END LOOP;
  RAISE NOTICE '';

  RAISE NOTICE '[H] odds movement distribution today — distinct_odds count per prop tuple:';
  FOR r IN
    SELECT distinct_odds_count, count(*) AS prop_tuples
      FROM (
        SELECT player_name, prop_type, line, pick_side, bookmaker,
               count(DISTINCT odds) AS distinct_odds_count
          FROM public.props_cache
         WHERE sport='mlb' AND game_date = v_today
         GROUP BY player_name, prop_type, line, pick_side, bookmaker
      ) s
     GROUP BY distinct_odds_count
     ORDER BY distinct_odds_count
  LOOP
    RAISE NOTICE '  distinct_odds_count=% : % prop tuples', r.distinct_odds_count, r.prop_tuples;
  END LOOP;
  RAISE NOTICE '';

  RAISE NOTICE '[I] line movement distribution today — distinct_line count per prop+side+book tuple:';
  FOR r IN
    SELECT distinct_line_count, count(*) AS prop_tuples
      FROM (
        SELECT player_name, prop_type, pick_side, bookmaker,
               count(DISTINCT line) AS distinct_line_count
          FROM public.props_cache
         WHERE sport='mlb' AND game_date = v_today
         GROUP BY player_name, prop_type, pick_side, bookmaker
      ) s
     GROUP BY distinct_line_count
     ORDER BY distinct_line_count
  LOOP
    RAISE NOTICE '  distinct_line_count=% : % prop+side+book tuples', r.distinct_line_count, r.prop_tuples;
  END LOOP;

END $$;
