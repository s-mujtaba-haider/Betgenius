-- D-112 — check cron_progress state to understand why 3 success ticks but games=2.
-- Read-only.

DO $$
DECLARE
  v_row RECORD;
  v_today TEXT;
BEGIN
  v_today := TO_CHAR((NOW() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  RAISE NOTICE '=== cron_progress state @ % (today ET = %) ===', NOW(), v_today;

  RAISE NOTICE '';
  RAISE NOTICE '--- cron_progress rows for today ---';
  FOR v_row IN
    SELECT id, game_date, game_id, home_team, away_team, status, started_at, completed_at
    FROM cron_progress
    WHERE game_date = v_today
    ORDER BY game_time
  LOOP
    RAISE NOTICE '  id=% % @ % vs % :: status=% started=% completed=%',
      v_row.id, v_row.game_date, v_row.away_team, v_row.home_team,
      v_row.status, v_row.started_at, v_row.completed_at;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '--- summary by status ---';
  FOR v_row IN
    SELECT status, COUNT(*) AS n
    FROM cron_progress
    WHERE game_date = v_today
    GROUP BY status
  LOOP
    RAISE NOTICE '  %: %', v_row.status, v_row.n;
  END LOOP;
END $$;
