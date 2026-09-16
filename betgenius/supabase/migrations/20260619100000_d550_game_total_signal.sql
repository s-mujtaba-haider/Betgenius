-- D-550 SHIP 2 — game_total signal gate.
-- Per-input Pearson r vs actual total runs on organic resolved game_total
-- picks. Gate: max|r| < 0.15 → STOP. Some |r| > 0.20 → proceed.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  RAISE NOTICE '======== D-550 §A: game_total corpus depth + key coverage ========';
  FOR r IN
    SELECT
      count(*) AS n_total,
      count(*) FILTER (WHERE breakdown IS NOT NULL AND breakdown <> '{}'::jsonb) AS n_w_breakdown,
      count(*) FILTER (WHERE breakdown ? 'proj_total')         AS k_proj,
      count(*) FILTER (WHERE breakdown ? 'home_rpg')           AS k_hrpg,
      count(*) FILTER (WHERE breakdown ? 'away_rpg')           AS k_arpg,
      count(*) FILTER (WHERE breakdown ? 'home_rapg')          AS k_hrapg,
      count(*) FILTER (WHERE breakdown ? 'away_rapg')          AS k_arapg,
      count(*) FILTER (WHERE breakdown ? 'home_pitcher_era')   AS k_hpera,
      count(*) FILTER (WHERE breakdown ? 'away_pitcher_era')   AS k_apera,
      count(*) FILTER (WHERE breakdown ? 'home_bullpen_era')   AS k_hbp,
      count(*) FILTER (WHERE breakdown ? 'away_bullpen_era')   AS k_abp,
      count(*) FILTER (WHERE breakdown ? 'park_runs_factor')   AS k_park,
      count(*) FILTER (WHERE breakdown ? 'weather_temp_f')     AS k_temp,
      count(*) FILTER (WHERE breakdown ? 'weather_wind_mph')   AS k_wind,
      count(*) FILTER (WHERE breakdown ? 'umpire_k_zone_idx')  AS k_ump,
      count(*) FILTER (WHERE breakdown ? 'raw_edge')           AS k_re,
      min(game_date) AS first_dt, max(game_date) AS last_dt
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §A.1] n=% w/breakdown=% proj=% hrpg=% arpg=% hrapg=% arapg=% hpera=% apera=% hbp=% abp=% park=% temp=% wind=% ump=% raw_edge=% (% .. %)',
    r.n_total, r.n_w_breakdown, r.k_proj, r.k_hrpg, r.k_arpg, r.k_hrapg, r.k_arapg,
    r.k_hpera, r.k_apera, r.k_hbp, r.k_abp, r.k_park, r.k_temp, r.k_wind, r.k_ump,
    r.k_re, r.first_dt, r.last_dt; END LOOP;

  -- ===================================================================
  -- §B — Per-input r vs actual total runs (actual_value)
  -- ===================================================================
  RAISE NOTICE '======== D-550 §B: per-input r vs actual total runs ========';

  FOR r IN
    SELECT 'proj_total (current model)' AS input,
      ROUND(corr((breakdown->>'proj_total')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'proj_total' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §B.1] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'home_rpg (offense)' AS input,
      ROUND(corr((breakdown->>'home_rpg')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'home_rpg' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §B.2] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'away_rpg (offense)' AS input,
      ROUND(corr((breakdown->>'away_rpg')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'away_rpg' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §B.3] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'home_rapg (runs allowed)' AS input,
      ROUND(corr((breakdown->>'home_rapg')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'home_rapg' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §B.4] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'away_rapg (runs allowed)' AS input,
      ROUND(corr((breakdown->>'away_rapg')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'away_rapg' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §B.5] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'home_pitcher_era (lower=better)' AS input,
      ROUND(corr((breakdown->>'home_pitcher_era')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'home_pitcher_era' AND actual_value IS NOT NULL
      AND (breakdown->>'home_pitcher_era') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-550 §B.6] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'away_pitcher_era (lower=better)' AS input,
      ROUND(corr((breakdown->>'away_pitcher_era')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'away_pitcher_era' AND actual_value IS NOT NULL
      AND (breakdown->>'away_pitcher_era') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-550 §B.7] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'home_bullpen_era' AS input,
      ROUND(corr((breakdown->>'home_bullpen_era')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'home_bullpen_era' AND actual_value IS NOT NULL
      AND (breakdown->>'home_bullpen_era') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-550 §B.8] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'away_bullpen_era' AS input,
      ROUND(corr((breakdown->>'away_bullpen_era')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'away_bullpen_era' AND actual_value IS NOT NULL
      AND (breakdown->>'away_bullpen_era') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-550 §B.9] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'park_runs_factor' AS input,
      ROUND(corr((breakdown->>'park_runs_factor')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'park_runs_factor' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §B.10] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'weather_temp_f' AS input,
      ROUND(corr((breakdown->>'weather_temp_f')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'weather_temp_f' AND actual_value IS NOT NULL
      AND (breakdown->>'weather_temp_f') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-550 §B.11] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'weather_wind_mph' AS input,
      ROUND(corr((breakdown->>'weather_wind_mph')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'weather_wind_mph' AND actual_value IS NOT NULL
      AND (breakdown->>'weather_wind_mph') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-550 §B.12] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'umpire_k_zone_idx' AS input,
      ROUND(corr((breakdown->>'umpire_k_zone_idx')::numeric, actual_value)::numeric, 4) AS r, count(*) AS n
    FROM public.pick_history WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown ? 'umpire_k_zone_idx' AND actual_value IS NOT NULL
      AND (breakdown->>'umpire_k_zone_idx') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-550 §B.13] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  -- ===================================================================
  -- §C — Sign-accuracy of current projection (the D-549 lesson check)
  -- ===================================================================
  RAISE NOTICE '======== D-550 §C: current proj_total sign-accuracy ========';
  FOR r IN
    WITH base AS (
      SELECT actual_value, line, (breakdown->>'proj_total')::numeric AS proj
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='game_total'
        AND breakdown ? 'proj_total' AND actual_value IS NOT NULL
    )
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE proj <> line AND actual_value <> line) AS n_directional,
      ROUND(100.0 *
        count(*) FILTER (WHERE
          (proj > line AND actual_value > line) OR (proj < line AND actual_value < line)
        ) / NULLIF(count(*) FILTER (WHERE proj <> line AND actual_value <> line), 0)::numeric, 2) AS sign_acc_pct
    FROM base
  LOOP RAISE NOTICE '[D-550 §C.1] current projection: n=% directional=% sign_acc=%',
    r.n, r.n_directional, r.sign_acc_pct; END LOOP;

  -- ===================================================================
  -- §D — Train/test feasibility + conf-tier depth
  -- ===================================================================
  RAISE NOTICE '======== D-550 §D: train/test feasibility ========';
  FOR r IN
    SELECT
      count(*) AS n_all,
      count(*) FILTER (WHERE confidence >= 70) AS n_c70,
      count(*) FILTER (WHERE confidence >= 80) AS n_c80,
      count(*) FILTER (WHERE confidence >= 70 AND abs(hashtext(id::text)) % 4 = 0) AS holdout_c70,
      count(*) FILTER (WHERE confidence >= 70 AND abs(hashtext(id::text)) % 4 != 0) AS train_c70
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='game_total'
      AND breakdown IS NOT NULL AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-550 §D.1] n_all=% c70=% c80=% holdout(c70)=% train(c70)=%',
    r.n_all, r.n_c70, r.n_c80, r.holdout_c70, r.train_c70; END LOOP;
END $$;
