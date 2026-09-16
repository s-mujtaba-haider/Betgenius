-- D-617 verify — confirm hash mechanism activated.

DO $$
DECLARE
  r RECORD;
  v_today_ymd text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  v_hashes_populated bigint; v_total bigint;
  v_d508_recent bigint; v_d508_with_d617 bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-617 verify  now=%', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — hash population
  SELECT count(*) FILTER (WHERE last_score_hash IS NOT NULL), count(*)
    INTO v_hashes_populated, v_total
    FROM public.mlb_scoring_progress WHERE game_date = v_today_ymd;
  RAISE NOTICE '';
  RAISE NOTICE '[A] mlb_scoring_progress today: % with hash / % total',
    v_hashes_populated, v_total;
  FOR r IN
    SELECT game_pk, LEFT(COALESCE(last_score_hash,'(null)'), 24) AS hash, scored_at
      FROM public.mlb_scoring_progress
     WHERE game_date = v_today_ymd
     ORDER BY scored_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=%', r.game_pk, r.hash, r.scored_at;
  END LOOP;

  -- §B — post_d508_volume_shard checkpoints with d617 telemetry
  SELECT count(*) INTO v_d508_recent
    FROM public.error_log
   WHERE error_type = 'checkpoint'
     AND error_message = 'post_d508_volume_shard'
     AND created_at >= (now() - interval '30 minutes');
  SELECT count(*) INTO v_d508_with_d617
    FROM public.error_log
   WHERE error_type = 'checkpoint'
     AND error_message = 'post_d508_volume_shard'
     AND created_at >= (now() - interval '30 minutes')
     AND context ? 'd617_cached_hashes';
  RAISE NOTICE '';
  RAISE NOTICE '[B] post_d508_volume_shard last 30m: % total, % carry d617_* fields',
    v_d508_recent, v_d508_with_d617;

  RAISE NOTICE '';
  RAISE NOTICE '[B.detail] 5 most-recent post_d508_volume_shard:';
  FOR r IN
    SELECT created_at, context
      FROM public.error_log
     WHERE error_type = 'checkpoint'
       AND error_message = 'post_d508_volume_shard'
     ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '  at=%', r.created_at;
    RAISE NOTICE '    selected=%/% already_scored=% unscored=% d617_cached=% d617_current=% d617_changed=%',
      r.context->>'selected_for_this_tick',
      r.context->>'full_slate_game_count',
      r.context->>'already_scored_count',
      r.context->>'unscored_remaining',
      COALESCE(r.context->>'d617_cached_hashes', '(missing)'),
      COALESCE(r.context->>'d617_current_hashes', '(missing)'),
      COALESCE(r.context->>'d617_hash_changed_games', '(missing)');
  END LOOP;

  -- §C — recent sonnet calls (cost is staying low?)
  RAISE NOTICE '';
  FOR r IN
    SELECT
      count(*) AS calls,
      round(coalesce(sum(computed_cost_usd),0)::numeric, 4) AS cost
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick'
      AND created_at >= (now() - interval '60 minutes')
  LOOP
    RAISE NOTICE '[C] Sonnet last 60 min: % calls $%', r.calls, r.cost;
  END LOOP;
END $$;
