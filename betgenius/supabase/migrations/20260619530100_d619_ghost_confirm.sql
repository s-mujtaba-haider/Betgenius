DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE 'now=%', now();
  RAISE NOTICE '';
  RAISE NOTICE '[ghost-confirm] mlb_scoring_progress row for game_pk=823853:';
  FOR r IN
    SELECT game_pk, COALESCE(last_score_hash,'(null)') AS hash, scored_at, tick_label
      FROM public.mlb_scoring_progress
     WHERE game_pk = 823853
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=% tick=%', r.game_pk, r.hash, r.scored_at, r.tick_label;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[full slate] all 14 rows with hashes:';
  FOR r IN
    SELECT game_pk, COALESCE(LEFT(last_score_hash,16),'(null)') AS hash, scored_at, tick_label
      FROM public.mlb_scoring_progress
     WHERE game_date = to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD')
     ORDER BY scored_at DESC
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=% tick=%', r.game_pk, r.hash, r.scored_at, r.tick_label;
  END LOOP;
END $$;
