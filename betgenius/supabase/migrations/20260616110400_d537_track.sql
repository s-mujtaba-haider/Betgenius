-- D-537 — track 10 games through scoring_progress (event log) + rec_cache.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-537 §D.1: scoring_progress events for 2026-06-15 ========';
  FOR r IN
    SELECT game_pk, count(*) AS scored_ticks, max(scored_at) AS last_scored
    FROM public.mlb_scoring_progress
    WHERE game_date IN ('20260615','2026-06-15')
    GROUP BY game_pk ORDER BY game_pk
  LOOP RAISE NOTICE '[D-537 §D.1] gamePk=% scored_ticks=% last_scored=%',
    r.game_pk, r.scored_ticks, r.last_scored; END LOOP;

  FOR r IN
    SELECT count(DISTINCT game_pk) AS distinct_games, count(*) AS total_ticks
    FROM public.mlb_scoring_progress
    WHERE game_date IN ('20260615','2026-06-15')
  LOOP RAISE NOTICE '[D-537 §D.2] scoring_progress total: distinct_games=% total_ticks=%',
    r.distinct_games, r.total_ticks; END LOOP;

  RAISE NOTICE '======== D-537 §E: rec_cache for 2026-06-15 ========';
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='recommendations_cache'
      AND column_name ILIKE '%game%'
    ORDER BY column_name
  LOOP RAISE NOTICE '[D-537 §E.0] rec_cache col: %', r.column_name; END LOOP;

  FOR r IN
    SELECT game_id, count(*) AS picks
    FROM public.recommendations_cache
    WHERE sport='mlb' AND game_date IN ('20260615','2026-06-15')
    GROUP BY game_id ORDER BY game_id
  LOOP RAISE NOTICE '[D-537 §E.1] rec_cache gamePk=% picks=%', r.game_id, r.picks; END LOOP;

  FOR r IN
    SELECT count(DISTINCT game_id) AS distinct_games, count(*) AS picks
    FROM public.recommendations_cache
    WHERE sport='mlb' AND game_date IN ('20260615','2026-06-15')
  LOOP RAISE NOTICE '[D-537 §E.2] rec_cache total: distinct_games=% picks=%',
    r.distinct_games, r.picks; END LOOP;

  RAISE NOTICE '[D-537 §F] pick_history check moved to 110500 (column name correction).';
END $$;
