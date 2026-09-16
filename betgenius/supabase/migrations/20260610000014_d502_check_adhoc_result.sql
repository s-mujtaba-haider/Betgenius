-- D-502 SHIP 2 — check ad-hoc trigger result (request_id=10767) + measure
-- delta in mlb_scoring_progress. Confirms the function still works at the
-- new cadence-changed state.
DO $$
DECLARE
  v_et_date TEXT := to_char(now() AT TIME ZONE 'America/New_York', 'YYYYMMDD');
  v_status INT;
  v_content TEXT;
  v_post_progress INT;
  v_delta INT;
  r RECORD;
BEGIN
  -- Pull the fn response
  FOR r IN SELECT status_code, content, error_msg, created
            FROM net._http_response WHERE id = 10767 LOOP
    v_status := r.status_code;
    v_content := r.content;
    RAISE NOTICE '[D-502 RESULT] request_id=10767 status=% created=% error=%',
      r.status_code, r.created, COALESCE(r.error_msg, '<none>');
    IF r.content IS NOT NULL THEN
      RAISE NOTICE '[D-502 RESULT] response body (first 600 chars): %', substring(r.content, 1, 600);
    END IF;
    EXIT;
  END LOOP;

  IF v_status IS NULL THEN
    RAISE NOTICE '[D-502 RESULT] no response yet (still running?). Retry the inspection later.';
  END IF;

  -- Post-trigger progress count
  SELECT count(*) INTO v_post_progress
   FROM public.mlb_scoring_progress WHERE game_date = v_et_date;
  v_delta := v_post_progress - 4;  -- pre baseline was 4
  RAISE NOTICE '[D-502 RESULT] POST mlb_scoring_progress count=% (was 4, delta=+%)',
    v_post_progress, v_delta;

  -- Show all entries for today + their tick_label so we can identify
  -- the 2 just-scored
  RAISE NOTICE '[D-502 RESULT] all mlb_scoring_progress rows for today:';
  FOR r IN
    SELECT game_pk, scored_at, tick_label
    FROM public.mlb_scoring_progress
    WHERE game_date = v_et_date
    ORDER BY scored_at
  LOOP
    RAISE NOTICE '  game_pk=% scored_at=% tick_label=%', r.game_pk, r.scored_at, COALESCE(r.tick_label, '<null>');
  END LOOP;

  -- Per-game pick count delta in rec_cache last 1h (would include any new from this trigger)
  RAISE NOTICE '[D-502 RESULT] rec_cache MLB picks created in last 10 min:';
  FOR r IN
    SELECT game_id, game_time, count(*) AS pick_count, min(created_at) AS earliest
    FROM public.recommendations_cache
    WHERE sport='mlb' AND created_at >= now() - INTERVAL '10 minutes'
    GROUP BY game_id, game_time
    ORDER BY game_time
  LOOP
    RAISE NOTICE '  game_id=% game_time=% picks_in_last_10min=% earliest=%',
      r.game_id, r.game_time, r.pick_count, r.earliest;
  END LOOP;
END $$;
