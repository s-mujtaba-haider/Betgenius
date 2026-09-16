-- D-599 SHIP 1 — batter_total_bases corr_edge signal gate.
-- The decisive stat per D-551: corr(input, actual_value - line) on
-- the residual. Tests every numeric input ALREADY in TB breakdown
-- plus the D-556 "already-have-unused" candidates the current proj
-- doesn't consume.
--
-- ESCALATION 2: pitch-type batter-side requires probable-pitcher
-- backfill (process-games-mlb fetches probables at scoring time but
-- doesn't cache them; no historical join path). Filed as D-599b. This
-- migration measures what IS testable retroactively.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  RAISE NOTICE '======== D-599 §A: TB corpus inventory ========';
  FOR r IN
    SELECT count(*) AS n,
      count(*) FILTER (WHERE breakdown ? 'projected_stat') AS w_proj,
      count(*) FILTER (WHERE breakdown ? 'park_hr_factor') AS w_park_hr,
      count(*) FILTER (WHERE breakdown ? 'park_hits_factor') AS w_park_hits,
      count(*) FILTER (WHERE breakdown ? 'wind_dir_deg') AS w_wind_dir,
      count(*) FILTER (WHERE breakdown ? 'opp_pitcher_baa_vs_lhb') AS w_baa_lhb,
      count(*) FILTER (WHERE breakdown ? 'opposing_bullpen_era') AS w_opp_bp,
      count(*) FILTER (WHERE is_home IS NOT NULL) AS w_is_home
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND is_synthetic=false AND voided IS NOT TRUE AND hit IS NOT NULL
      AND breakdown IS NOT NULL AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-599 §A.1] n=% proj=% park_hr=% park_hits=% wind_dir=% baa_lhb=% opp_bp=% is_home=%',
    r.n, r.w_proj, r.w_park_hr, r.w_park_hits, r.w_wind_dir,
    r.w_baa_lhb, r.w_opp_bp, r.w_is_home; END LOOP;

  -- =================================================================
  -- §B — THE DECISIVE TEST: corr(input, actual_value - line) on the
  -- TB residual. If no input crosses |r|>=0.10, TB is market-efficient
  -- on existing data (the D-551 wall pattern).
  -- =================================================================
  RAISE NOTICE '======== D-599 §B: per-input corr vs actual_TB - line (residual) ========';

  FOR r IN
    SELECT 'projected_stat (current model)' AS input,
      ROUND(corr((breakdown->>'projected_stat')::numeric - line, actual_value - line)::numeric, 4) AS r,
      ROUND(corr((breakdown->>'projected_stat')::numeric, actual_value)::numeric, 4) AS r_raw,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
      AND hit IS NOT NULL AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.1] %: r_edge_vs_resid=% r_raw=% n=%',
    r.input, r.r, r.r_raw, r.n; END LOOP;

  -- D-556 unused: park_hr_factor (vs park_hits_factor currently used in proj)
  FOR r IN
    SELECT 'park_hr_factor (unused for TB)' AS input,
      ROUND(corr((breakdown->>'park_hr_factor')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      ROUND(corr((breakdown->>'park_hr_factor')::numeric, actual_value)::numeric, 4) AS r_raw,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'park_hr_factor' AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.2] %: r_resid=% r_raw=% n=%',
    r.input, r.r_resid, r.r_raw, r.n; END LOOP;

  FOR r IN
    SELECT 'park_hits_factor (current proj)' AS input,
      ROUND(corr((breakdown->>'park_hits_factor')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      ROUND(corr((breakdown->>'park_hits_factor')::numeric, actual_value)::numeric, 4) AS r_raw,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'park_hits_factor' AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.3] %: r_resid=% r_raw=% n=%',
    r.input, r.r_resid, r.r_raw, r.n; END LOOP;

  FOR r IN
    SELECT 'wind_dir_deg' AS input,
      ROUND(corr((breakdown->>'wind_dir_deg')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'wind_dir_deg' AND (breakdown->>'wind_dir_deg') ~ '^-?[0-9.]+$'
      AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.4] %: r_resid=% n=%', r.input, r.r_resid, r.n; END LOOP;

  -- wind direction × park HR factor crossing — the D-541 §B/§C unused signal
  FOR r IN
    WITH joined AS (
      SELECT
        (breakdown->>'wind_dir_deg')::numeric AS wd,
        (breakdown->>'park_hr_factor')::numeric AS phf,
        (breakdown->>'weather_wind_mph')::numeric AS ws,
        actual_value - line AS resid
      FROM public.pick_history
      WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
        AND breakdown ? 'wind_dir_deg' AND breakdown ? 'park_hr_factor'
        AND breakdown ? 'weather_wind_mph'
        AND (breakdown->>'wind_dir_deg') ~ '^-?[0-9.]+$'
        AND (breakdown->>'weather_wind_mph') ~ '^-?[0-9.]+$'
        AND actual_value IS NOT NULL AND hit IS NOT NULL
        AND is_synthetic=false AND voided IS NOT TRUE
    )
    SELECT
      count(*) AS n,
      ROUND(corr(phf * (1 + ws/30.0 * COS(RADIANS(wd))), resid)::numeric, 4) AS r_resid,
      ROUND(corr(phf * ws, resid)::numeric, 4) AS r_phf_ws
    FROM joined
  LOOP RAISE NOTICE '[D-599 §B.5] wind_dir×park_HR crossing: r_resid=% r_phf_ws=% n=%',
    r.r_resid, r.r_phf_ws, r.n; END LOOP;

  -- Home/away split — is_home column
  FOR r IN
    WITH joined AS (
      SELECT is_home::int AS ih, actual_value - line AS resid
      FROM public.pick_history
      WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
        AND is_home IS NOT NULL AND actual_value IS NOT NULL AND hit IS NOT NULL
        AND is_synthetic=false AND voided IS NOT TRUE
    )
    SELECT count(*) AS n,
      ROUND(corr(ih::numeric, resid)::numeric, 4) AS r_resid,
      ROUND(avg(resid) FILTER (WHERE ih=1)::numeric, 3) AS avg_home,
      ROUND(avg(resid) FILTER (WHERE ih=0)::numeric, 3) AS avg_away
    FROM joined
  LOOP RAISE NOTICE '[D-599 §B.6] is_home: r_resid=% avg_resid_home=% avg_resid_away=% n=%',
    r.r_resid, r.avg_home, r.avg_away, r.n; END LOOP;

  -- D-562 runs_allowed: only populated in batter breakdown's opposing_bullpen_era
  -- (which is bullpen RA proxy). Note: home_rapg/away_rapg pre-D-562 were constant.
  FOR r IN
    SELECT 'opposing_bullpen_era' AS input,
      ROUND(corr((breakdown->>'opposing_bullpen_era')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'opposing_bullpen_era' AND (breakdown->>'opposing_bullpen_era') ~ '^-?[0-9.]+$'
      AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.7] %: r_resid=% n=%', r.input, r.r_resid, r.n; END LOOP;

  -- The D-541 winners — confirm their r vs residual (D-541 measured r vs actual, not residual)
  FOR r IN
    SELECT 'statcast_avg_hit_speed (D-541 best)' AS input,
      ROUND(corr((breakdown->>'statcast_avg_hit_speed')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'statcast_avg_hit_speed' AND (breakdown->>'statcast_avg_hit_speed') ~ '^-?[0-9.]+$'
      AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.8] %: r_resid=% n=%', r.input, r.r_resid, r.n; END LOOP;

  FOR r IN
    SELECT 'lineup_spot (D-541 r=-0.134 vs actual)' AS input,
      ROUND(corr((breakdown->>'lineup_spot')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'lineup_spot' AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
      AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.9] %: r_resid=% n=%', r.input, r.r_resid, r.n; END LOOP;

  FOR r IN
    SELECT 'statcast_brl_pa' AS input,
      ROUND(corr((breakdown->>'statcast_brl_pa')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'statcast_brl_pa' AND (breakdown->>'statcast_brl_pa') ~ '^-?[0-9.]+$'
      AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.10] %: r_resid=% n=%', r.input, r.r_resid, r.n; END LOOP;

  FOR r IN
    SELECT 'opp_pitcher_baa_vs_lhb (D-349 pitcher-specific)' AS input,
      ROUND(corr((breakdown->>'opp_pitcher_baa_vs_lhb')::numeric, actual_value - line)::numeric, 4) AS r_resid,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'opp_pitcher_baa_vs_lhb' AND (breakdown->>'opp_pitcher_baa_vs_lhb') ~ '^-?[0-9.]+$'
      AND actual_value IS NOT NULL AND hit IS NOT NULL
      AND is_synthetic=false AND voided IS NOT TRUE
  LOOP RAISE NOTICE '[D-599 §B.11] %: r_resid=% n=%', r.input, r.r_resid, r.n; END LOOP;
END $$;
