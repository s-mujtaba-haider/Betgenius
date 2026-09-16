DO $$
DECLARE r RECORD; v_n BIGINT; v_n2 BIGINT;
BEGIN
  -- props_cache write velocity check: 0 rows in last 90 min?
  SELECT count(*) INTO v_n FROM public.props_cache
   WHERE sport='mlb' AND last_seen > NOW() - INTERVAL '90 minutes';
  RAISE NOTICE '[D-515 validate] props_cache MLB rows last 90 min: %', v_n;

  -- Most recent props_cache last_seen for MLB
  SELECT max(last_seen) INTO r FROM public.props_cache WHERE sport='mlb';
  RAISE NOTICE '[D-515 validate] most recent MLB props last_seen: %', (SELECT max(last_seen) FROM public.props_cache WHERE sport='mlb');

  -- mlb_scoring_progress: today's markers
  SELECT count(*) INTO v_n FROM public.mlb_scoring_progress
   WHERE game_date = to_char((NOW() AT TIME ZONE 'America/New_York')::DATE, 'YYYYMMDD');
  SELECT count(*) INTO v_n2 FROM public.mlb_scoring_progress
   WHERE scored_at > NOW() - INTERVAL '4 hours';
  RAISE NOTICE '[D-515 validate] mlb_scoring_progress today total=% scored_at_last_4h=%', v_n, v_n2;
  SELECT max(scored_at) INTO r FROM public.mlb_scoring_progress;
  RAISE NOTICE '[D-515 validate] most recent mlb_scoring_progress scored_at: %', (SELECT max(scored_at) FROM public.mlb_scoring_progress);

  -- pick_history writes in last 4h (mlb_scoring_progress_velocity gate)
  SELECT count(*) INTO v_n FROM public.pick_history
   WHERE sport='mlb' AND is_synthetic=false AND created_at > NOW() - INTERVAL '4 hours';
  RAISE NOTICE '[D-515 validate] pick_history MLB last 4h: %', v_n;

  -- recommendations_cache last 4h MLB
  SELECT count(*) INTO v_n FROM public.recommendations_cache
   WHERE sport='mlb' AND created_at > NOW() - INTERVAL '4 hours';
  RAISE NOTICE '[D-515 validate] rec_cache MLB last 4h: %', v_n;

  -- Most recent rec_cache MLB row
  RAISE NOTICE '[D-515 validate] most recent rec_cache MLB created_at: %',
    (SELECT max(created_at) FROM public.recommendations_cache WHERE sport='mlb');
END $$;
