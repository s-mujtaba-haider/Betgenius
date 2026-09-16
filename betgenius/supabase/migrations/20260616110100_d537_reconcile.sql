-- D-537 — full reconcile, today's MLB games (column is game_id not game_pk).
DO $$
DECLARE r RECORD; v_today date := '2026-06-16';
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-537 §B: today schedule (game_date=%) ========', v_today;
  FOR r IN
    SELECT game_id, status, home_team, away_team, fetched_at
    FROM public.cache_mlb_game_scoreboard
    WHERE game_date = v_today
    ORDER BY game_id
  LOOP RAISE NOTICE '[D-537 §B.1] gamePk=% status=% % vs % fetched=%',
    r.game_id, r.status, r.home_team, r.away_team, r.fetched_at; END LOOP;

  FOR r IN
    SELECT count(*) AS total
    FROM public.cache_mlb_game_scoreboard WHERE game_date = v_today
  LOOP RAISE NOTICE '[D-537 §B.2] schedule total games today = %', r.total; END LOOP;
END $$;
