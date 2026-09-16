-- D-616 verify v2 — re-query after relaxed-gate redeploy.

DO $$
DECLARE
  r RECORD;
  v_today_ymd text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  v_hashes_populated bigint; v_total_today bigint;
  v_games_skipped bigint; v_props_skipped bigint;
  v_sonnet_last bigint; v_sonnet_last_cost numeric;
  v_picks_last bigint;
  v_n_checkpoints_total bigint;
  v_now timestamptz := now();
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-616 verify v2  now=%', v_now;
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — hash coverage
  SELECT
    count(*) FILTER (WHERE last_score_hash IS NOT NULL),
    count(*)
    INTO v_hashes_populated, v_total_today
    FROM public.mlb_scoring_progress
   WHERE game_date = v_today_ymd;
  RAISE NOTICE '';
  RAISE NOTICE '[A] today hashes: % with hash / % total games', v_hashes_populated, v_total_today;

  -- §B — process-games-mlb ticks since 12:30 UTC (after the slate rollover)
  RAISE NOTICE '';
  RAISE NOTICE '[B] process-games-mlb checkpoints last 30 min (any type):';
  FOR r IN
    SELECT error_message, created_at, LEFT(context::text, 200) AS ctx_excerpt
      FROM public.error_log
     WHERE function_name = 'process-games-mlb'
       AND error_type = 'checkpoint'
       AND created_at >= (now() - interval '30 minutes')
       AND error_message IN ('d616_hash_skip', 'post_d473_progress_marked', 'entered_main_handler')
     ORDER BY created_at DESC LIMIT 15
  LOOP
    RAISE NOTICE '  at=% type=% ctx=%', r.created_at, r.error_message, r.ctx_excerpt;
  END LOOP;

  -- §C — d616_hash_skip cumulative (all-time)
  SELECT count(*) INTO v_n_checkpoints_total
    FROM public.error_log
   WHERE error_type = 'checkpoint' AND error_message = 'd616_hash_skip';
  RAISE NOTICE '';
  RAISE NOTICE '[C] d616_hash_skip checkpoints all-time: %', v_n_checkpoints_total;

  IF v_n_checkpoints_total > 0 THEN
    SELECT
      coalesce(sum((context->>'games_skipped')::bigint), 0),
      coalesce(sum((context->>'props_skipped')::bigint), 0)
      INTO v_games_skipped, v_props_skipped
      FROM public.error_log
     WHERE error_type = 'checkpoint' AND error_message = 'd616_hash_skip'
       AND created_at >= (now() - interval '60 minutes');
    RAISE NOTICE '  cumulative last 60 min: games_skipped=% props_skipped=%',
      v_games_skipped, v_props_skipped;
  END IF;

  -- §D — Sonnet last 60 min
  SELECT count(*), round(coalesce(sum(computed_cost_usd),0)::numeric,4)
    INTO v_sonnet_last, v_sonnet_last_cost
    FROM public.sonnet_usage_log
   WHERE source = 'mlb_pick' AND created_at >= (now() - interval '60 minutes');
  RAISE NOTICE '';
  RAISE NOTICE '[D] sonnet_usage_log last 60 min: % calls $%', v_sonnet_last, v_sonnet_last_cost;

  -- §E — pick writes last 60 min
  SELECT count(*) INTO v_picks_last
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false
     AND created_at >= (now() - interval '60 minutes');
  RAISE NOTICE '[E] pick_history mlb writes last 60 min: %', v_picks_last;
END $$;
