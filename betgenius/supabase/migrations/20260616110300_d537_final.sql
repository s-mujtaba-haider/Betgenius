-- D-537 — final reconcile on 2026-06-15 (today by MLB ET game_date).
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §B revised — list all 10 game_ids on 2026-06-15
  RAISE NOTICE '======== D-537 §B: schedule gamePks 2026-06-15 ========';
  FOR r IN
    SELECT game_id, status, home_team, away_team
    FROM public.cache_mlb_game_scoreboard
    WHERE game_date='2026-06-15' ORDER BY game_id
  LOOP RAISE NOTICE '[D-537 §B.1] gamePk=% status=% % vs %',
    r.game_id, r.status, r.home_team, r.away_team; END LOOP;

  -- §C revised — props_cache columns
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='props_cache'
      AND column_name ILIKE '%game%'
    ORDER BY column_name
  LOOP RAISE NOTICE '[D-537 §C.0] props_cache col: %', r.column_name; END LOOP;
END $$;
