-- D-501 SHIP 1 v2 — fix schema mismatch (props_cache lacks game_pk column).
-- Re-runs the per-stage counts.
DO $$
DECLARE
  v_et_date TEXT := to_char(now() AT TIME ZONE 'America/New_York', 'YYYYMMDD');
  v_et_date_dash TEXT := to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD');
  r RECORD;
  v_count BIGINT;
BEGIN
  RAISE NOTICE '[D-501 v2] ET date=% (dash=%)', v_et_date, v_et_date_dash;

  -- props_cache columns
  RAISE NOTICE '[D-501 v2] props_cache columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='props_cache' ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  col % : %', r.column_name, r.data_type;
  END LOOP;

  -- props_cache row count for today (no game_pk grouping yet)
  SELECT count(*) INTO v_count FROM public.props_cache WHERE game_date = v_et_date;
  RAISE NOTICE '[D-501 v2 STAGE 3] props_cache rows for game_date=%: %', v_et_date, v_count;

  -- mlb_scoring_progress
  SELECT count(*) INTO v_count FROM public.mlb_scoring_progress WHERE game_date = v_et_date;
  RAISE NOTICE '[D-501 v2 STAGE 4] mlb_scoring_progress rows for today: %', v_count;
  RAISE NOTICE '[D-501 v2 STAGE 4 details]:';
  FOR r IN
    SELECT game_pk, scored_at, tick_label
    FROM public.mlb_scoring_progress
    WHERE game_date = v_et_date
    ORDER BY scored_at
  LOOP
    RAISE NOTICE '  game_pk=% scored_at=% tick_label=%', r.game_pk, r.scored_at, COALESCE(r.tick_label, '<null>');
  END LOOP;

  -- recommendations_cache for today (sport=mlb, fresh)
  RAISE NOTICE '[D-501 v2] recommendations_cache columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recommendations_cache' ORDER BY ordinal_position
    LIMIT 25
  LOOP
    RAISE NOTICE '  col % : %', r.column_name, r.data_type;
  END LOOP;

  -- Distinct game_id in rec_cache for picks created in last 24h (sport=mlb)
  SELECT count(DISTINCT game_id) INTO v_count
   FROM public.recommendations_cache
   WHERE sport='mlb' AND created_at >= now() - INTERVAL '24 hours';
  RAISE NOTICE '[D-501 v2 STAGE 5a] distinct MLB game_id in rec_cache last 24h: %', v_count;

  -- Total MLB picks in rec_cache last 24h
  SELECT count(*) INTO v_count
   FROM public.recommendations_cache
   WHERE sport='mlb' AND created_at >= now() - INTERVAL '24 hours';
  RAISE NOTICE '[D-501 v2 STAGE 5b] total MLB picks in rec_cache last 24h: %', v_count;

  -- Per-game pick count for MLB in last 24h
  RAISE NOTICE '[D-501 v2 STAGE 5c] per-game pick counts (MLB last 24h):';
  FOR r IN
    SELECT game_id, count(*) AS picks, min(created_at) AS earliest, max(game_time) AS gt
    FROM public.recommendations_cache
    WHERE sport='mlb' AND created_at >= now() - INTERVAL '24 hours'
    GROUP BY game_id
    ORDER BY gt NULLS LAST
  LOOP
    RAISE NOTICE '  game_id=% picks=% gametime=% earliest_created=%',
      COALESCE(r.game_id::text, '<null>'), r.picks, COALESCE(r.gt::text, '<null>'), r.earliest;
  END LOOP;

  -- Last 3 MLB cron ticks
  RAISE NOTICE '[D-501 v2 LAST process-games-mlb TICKS]:';
  FOR r IN
    SELECT created_at, duration_ms, games_found, props_fetched, recommendations,
           ai_generated, ai_failed, errors_count, status, notes
    FROM public.run_log
    WHERE function_name = 'process-games-mlb'
    ORDER BY created_at DESC LIMIT 6
  LOOP
    RAISE NOTICE '  tick @ % dur=%ms games_found=% props_fetched=% recs=% ai_gen=% ai_fail=% err=% status=% notes=%',
      r.created_at, r.duration_ms, r.games_found, r.props_fetched, r.recommendations,
      r.ai_generated, r.ai_failed, r.errors_count, r.status, COALESCE(r.notes, '<null>');
  END LOOP;

  -- Last 3 fetch-odds-mlb ticks
  RAISE NOTICE '[D-501 v2 LAST fetch-odds-mlb TICKS]:';
  FOR r IN
    SELECT created_at, duration_ms, props_fetched, errors_count, status, notes
    FROM public.run_log
    WHERE function_name = 'fetch-odds-mlb'
    ORDER BY created_at DESC LIMIT 6
  LOOP
    RAISE NOTICE '  tick @ % dur=%ms props_fetched=% err=% status=% notes=%',
      r.created_at, r.duration_ms, r.props_fetched, r.errors_count, r.status, COALESCE(r.notes, '<null>');
  END LOOP;
END $$;
