-- D-541 SHIP 1 — batter_total_bases per-input audit.
--
-- Read-only. Pure SELECTs + RAISE NOTICE. No INSERT/UPDATE/ALTER.
-- Mirrors the D-539 diagnostic pattern (migrations/20260616130000).
--
-- Goal: measure Pearson r vs actual_value for every projection input
-- on the organic resolved batter_total_bases corpus, then verdict
-- whether TB is data-limited (max|r| < 0.15) or rebuildable
-- (some input |r| > 0.20).
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- ===================================================================
  -- §A — Corpus inventory: how many resolved organic batter_total_bases
  -- picks have breakdown JSONB populated, by key.
  -- ===================================================================
  RAISE NOTICE '======== D-541 §A: TB breakdown key coverage ========';
  FOR r IN
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE breakdown ? 'projected_stat')        AS k_proj,
      count(*) FILTER (WHERE breakdown ? 'season_avg_per_game')   AS k_apg,
      count(*) FILTER (WHERE breakdown ? 'last10_avg')            AS k_l10,
      count(*) FILTER (WHERE breakdown ? 'season_iso')            AS k_iso,
      count(*) FILTER (WHERE breakdown ? 'season_hr_per_pa')      AS k_hr_per_pa,
      count(*) FILTER (WHERE breakdown ? 'season_ba')             AS k_sba,
      count(*) FILTER (WHERE breakdown ? 'season_babip')          AS k_babip,
      count(*) FILTER (WHERE breakdown ? 'statcast_brl_pa')       AS k_brl,
      count(*) FILTER (WHERE breakdown ? 'statcast_xslg_diff')    AS k_xslg,
      count(*) FILTER (WHERE breakdown ? 'statcast_xba')          AS k_xba,
      count(*) FILTER (WHERE breakdown ? 'statcast_avg_hit_speed') AS k_evt,
      count(*) FILTER (WHERE breakdown ? 'pitcher_era')           AS k_pera,
      count(*) FILTER (WHERE breakdown ? 'pitcher_hr9')           AS k_phr9,
      count(*) FILTER (WHERE breakdown ? 'park_hits_factor')      AS k_phits,
      count(*) FILTER (WHERE breakdown ? 'park_hr_factor')        AS k_phr,
      count(*) FILTER (WHERE breakdown ? 'lineup_spot')           AS k_slot,
      count(*) FILTER (WHERE breakdown ? 'opposing_bullpen_era')  AS k_oppbp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown IS NOT NULL AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §A.1] n=% proj=% apg=% l10=% iso=% hr_pa=% ba=% babip=% brl=% xslg=% xba=% evt=% pera=% phr9=% phits=% phr=% slot=% oppbp=%',
    r.n, r.k_proj, r.k_apg, r.k_l10, r.k_iso, r.k_hr_per_pa, r.k_sba, r.k_babip,
    r.k_brl, r.k_xslg, r.k_xba, r.k_evt, r.k_pera, r.k_phr9, r.k_phits, r.k_phr,
    r.k_slot, r.k_oppbp; END LOOP;

  -- ===================================================================
  -- §B — Per-input Pearson r vs actual TB on resolved organic corpus.
  -- Each row reports: input name, r (signed), n.
  -- Threshold (per spec): r >= 0.20 = signal-carrying; |r| < 0.15 = noise.
  -- ===================================================================
  RAISE NOTICE '======== D-541 §B: per-input r vs actual TB ========';

  FOR r IN
    SELECT 'projected_stat (current model)' AS input,
      ROUND(corr((breakdown->>'projected_stat')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.1] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_avg_per_game (TB/G raw)' AS input,
      ROUND(corr((breakdown->>'season_avg_per_game')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'season_avg_per_game' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.2] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'last10_avg (recent TB/G)' AS input,
      ROUND(corr((breakdown->>'last10_avg')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'last10_avg' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.3] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_iso (power)' AS input,
      ROUND(corr((breakdown->>'season_iso')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'season_iso' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.4] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_hr_per_pa' AS input,
      ROUND(corr((breakdown->>'season_hr_per_pa')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'season_hr_per_pa' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.5] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_ba (BA)' AS input,
      ROUND(corr((breakdown->>'season_ba')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'season_ba' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.6] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'season_babip' AS input,
      ROUND(corr((breakdown->>'season_babip')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'season_babip' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.7] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  -- Statcast power inputs (the TB-relevant rebuild candidates)
  FOR r IN
    SELECT 'statcast_brl_pa (barrel% per PA)' AS input,
      ROUND(corr((breakdown->>'statcast_brl_pa')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'statcast_brl_pa' AND actual_value IS NOT NULL
      AND (breakdown->>'statcast_brl_pa') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-541 §B.8] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'statcast_xslg_diff (actual SLG - expected SLG)' AS input,
      ROUND(corr((breakdown->>'statcast_xslg_diff')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'statcast_xslg_diff' AND actual_value IS NOT NULL
      AND (breakdown->>'statcast_xslg_diff') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-541 §B.9] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'statcast_xba (expected BA)' AS input,
      ROUND(corr((breakdown->>'statcast_xba')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'statcast_xba' AND actual_value IS NOT NULL
      AND (breakdown->>'statcast_xba') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-541 §B.10] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'statcast_avg_hit_speed (exit velo)' AS input,
      ROUND(corr((breakdown->>'statcast_avg_hit_speed')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'statcast_avg_hit_speed' AND actual_value IS NOT NULL
      AND (breakdown->>'statcast_avg_hit_speed') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-541 §B.11] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  -- Context inputs
  FOR r IN
    SELECT 'pitcher_era' AS input,
      ROUND(corr((breakdown->>'pitcher_era')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'pitcher_era' AND actual_value IS NOT NULL
      AND (breakdown->>'pitcher_era') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-541 §B.12] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'pitcher_hr9 (HR/9 allowed)' AS input,
      ROUND(corr((breakdown->>'pitcher_hr9')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'pitcher_hr9' AND actual_value IS NOT NULL
      AND (breakdown->>'pitcher_hr9') ~ '^-?[0-9.]+$'
  LOOP RAISE NOTICE '[D-541 §B.13] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'park_hits_factor (USED in current proj)' AS input,
      ROUND(corr((breakdown->>'park_hits_factor')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'park_hits_factor' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.14] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'park_hr_factor (CANDIDATE for TB)' AS input,
      ROUND(corr((breakdown->>'park_hr_factor')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'park_hr_factor' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-541 §B.15] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  FOR r IN
    SELECT 'lineup_spot' AS input,
      ROUND(corr((breakdown->>'lineup_spot')::numeric, actual_value)::numeric, 4) AS r,
      count(*) AS n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'lineup_spot' AND actual_value IS NOT NULL
      AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
  LOOP RAISE NOTICE '[D-541 §B.16] %: r=% n=%', r.input, r.r, r.n; END LOOP;

  -- ===================================================================
  -- §C — Empirical TB/game by lineup slot (context check)
  -- ===================================================================
  RAISE NOTICE '======== D-541 §C: empirical TB/game by lineup slot ========';
  FOR r IN
    SELECT
      (breakdown->>'lineup_spot')::int AS slot,
      count(*) AS n,
      ROUND(avg(actual_value)::numeric, 3) AS avg_actual_tb,
      ROUND(avg((breakdown->>'projected_stat')::numeric)::numeric, 3) AS avg_projection,
      ROUND(avg(line)::numeric, 3) AS avg_line
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'lineup_spot' AND actual_value IS NOT NULL
      AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
    GROUP BY slot ORDER BY slot
  LOOP RAISE NOTICE '[D-541 §C.1] slot=% n=% avg_actual_tb=% avg_proj=% avg_line=%',
    r.slot, r.n, r.avg_actual_tb, r.avg_projection, r.avg_line; END LOOP;

  -- ===================================================================
  -- §D — Sign-accuracy of current projection (the D-538 hard-gate test).
  -- For each pick: did (projected_stat > line) === (actual_value > line)?
  -- Anything > 50% means the projection's DIRECTION call beats coin flip.
  -- This is the D-539 V4/V6 trap — high r but below-chance direction.
  -- ===================================================================
  RAISE NOTICE '======== D-541 §D: current projection sign-accuracy ========';
  FOR r IN
    WITH base AS (
      SELECT actual_value, line, (breakdown->>'projected_stat')::numeric AS proj
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
        AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
    )
    SELECT
      count(*) AS n,
      count(*) FILTER (WHERE proj <> line AND actual_value <> line) AS n_directional,
      ROUND( 100.0 *
        count(*) FILTER (WHERE
          (proj > line  AND actual_value > line) OR
          (proj < line  AND actual_value < line)
        ) / NULLIF(count(*) FILTER (WHERE proj <> line AND actual_value <> line), 0)::numeric
      , 2) AS sign_acc_pct
    FROM base
  LOOP RAISE NOTICE '[D-541 §D.1] current projection: n=% directional=% sign_acc=%%%',
    r.n, r.n_directional, r.sign_acc_pct; END LOOP;

  -- Sign-accuracy of each individual input as a DIRECT projection
  -- (using the input's own threshold = its own median, since the input
  -- isn't unit-aligned with TB). Skipped for §D — the rebuild
  -- candidates in SHIP 2 will produce a unit-aligned projected_stat and
  -- §D logic re-runs there.

  -- ===================================================================
  -- §E — Slice the corpus by side (over vs under) — is one side noisier?
  -- ===================================================================
  RAISE NOTICE '======== D-541 §E: r breakdown by pick_side ========';
  FOR r IN
    SELECT
      pick_side,
      count(*) AS n,
      ROUND(corr((breakdown->>'projected_stat')::numeric, actual_value)::numeric, 4) AS r_proj,
      ROUND(corr((breakdown->>'season_avg_per_game')::numeric, actual_value)::numeric, 4) AS r_apg,
      ROUND(corr(
        CASE WHEN (breakdown->>'statcast_avg_hit_speed') ~ '^-?[0-9.]+$'
             THEN (breakdown->>'statcast_avg_hit_speed')::numeric END,
        actual_value
      )::numeric, 4) AS r_evt
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
    GROUP BY pick_side
  LOOP RAISE NOTICE '[D-541 §E.1] side=% n=% r_proj=% r_apg=% r_evt=%',
    r.pick_side, r.n, r.r_proj, r.r_apg, r.r_evt; END LOOP;
END $$;
