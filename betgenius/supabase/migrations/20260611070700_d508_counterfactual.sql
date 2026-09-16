DO $$
DECLARE r RECORD;
BEGIN
  -- D-508 counterfactual: for yesterday's slate, sort by gameTime ASC and
  -- simulate the new volume-cap shard against ACTUAL pick counts per matchup.

  RAISE NOTICE '[D-508 sim] yesterday (20260610) full slate by gameTime ASC + ACTUAL pick counts:';
  FOR r IN
    WITH per_matchup AS (
      SELECT LEAST(team, opponent) AS team1,
             GREATEST(team, opponent) AS team2,
             count(*) AS actual_picks
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND game_date=DATE '2026-06-10'
      GROUP BY 1, 2
    ),
    matchup_with_props AS (
      SELECT
        pc.home_team, pc.away_team,
        LEAST(pc.home_team, pc.away_team) AS team1,
        GREATEST(pc.home_team, pc.away_team) AS team2,
        min(pc.game_time) AS earliest_game_time,
        count(*) AS props_count
      FROM public.props_cache pc
      WHERE pc.sport='mlb' AND pc.game_date='20260610'
      GROUP BY 1, 2
    )
    SELECT mwp.earliest_game_time AS game_time,
           mwp.home_team || ' vs ' || mwp.away_team AS matchup,
           mwp.props_count,
           CEIL(mwp.props_count * 0.065) AS projected,
           COALESCE(pm.actual_picks, 0) AS actual,
           ROUND(100.0 * (CEIL(mwp.props_count * 0.065) - pm.actual_picks)
                 / NULLIF(pm.actual_picks, 0), 1) AS proj_err_pct
    FROM matchup_with_props mwp
    LEFT JOIN per_matchup pm ON pm.team1 = mwp.team1 AND pm.team2 = mwp.team2
    ORDER BY mwp.earliest_game_time
  LOOP RAISE NOTICE '  gt=% % props=% proj=% actual=% err_pct=%',
    r.game_time, r.matchup, r.props_count, r.projected, r.actual, r.proj_err_pct; END LOOP;

  -- Now simulate the cap=200 shard
  RAISE NOTICE '[D-508 sim] simulated ticks needed at cap=200 vs old N=2:';
  DECLARE
    v_running INT := 0;
    v_tick_n INT := 0;
    v_games_this_tick INT := 0;
    v_total_games INT := 0;
    v_old_ticks INT;
    v_solo_heavies INT := 0;
  BEGIN
    FOR r IN
      WITH per_matchup AS (
        SELECT pc.home_team, pc.away_team,
               min(pc.game_time) AS game_time,
               count(*) AS props_count
        FROM public.props_cache pc
        WHERE pc.sport='mlb' AND pc.game_date='20260610'
        GROUP BY 1, 2
      )
      SELECT *, CEIL(props_count * 0.065) AS proj_picks
      FROM per_matchup
      ORDER BY game_time
    LOOP
      v_total_games := v_total_games + 1;
      IF v_games_this_tick = 0 OR (v_running + r.proj_picks::INT) <= 200 THEN
        IF v_games_this_tick = 0 THEN
          v_tick_n := v_tick_n + 1;
          v_running := 0;
        END IF;
        v_running := v_running + r.proj_picks::INT;
        v_games_this_tick := v_games_this_tick + 1;
        IF r.proj_picks::INT > 110 THEN v_solo_heavies := v_solo_heavies + 1; END IF;
        -- Pre-cap, keep accumulating up to 200
        IF v_running >= 200 THEN
          v_games_this_tick := 0; -- flush
        END IF;
      ELSE
        -- start a new tick with this game
        v_tick_n := v_tick_n + 1;
        v_running := r.proj_picks::INT;
        v_games_this_tick := 1;
        IF r.proj_picks::INT > 110 THEN v_solo_heavies := v_solo_heavies + 1; END IF;
        IF v_running >= 200 THEN v_games_this_tick := 0; END IF;
      END IF;
    END LOOP;

    v_old_ticks := CEIL(v_total_games::NUMERIC / 2.0);
    RAISE NOTICE '  total_games=% old_ticks_at_N=2=% new_ticks_at_cap=200=%',
      v_total_games, v_old_ticks, v_tick_n;
    RAISE NOTICE '  solo-heavies-flag-fired=% (single game projecting > 110)', v_solo_heavies;
    RAISE NOTICE '  slate_clear: old=%min new=%min (5-min cadence)',
      v_old_ticks * 5, v_tick_n * 5;
  END;
END $$;
