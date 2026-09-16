-- Read-only: confirm cache_opponent_defensive_stats coverage for the
-- dates we want to verify Fix #2 on. RLS blocks anon read so this runs
-- in DB context.

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== cache_opponent_defensive_stats snapshot coverage Apr 14 - May 11 ===';
  FOR r IN
    SELECT snapshot_date, COUNT(*) AS teams,
      COUNT(*) FILTER (WHERE rpg_allowed_bdl IS NOT NULL) AS with_rpg_bdl,
      COUNT(*) FILTER (WHERE apg_allowed_bdl IS NOT NULL) AS with_apg_bdl
    FROM cache_opponent_defensive_stats
    WHERE snapshot_date >= '2026-04-14'::DATE
      AND snapshot_date <  '2026-05-12'::DATE
      AND sport = 'nba'
    GROUP BY snapshot_date
    ORDER BY snapshot_date
  LOOP
    RAISE NOTICE 'date=% teams=% with_rpg_bdl=% with_apg_bdl=%',
      r.snapshot_date, r.teams, r.with_rpg_bdl, r.with_apg_bdl;
  END LOOP;
END $$;
