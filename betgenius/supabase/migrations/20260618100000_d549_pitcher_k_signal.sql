-- D-549 SHIP 1 — pitcher_k signal gate.
--
-- Read-only. Mirrors D-541 SHIP 1 pattern. Goal: measure per-input
-- Pearson r vs actual strikeouts on the organic resolved pitcher_k
-- corpus. Gate the optimizer:
--   max|r| < 0.15  → STOP, input-limited, don't optimize noise
--   some |r| > 0.20 → proceed with rebuild/optimizer

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- ===================================================================
  -- §A — Corpus depth + breakdown key coverage
  -- ===================================================================
  RAISE NOTICE '======== D-549 §A: pitcher_k corpus depth + key coverage ========';
  FOR r IN
    SELECT
      count(*) AS n_total,
      count(*) FILTER (WHERE breakdown IS NOT NULL AND breakdown <> '{}'::jsonb) AS n_w_breakdown,
      count(*) FILTER (WHERE breakdown ? 'projected_k') AS k_proj,
      count(*) FILTER (WHERE breakdown ? 'season_k_per_start') AS k_skps,
      count(*) FILTER (WHERE breakdown ? 'season_k_per_nine') AS k_sk9,
      count(*) FILTER (WHERE breakdown ? 'last5_k_avg') AS k_l5,
      count(*) FILTER (WHERE breakdown ? 'opp_k_rate_pct') AS k_okr,
      count(*) FILTER (WHERE breakdown ? 'park_k_factor') AS k_park,
      count(*) FILTER (WHERE breakdown ? 'umpire_k_zone_idx') AS k_ump,
      count(*) FILTER (WHERE breakdown ? 'statcast_xera') AS k_xera,
      count(*) FILTER (WHERE breakdown ? 'statcast_pitcher_baa') AS k_baa,
      count(*) FILTER (WHERE breakdown ? 'catcher_framing_rv_tot') AS k_cf,
      count(*) FILTER (WHERE breakdown ? 'arsenal_breaking_ball_pct') AS k_brk,
      count(*) FILTER (WHERE breakdown ? 'lineup_k_weighted_rate') AS k_lkw,
      count(*) FILTER (WHERE breakdown ? 'primary_fb_velo') AS k_velo,
      min(game_date) AS first_dt, max(game_date) AS last_dt
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §A.1] n=% w/breakdown=% proj=% skps=% sk9=% l5=% okr=% park=% ump=% xera=% baa=% cf=% brk=% lkw=% velo=% (% .. %)',
    r.n_total, r.n_w_breakdown, r.k_proj, r.k_skps, r.k_sk9, r.k_l5,
    r.k_okr, r.k_park, r.k_ump, r.k_xera, r.k_baa, r.k_cf, r.k_brk, r.k_lkw, r.k_velo,
    r.first_dt, r.last_dt; END LOOP;

  -- ===================================================================
  -- §B — Per-input Pearson r vs actual K, organic resolved corpus
  -- ===================================================================
  RAISE NOTICE '======== D-549 §B: per-input r vs actual K ========';

  FOR r IN
    SELECT 'projected_k (current model)' AS input,
      ROUND(corr((breakdown->>'projected_k')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §B.1] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_k_per_start' AS input,
      ROUND(corr((breakdown->>'season_k_per_start')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'season_k_per_start' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §B.2] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_k_per_nine' AS input,
      ROUND(corr((breakdown->>'season_k_per_nine')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'season_k_per_nine' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §B.3] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'last5_k_avg (recent form)' AS input,
      ROUND(corr((breakdown->>'last5_k_avg')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'last5_k_avg' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §B.4] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'blended_projection' AS input,
      ROUND(corr((breakdown->>'blended_projection')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'blended_projection' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §B.5] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'opp_k_rate_pct' AS input,
      ROUND(corr((breakdown->>'opp_k_rate_pct')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'opp_k_rate_pct' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §B.6] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'park_k_factor' AS input,
      ROUND(corr((breakdown->>'park_k_factor')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'park_k_factor' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §B.7] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'umpire_k_zone_idx' AS input,
      ROUND(corr((breakdown->>'umpire_k_zone_idx')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'umpire_k_zone_idx' AND actual_value IS NOT NULL
      AND (breakdown->>'umpire_k_zone_idx') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-549 §B.8] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'statcast_xera (lower = better)' AS input,
      ROUND(corr((breakdown->>'statcast_xera')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'statcast_xera' AND actual_value IS NOT NULL
      AND (breakdown->>'statcast_xera') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-549 §B.9] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'statcast_pitcher_baa (lower=better)' AS input,
      ROUND(corr((breakdown->>'statcast_pitcher_baa')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'statcast_pitcher_baa' AND actual_value IS NOT NULL
      AND (breakdown->>'statcast_pitcher_baa') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-549 §B.10] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'catcher_framing_rv_tot' AS input,
      ROUND(corr((breakdown->>'catcher_framing_rv_tot')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'catcher_framing_rv_tot' AND actual_value IS NOT NULL
      AND (breakdown->>'catcher_framing_rv_tot') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-549 §B.11] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'arsenal_breaking_ball_pct' AS input,
      ROUND(corr((breakdown->>'arsenal_breaking_ball_pct')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'arsenal_breaking_ball_pct' AND actual_value IS NOT NULL
      AND (breakdown->>'arsenal_breaking_ball_pct') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-549 §B.12] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'lineup_k_weighted_rate (D-354)' AS input,
      ROUND(corr((breakdown->>'lineup_k_weighted_rate')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'lineup_k_weighted_rate' AND actual_value IS NOT NULL
      AND (breakdown->>'lineup_k_weighted_rate') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-549 §B.13] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'primary_fb_velo' AS input,
      ROUND(corr((breakdown->>'primary_fb_velo')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'primary_fb_velo' AND actual_value IS NOT NULL
      AND (breakdown->>'primary_fb_velo') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-549 §B.14] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  -- ===================================================================
  -- §C — Sign-accuracy of current projection (D-538 hard-gate test)
  -- ===================================================================
  RAISE NOTICE '======== D-549 §C: current projected_k sign-accuracy ========';
  FOR r IN
    WITH base AS (
      SELECT actual_value, line, (breakdown->>'projected_k')::numeric AS proj
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
        AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
    )
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE proj <> line AND actual_value <> line) AS n_directional,
      ROUND( 100.0 *
        count(*) FILTER (WHERE
          (proj > line AND actual_value > line) OR
          (proj < line AND actual_value < line)
        ) / NULLIF(count(*) FILTER (WHERE proj <> line AND actual_value <> line), 0)::numeric
      , 2) AS sign_acc_pct
    FROM base
  LOOP RAISE NOTICE '[D-549 §C.1] current projection: n=% n_directional=% sign_acc=%',
    r.n, r.n_directional, r.sign_acc_pct; END LOOP;

  -- ===================================================================
  -- §D — Train/test feasibility check.
  -- We need n_train >= 100 picks at conf>=70 for stable weight search.
  -- Holdout n >= 100 for stable OOS readout. Hash-partition 75/25 by id.
  -- ===================================================================
  RAISE NOTICE '======== D-549 §D: train/test feasibility ========';
  FOR r IN
    SELECT
      count(*) AS n_all,
      count(*) FILTER (WHERE confidence >= 70) AS n_c70,
      count(*) FILTER (WHERE confidence >= 80) AS n_c80,
      count(*) FILTER (WHERE confidence >= 70 AND abs(hashtext(id::text)) % 4 = 0) AS holdout_c70,
      count(*) FILTER (WHERE confidence >= 70 AND abs(hashtext(id::text)) % 4 != 0) AS train_c70
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown IS NOT NULL AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-549 §D.1] n_all=% c70=% c80=% holdout(c70)=% train(c70)=%',
    r.n_all, r.n_c70, r.n_c80, r.holdout_c70, r.train_c70; END LOOP;
END $$;
