-- D-537 — Find which gamePk is missing from rec_cache by joining
-- scoring_progress (has int gamePk) to rec_cache via the breakdown
-- JSONB or by counting rec_cache rows referencing the team names.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §G — what columns does pick_history use to link a pick to a game?
  RAISE NOTICE '======== D-537 §G: pick_history game-link columns ========';
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND (column_name ILIKE '%game%' OR column_name ILIKE '%team%')
    ORDER BY column_name
  LOOP RAISE NOTICE '[D-537 §G.0] col: %', r.column_name; END LOOP;

  -- §H — try the breakdown JSONB to find which gamePk maps to which rec_cache hash
  RAISE NOTICE '======== D-537 §H: rec_cache breakdown sample (looking for gamePk) ========';
  FOR r IN
    SELECT game_id, jsonb_object_keys(breakdown) AS k
    FROM public.recommendations_cache
    WHERE sport='mlb' AND game_date IN ('20260615','2026-06-15')
      AND breakdown IS NOT NULL
    ORDER BY game_id LIMIT 30
  LOOP RAISE NOTICE '  game_id=% key=%', r.game_id, r.k; END LOOP;

  -- §I — Sample one row to see if game_pk is somewhere in the breakdown
  RAISE NOTICE '======== D-537 §I: one rec_cache row full breakdown (truncated) ========';
  FOR r IN
    SELECT game_id, breakdown::text AS bk
    FROM public.recommendations_cache
    WHERE sport='mlb' AND game_date IN ('20260615','2026-06-15')
      AND breakdown IS NOT NULL
    LIMIT 1
  LOOP RAISE NOTICE '  game_id=% breakdown_excerpt=%', r.game_id, left(r.bk, 600); END LOOP;

  -- §J — pick_history with team-based join: which teams played and got picks?
  -- This works for spread/total picks where the team is set.
  RAISE NOTICE '======== D-537 §J: rec_cache team distribution on 2026-06-15 ========';
  FOR r IN
    SELECT team, opponent, count(*) AS n_picks, count(DISTINCT game_id) AS games
    FROM public.recommendations_cache
    WHERE sport='mlb' AND game_date IN ('20260615','2026-06-15')
      AND team IS NOT NULL
    GROUP BY team, opponent ORDER BY team
  LOOP RAISE NOTICE '[D-537 §J.1] team=% opp=% picks=% games=%',
    r.team, r.opponent, r.n_picks, r.games; END LOOP;
END $$;
