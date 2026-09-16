DO $$
DECLARE r RECORD;
BEGIN
  -- Tighter predictor: distinct (player, prop_type, line, pick_side) per matchup
  RAISE NOTICE '[D-508 recal] yesterday slate: props_count vs distinct_tuples vs actual_picks:';
  FOR r IN
    WITH per_matchup_props AS (
      SELECT home_team, away_team,
             count(*) AS row_count,
             count(DISTINCT (player_name || '|' || prop_type || '|' || line || '|' || pick_side)) AS distinct_n
      FROM public.props_cache
      WHERE sport='mlb' AND game_date='20260610'
      GROUP BY home_team, away_team
    ),
    per_matchup_picks AS (
      SELECT LEAST(team, opponent) AS t1, GREATEST(team, opponent) AS t2,
             count(*) AS actual_picks
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND game_date=DATE '2026-06-10'
      GROUP BY 1, 2
    )
    SELECT p.home_team || ' vs ' || p.away_team AS matchup,
           p.row_count AS props,
           p.distinct_n AS distinct_tuples,
           COALESCE(a.actual_picks, 0) AS actual,
           ROUND(a.actual_picks * 1.0 / NULLIF(p.distinct_n, 0), 3) AS actual_div_distinct,
           ROUND(a.actual_picks * 1.0 / NULLIF(p.row_count, 0), 4) AS actual_div_props
    FROM per_matchup_props p
    LEFT JOIN per_matchup_picks a ON a.t1 = LEAST(p.home_team, p.away_team)
                                 AND a.t2 = GREATEST(p.home_team, p.away_team)
    ORDER BY actual DESC
  LOOP RAISE NOTICE '  % props=% dist=% actual=% a/d=% a/p=%',
    r.matchup, r.props, r.distinct_tuples, r.actual,
    r.actual_div_distinct, r.actual_div_props; END LOOP;

  -- Distribution of distinct_tuples per matchup over 7 days
  DECLARE r2 RECORD;
  BEGIN
    RAISE NOTICE '[D-508 recal] distinct_tuples per matchup distribution last 7 days MLB:';
    FOR r2 IN
      WITH per_matchup AS (
        SELECT game_date,
               count(DISTINCT (player_name || '|' || prop_type || '|' || line || '|' || pick_side)) AS d
        FROM public.props_cache
        WHERE sport='mlb' AND game_date >= '20260605'
        GROUP BY game_date, home_team, away_team
      )
      SELECT count(*) AS n_games,
             min(d) AS min_d,
             percentile_disc(0.25) WITHIN GROUP (ORDER BY d) AS p25,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY d) AS p50,
             percentile_disc(0.75) WITHIN GROUP (ORDER BY d) AS p75,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY d) AS p95,
             max(d) AS max_d, ROUND(avg(d)) AS avg_d
        FROM per_matchup
    LOOP RAISE NOTICE '  n=% min=% p25=% p50=% p75=% p95=% max=% avg=%',
      r2.n_games, r2.min_d, r2.p25, r2.p50, r2.p75, r2.p95, r2.max_d, r2.avg_d; END LOOP;
  END;

  -- Simulate with DISTINCT-based projector at multiple caps
  RAISE NOTICE '[D-508 recal] cap simulation at multiple thresholds (sorted by gameTime):';
  DECLARE
    cap_test INT;
    v_running INT; v_ticks INT; v_games INT;
    cap_to_test INT[] := ARRAY[200, 220, 240, 260, 280];
  BEGIN
    FOREACH cap_test IN ARRAY cap_to_test LOOP
      v_running := 0; v_ticks := 0; v_games := 0;
      FOR r IN
        WITH per_matchup AS (
          SELECT home_team, away_team, min(game_time) AS gt,
                 count(*) AS pc
          FROM public.props_cache
          WHERE sport='mlb' AND game_date='20260610'
          GROUP BY home_team, away_team
        )
        SELECT *, CEIL(pc * 0.065) AS proj FROM per_matchup ORDER BY gt
      LOOP
        v_games := v_games + 1;
        IF v_ticks = 0 OR v_running = 0 OR (v_running + r.proj::INT) > cap_test THEN
          v_ticks := v_ticks + 1;
          v_running := r.proj::INT;
        ELSE
          v_running := v_running + r.proj::INT;
        END IF;
      END LOOP;
      RAISE NOTICE '  cap=% → ticks=% slate_clear=%min (games=%)',
        cap_test, v_ticks, v_ticks * 5, v_games;
    END LOOP;
  END;
END $$;
