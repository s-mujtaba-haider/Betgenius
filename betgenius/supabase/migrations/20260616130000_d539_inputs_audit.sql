-- D-539 SHIP 1+2 — inputs audit for batter_rbis projection rebuild.
-- What fields are available in breakdown JSONB on resolved organic
-- batter_rbis picks? Which correlate best with actual_value?
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  RAISE NOTICE '======== D-539 §A: batter_rbis key coverage ========';
  FOR r IN
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE breakdown ? 'projected_stat') AS k_proj,
      count(*) FILTER (WHERE breakdown ? 'season_iso') AS k_iso,
      count(*) FILTER (WHERE breakdown ? 'season_hr_per_pa') AS k_hr_per_pa,
      count(*) FILTER (WHERE breakdown ? 'season_avg_per_game') AS k_apg,
      count(*) FILTER (WHERE breakdown ? 'last10_avg') AS k_l10,
      count(*) FILTER (WHERE breakdown ? 'lineup_spot') AS k_slot,
      count(*) FILTER (WHERE breakdown ? 'park_hits_factor') AS k_park_hits,
      count(*) FILTER (WHERE breakdown ? 'park_hr_factor') AS k_park_hr,
      count(*) FILTER (WHERE breakdown ? 'pitcher_era') AS k_pera,
      count(*) FILTER (WHERE breakdown ? 'opposing_bullpen_era') AS k_oppbp,
      count(*) FILTER (WHERE breakdown ? 'pitcher_hr9') AS k_phr9
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §A.1] n=% k_proj=% k_iso=% k_hrpa=% k_apg=% k_l10=% k_slot=% k_phits=% k_phr=% k_pera=% k_oppbp=% k_phr9=%',
    r.n, r.k_proj, r.k_iso, r.k_hr_per_pa, r.k_apg, r.k_l10, r.k_slot,
    r.k_park_hits, r.k_park_hr, r.k_pera, r.k_oppbp, r.k_phr9; END LOOP;

  RAISE NOTICE '======== D-539 §B: per-input Pearson r vs actual_value (n=resolved organic batter_rbis) ========';
  FOR r IN
    SELECT
      'projected_stat (current)' AS input,
      ROUND(corr((breakdown->>'projected_stat')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'projected_stat'
      AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.1] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_avg_per_game (raw)' AS input,
      ROUND(corr((breakdown->>'season_avg_per_game')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'season_avg_per_game' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.2] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_iso (power signal)' AS input,
      ROUND(corr((breakdown->>'season_iso')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'season_iso' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.3] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_hr_per_pa' AS input,
      ROUND(corr((breakdown->>'season_hr_per_pa')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'season_hr_per_pa' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.4] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'last10_avg' AS input,
      ROUND(corr((breakdown->>'last10_avg')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'last10_avg' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.5] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'lineup_spot (slot 1-9)' AS input,
      ROUND(corr((breakdown->>'lineup_spot')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'lineup_spot' AND actual_value IS NOT NULL
      AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
  LOOP RAISE NOTICE '[D-539 §B.6] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  -- Park factor correlation
  FOR r IN
    SELECT 'park_runs_factor (NOT YET in breakdown — using hits as proxy)' AS input,
      ROUND(corr((breakdown->>'park_hits_factor')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'park_hits_factor' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.7] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'park_hr_factor' AS input,
      ROUND(corr((breakdown->>'park_hr_factor')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'park_hr_factor' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.8] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'opposing_bullpen_era (D-283)' AS input,
      ROUND(corr((breakdown->>'opposing_bullpen_era')::numeric, actual_value)::numeric, 3) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'opposing_bullpen_era' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-539 §B.9] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  -- §C — Empirical RBI/game by lineup_spot (the cleanup-vs-leadoff signal)
  RAISE NOTICE '======== D-539 §C: empirical RBI/game by lineup slot ========';
  FOR r IN
    SELECT
      (breakdown->>'lineup_spot')::int AS slot,
      count(*) AS n,
      ROUND(avg(actual_value)::numeric, 3) AS avg_actual_rbi,
      ROUND(avg((breakdown->>'projected_stat')::numeric)::numeric, 3) AS avg_projection
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
      AND breakdown ? 'lineup_spot'
      AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
      AND actual_value IS NOT NULL
    GROUP BY slot ORDER BY slot
  LOOP RAISE NOTICE '[D-539 §C.1] slot=% n=% avg_actual_rbi=% avg_projection=%',
    r.slot, r.n, r.avg_actual_rbi, r.avg_projection; END LOOP;
END $$;
