DO $$ DECLARE r RECORD; v_today text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD'); BEGIN
  -- §A — fetch-weather response
  RAISE NOTICE '[A] fetch-weather response (req 31279):';
  FOR r IN
    SELECT status_code, regexp_replace(LEFT(COALESCE(content::text,''), 600), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response WHERE id = 31279
  LOOP
    RAISE NOTICE '  status=% body=%', r.status_code, r.body;
  END LOOP;

  -- §B — fetch-statcast-snapshot response
  RAISE NOTICE '';
  RAISE NOTICE '[B] fetch-statcast-snapshot response (req 31280):';
  FOR r IN
    SELECT status_code, regexp_replace(LEFT(COALESCE(content::text,''), 1200), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response WHERE id = 31280
  LOOP
    RAISE NOTICE '  status=% body=%', r.status_code, r.body;
  END LOOP;

  -- §C — cache_mlb_game_scoreboard today coverage (post-fix)
  RAISE NOTICE '';
  FOR r IN
    SELECT count(*) AS rows_today,
           count(*) FILTER (WHERE weather_temp_f IS NOT NULL) AS with_temp,
           count(*) FILTER (WHERE weather_condition = 'indoor') AS indoor,
           count(DISTINCT home_team) AS home_teams,
           string_agg(DISTINCT home_team || ' (' || venue || ' temp=' || COALESCE(weather_temp_f::text,'null') || ')', ', ') AS sample
      FROM public.cache_mlb_game_scoreboard
     WHERE game_date::text = v_today
  LOOP
    RAISE NOTICE '[C] cache_mlb_game_scoreboard today (%):  rows=% with_temp=% indoor=% home_teams=%',
      v_today, r.rows_today, r.with_temp, r.indoor, r.home_teams;
    RAISE NOTICE '    sample: %', LEFT(r.sample, 600);
  END LOOP;

  -- §D — superseded by §E which is window-function-free.
  RAISE NOTICE '';

  -- §E — same snapshot counts via direct
  FOR r IN
    SELECT snapshot_date, count(*) AS n_rows, count(*) FILTER (WHERE est_ba IS NOT NULL) AS n_with_est_ba
      FROM public.cache_statcast_batters_xstats
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC LIMIT 5
  LOOP
    RAISE NOTICE '[E] snapshot=% rows=% with_est_ba=%', r.snapshot_date, r.n_rows, r.n_with_est_ba;
  END LOOP;
END $$;
