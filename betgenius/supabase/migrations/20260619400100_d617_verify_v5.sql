DO $$ DECLARE r RECORD; v_hashes bigint; v_total bigint; BEGIN
  RAISE NOTICE 'now=%', now();
  SELECT count(*) FILTER (WHERE last_score_hash IS NOT NULL), count(*)
    INTO v_hashes, v_total
    FROM public.mlb_scoring_progress
   WHERE game_date = to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  RAISE NOTICE 'today hashes populated: % / %', v_hashes, v_total;
  RAISE NOTICE '';
  RAISE NOTICE 'sample 6 rows today (newest first):';
  FOR r IN
    SELECT game_pk, LEFT(COALESCE(last_score_hash,'(null)'), 24) AS hash, scored_at
      FROM public.mlb_scoring_progress
     WHERE game_date = to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD')
     ORDER BY scored_at DESC LIMIT 6
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=%', r.game_pk, r.hash, r.scored_at;
  END LOOP;
END $$;
