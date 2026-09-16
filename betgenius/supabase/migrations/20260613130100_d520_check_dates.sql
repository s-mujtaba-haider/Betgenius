DO $$
DECLARE r RECORD;
BEGIN
  -- Find when breakdown began being populated
  RAISE NOTICE '[D-520 dates] breakdown-populated picks by game_date (last 60d):';
  FOR r IN
    SELECT game_date, count(*) AS total,
           count(*) FILTER (WHERE breakdown IS NOT NULL) AS has_breakdown
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    GROUP BY game_date ORDER BY game_date
  LOOP RAISE NOTICE '  gd=% total=% has_breakdown=%', r.game_date, r.total, r.has_breakdown; END LOOP;
END $$;
