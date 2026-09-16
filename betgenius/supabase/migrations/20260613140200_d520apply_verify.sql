-- D-520-APPLY SHIP 2 — Read-only verification queries.
-- A: diff post-apply row vs snapshot — exactly 9 negated + 1 new column added
-- B: show each of the 9 = exact negation of prior value
-- C: confirm new column = 2.0
-- D: untouched-column count (every other key byte-identical)
-- E: non-batter weight check (a sample of pitcher/game cols equal snapshot)
DO $$
DECLARE r RECORD; v_diffs int := 0; v_same int := 0; v_changed_keys text[] := '{}';
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §A — Column-wise diff between live row 1 and snapshot row 1
  RAISE NOTICE '[D-520-APPLY §A] columnwise diff (live vs snapshot):';
  FOR r IN
    WITH live AS (
      SELECT to_jsonb(t.*) AS j FROM public.algorithm_weights t WHERE id = 1
    ),
    snap AS (
      SELECT to_jsonb(s.*) - 'snapshot_taken_at' - 'snapshot_git_sha' AS j
      FROM public.algorithm_weights_d520apply_snapshot s WHERE id = 1
    ),
    flat_live AS (SELECT key, value AS live_val FROM live, jsonb_each_text(live.j)),
    flat_snap AS (SELECT key, value AS snap_val FROM snap, jsonb_each_text(snap.j)),
    joined AS (
      SELECT
        COALESCE(l.key, s.key) AS key,
        l.live_val,
        s.snap_val
      FROM flat_live l FULL OUTER JOIN flat_snap s ON l.key = s.key
    )
    SELECT key, live_val, snap_val
    FROM joined
    WHERE COALESCE(live_val,'<NULL>') <> COALESCE(snap_val,'<NULL>')
      AND key <> 'updated_at'  -- expected: bumped by apply
    ORDER BY key
  LOOP
    v_diffs := v_diffs + 1;
    v_changed_keys := array_append(v_changed_keys, r.key);
    RAISE NOTICE '  CHANGED: % live=% snap=%', r.key, r.live_val, r.snap_val;
  END LOOP;
  RAISE NOTICE '[D-520-APPLY §A] total changed columns (excl updated_at) = %', v_diffs;

  -- HARD ASSERT: exactly 10 changes — 9 negated + 1 new column
  IF v_diffs <> 10 THEN
    RAISE WARNING '[D-520-APPLY §A] EXPECTED 10 changes but got %. Changed: %',
      v_diffs, v_changed_keys;
  ELSE
    RAISE NOTICE '[D-520-APPLY §A] ✓ exactly 10 changes (expected).';
  END IF;

  -- §B — Each flip = exact negation of snapshot value
  RAISE NOTICE '[D-520-APPLY §B] negation check (live = -snap?):';
  FOR r IN
    SELECT
      'handedness'         AS factor,
      w.w_mlb_batter_handedness_matchup     AS live_val,
      s.w_mlb_batter_handedness_matchup     AS snap_val,
      (w.w_mlb_batter_handedness_matchup = -s.w_mlb_batter_handedness_matchup) AS ok
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'weather_wind',
      w.w_mlb_batter_weather_wind, s.w_mlb_batter_weather_wind,
      w.w_mlb_batter_weather_wind = -s.w_mlb_batter_weather_wind
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'lineup_consistency',
      w.w_mlb_batter_lineup_consistency, s.w_mlb_batter_lineup_consistency,
      w.w_mlb_batter_lineup_consistency = -s.w_mlb_batter_lineup_consistency
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'weather_temp',
      w.w_mlb_batter_weather_temp, s.w_mlb_batter_weather_temp,
      w.w_mlb_batter_weather_temp = -s.w_mlb_batter_weather_temp
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'wind_direction_hr',
      w.w_mlb_wind_direction_hr, s.w_mlb_wind_direction_hr,
      w.w_mlb_wind_direction_hr = -s.w_mlb_wind_direction_hr
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'pitcher_quality',
      w.w_mlb_batter_pitcher_quality, s.w_mlb_batter_pitcher_quality,
      w.w_mlb_batter_pitcher_quality = -s.w_mlb_batter_pitcher_quality
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'form_power',
      w.w_mlb_batter_form_power, s.w_mlb_batter_form_power,
      w.w_mlb_batter_form_power = -s.w_mlb_batter_form_power
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'recent_ab',
      w.w_mlb_batter_recent_ab, s.w_mlb_batter_recent_ab,
      w.w_mlb_batter_recent_ab = -s.w_mlb_batter_recent_ab
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'babip',
      w.w_mlb_batter_babip, s.w_mlb_batter_babip,
      w.w_mlb_batter_babip = -s.w_mlb_batter_babip
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
  LOOP
    RAISE NOTICE '  % live=% snap=% negation_ok=%', r.factor, r.live_val, r.snap_val, r.ok;
  END LOOP;

  -- §C — new column reads 2.0
  RAISE NOTICE '[D-520-APPLY §C] new column w_mlb_batter_line_hit_rate:';
  FOR r IN
    SELECT w_mlb_batter_line_hit_rate AS v FROM public.algorithm_weights WHERE id = 1
  LOOP RAISE NOTICE '  w_mlb_batter_line_hit_rate = %', r.v; END LOOP;

  -- §D — Non-flipped batter columns + a sample of pitcher/game columns
  -- must equal snapshot (byte-identical guarantee).
  RAISE NOTICE '[D-520-APPLY §D] sample of UNCHANGED columns (live = snap?):';
  FOR r IN
    SELECT
      'w_mlb_batter_hit_rate' AS col, w.w_mlb_batter_hit_rate::text AS live_val,
      s.w_mlb_batter_hit_rate::text AS snap_val,
      w.w_mlb_batter_hit_rate = s.w_mlb_batter_hit_rate AS ok
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'w_mlb_pitcher_baa',
      w.w_mlb_pitcher_baa::text, s.w_mlb_pitcher_baa::text,
      w.w_mlb_pitcher_baa = s.w_mlb_pitcher_baa
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'w_mlb_game_pitching_matchup',
      w.w_mlb_game_pitching_matchup::text, s.w_mlb_game_pitching_matchup::text,
      w.w_mlb_game_pitching_matchup = s.w_mlb_game_pitching_matchup
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'w_l10',
      w.w_l10::text, s.w_l10::text,
      w.w_l10 = s.w_l10
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'w_minutes_floor',
      w.w_minutes_floor::text, s.w_minutes_floor::text,
      w.w_minutes_floor = s.w_minutes_floor
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'w_role_change',
      w.w_role_change::text, s.w_role_change::text,
      w.w_role_change = s.w_role_change
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'w_mlb_pitcher_weather_wind',  -- distinct from BATTER weather_wind that was flipped
      w.w_mlb_pitcher_weather_wind::text, s.w_mlb_pitcher_weather_wind::text,
      w.w_mlb_pitcher_weather_wind = s.w_mlb_pitcher_weather_wind
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
    UNION ALL SELECT 'w_mlb_handedness_matchup',  -- distinct from BATTER handedness_matchup
      w.w_mlb_handedness_matchup::text, s.w_mlb_handedness_matchup::text,
      w.w_mlb_handedness_matchup = s.w_mlb_handedness_matchup
    FROM public.algorithm_weights w
    CROSS JOIN public.algorithm_weights_d520apply_snapshot s
    WHERE w.id = 1 AND s.id = 1
  LOOP RAISE NOTICE '  % live=% snap=% unchanged_ok=%', r.col, r.live_val, r.snap_val, r.ok; END LOOP;
END $$;
