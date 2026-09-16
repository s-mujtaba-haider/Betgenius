-- D-539 SHIP 2-3 — Build multiple candidate rebuilds + correlate each
-- with actual_value to find the best possible OOS predictor.
--
-- The candidate formulas:
--   V0 CURRENT       proj = stored projection (r baseline = 0.073)
--   V1 SEASON_ONLY   proj = season_avg_per_game           (r baseline = 0.095)
--   V2 SLOT_LOOKUP   proj = league_typical_slot_baseline   (lineup-only)
--   V3 SLOT+POWER    proj = slot_baseline × (1 + 2 × iso)
--   V4 SLOT+POWER+CTX proj = slot_baseline × (1 + 2 × iso)
--                            × (pitcher_era / 4.20)
--                            × park_runs_proxy
--                            × (bullpen_era / 4.00)
--   V5 BLEND         proj = 0.4 × season_avg + 0.6 × V4
--   V6 RIDGE-FIT     proj = α + β1·season_avg + β2·iso + β3·slot
--                          (manually-tuned linear blend)
--
-- Slot baseline multipliers (league-typical RBI/game, normalized):
--   slot 1: 0.45    (leadoff — leads off games with nobody on)
--   slot 2: 0.50
--   slot 3: 0.65    (RBI spot)
--   slot 4: 0.70    (cleanup — most RBI ops)
--   slot 5: 0.60
--   slot 6: 0.55
--   slot 7: 0.45
--   slot 8: 0.35
--   slot 9: 0.40
--
-- READ-ONLY. Compares Pearson r on the FULL organic resolved batter_rbis
-- corpus (n=2,228 with breakdown).
WITH base AS (
  SELECT
    id, hit, line, pick_side, odds, confidence,
    actual_value,
    game_date,
    (breakdown->>'projected_stat')::numeric AS v0_current,
    (breakdown->>'season_avg_per_game')::numeric AS season_apg,
    (breakdown->>'season_iso')::numeric AS iso,
    (breakdown->>'season_hr_per_pa')::numeric AS hr_per_pa,
    (breakdown->>'last10_avg')::numeric AS l10_avg,
    (breakdown->>'lineup_spot')::int AS slot,
    (breakdown->>'park_hits_factor')::numeric AS park_hits,
    (breakdown->>'park_hr_factor')::numeric AS park_hr,
    (breakdown->>'pitcher_era')::numeric AS pitcher_era,
    COALESCE((breakdown->>'opposing_bullpen_era')::numeric, 4.0) AS bp_era
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
    AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
    AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
    AND breakdown ? 'lineup_spot'
    AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
),
scored AS (
  SELECT id, hit, line, pick_side, odds, confidence, actual_value, game_date,
    v0_current,
    -- V1: season-only baseline
    season_apg AS v1_season_only,
    -- V2: slot lookup (league-typical RBI/game by slot)
    CASE slot
      WHEN 1 THEN 0.45  WHEN 2 THEN 0.50  WHEN 3 THEN 0.65
      WHEN 4 THEN 0.70  WHEN 5 THEN 0.60  WHEN 6 THEN 0.55
      WHEN 7 THEN 0.45  WHEN 8 THEN 0.35  WHEN 9 THEN 0.40
      ELSE 0.50 END AS v2_slot_only,
    -- V3: slot × (1 + 2×iso)
    CASE slot
      WHEN 1 THEN 0.45  WHEN 2 THEN 0.50  WHEN 3 THEN 0.65
      WHEN 4 THEN 0.70  WHEN 5 THEN 0.60  WHEN 6 THEN 0.55
      WHEN 7 THEN 0.45  WHEN 8 THEN 0.35  WHEN 9 THEN 0.40
      ELSE 0.50 END * (1 + 2 * COALESCE(iso, 0.140)) AS v3_slot_power,
    -- V4: V3 × pitcher × park × bullpen
    CASE slot
      WHEN 1 THEN 0.45  WHEN 2 THEN 0.50  WHEN 3 THEN 0.65
      WHEN 4 THEN 0.70  WHEN 5 THEN 0.60  WHEN 6 THEN 0.55
      WHEN 7 THEN 0.45  WHEN 8 THEN 0.35  WHEN 9 THEN 0.40
      ELSE 0.50 END
      * (1 + 2 * COALESCE(iso, 0.140))
      * GREATEST(0.80, LEAST(1.25, pitcher_era / 4.20))
      * COALESCE(park_hits, 1.0)
      * GREATEST(0.90, LEAST(1.15, bp_era / 4.00))
      AS v4_full_context,
    -- V5: BLEND (0.4 × season_avg + 0.6 × V4)
    0.4 * season_apg + 0.6 * (
      CASE slot
        WHEN 1 THEN 0.45  WHEN 2 THEN 0.50  WHEN 3 THEN 0.65
        WHEN 4 THEN 0.70  WHEN 5 THEN 0.60  WHEN 6 THEN 0.55
        WHEN 7 THEN 0.45  WHEN 8 THEN 0.35  WHEN 9 THEN 0.40
        ELSE 0.50 END
      * (1 + 2 * COALESCE(iso, 0.140))
      * GREATEST(0.80, LEAST(1.25, pitcher_era / 4.20))
      * COALESCE(park_hits, 1.0)
    ) AS v5_blend,
    -- V6: linear blend (manually tuned): proj = 0.35*season_apg + 0.30*slot_base + 0.30*power_signal + 0.05*park
    0.35 * season_apg
    + 0.30 * (CASE slot
        WHEN 1 THEN 0.45 WHEN 2 THEN 0.50 WHEN 3 THEN 0.65
        WHEN 4 THEN 0.70 WHEN 5 THEN 0.60 WHEN 6 THEN 0.55
        WHEN 7 THEN 0.45 WHEN 8 THEN 0.35 WHEN 9 THEN 0.40
        ELSE 0.50 END)
    + 0.30 * (iso * 4.5 + COALESCE(hr_per_pa, 0.025) * 15)
    + 0.05 * (park_hits * 0.5 + park_hr * 0.5)
      AS v6_ridge
  FROM base
)
SELECT
  ROUND(corr(v0_current, actual_value)::numeric, 4) AS r_v0_current,
  ROUND(corr(v1_season_only, actual_value)::numeric, 4) AS r_v1_season,
  ROUND(corr(v2_slot_only, actual_value)::numeric, 4) AS r_v2_slot,
  ROUND(corr(v3_slot_power, actual_value)::numeric, 4) AS r_v3_slot_pow,
  ROUND(corr(v4_full_context, actual_value)::numeric, 4) AS r_v4_full,
  ROUND(corr(v5_blend, actual_value)::numeric, 4) AS r_v5_blend,
  ROUND(corr(v6_ridge, actual_value)::numeric, 4) AS r_v6_ridge,
  count(*) AS n
INTO TEMP TABLE d539_rs
FROM scored;

-- Print results
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-539 §D: Pearson r per candidate rebuild (n=2,001 organic with slot) ========';
  FOR r IN SELECT * FROM d539_rs LOOP
    RAISE NOTICE '[D-539 §D.1] v0_current=% v1_season=% v2_slot=% v3_slot_pow=% v4_full=% v5_blend=% v6_ridge=% n=%',
      r.r_v0_current, r.r_v1_season, r.r_v2_slot, r.r_v3_slot_pow, r.r_v4_full, r.r_v5_blend, r.r_v6_ridge, r.n;
  END LOOP;
END $$;

-- §E — Sign-accuracy comparison per candidate
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-539 §E: sign-accuracy per candidate ========';
  FOR r IN
    WITH s AS (
      SELECT
        id, hit, line, actual_value, pick_side,
        v0_current,
        season_apg AS v1,
        CASE slot
          WHEN 1 THEN 0.45  WHEN 2 THEN 0.50  WHEN 3 THEN 0.65
          WHEN 4 THEN 0.70  WHEN 5 THEN 0.60  WHEN 6 THEN 0.55
          WHEN 7 THEN 0.45  WHEN 8 THEN 0.35  WHEN 9 THEN 0.40
          ELSE 0.50 END
          * (1 + 2 * COALESCE(iso, 0.140))
          * GREATEST(0.80, LEAST(1.25, pitcher_era / 4.20))
          * COALESCE(park_hits, 1.0)
          AS v4,
        0.35 * season_apg
        + 0.30 * (CASE slot
            WHEN 1 THEN 0.45 WHEN 2 THEN 0.50 WHEN 3 THEN 0.65
            WHEN 4 THEN 0.70 WHEN 5 THEN 0.60 WHEN 6 THEN 0.55
            WHEN 7 THEN 0.45 WHEN 8 THEN 0.35 WHEN 9 THEN 0.40
            ELSE 0.50 END)
        + 0.30 * (iso * 4.5 + COALESCE(hr_per_pa, 0.025) * 15)
        + 0.05 * (park_hits * 0.5 + park_hr * 0.5)
        AS v6
      FROM (
        SELECT id, hit, line, pick_side, actual_value,
          (breakdown->>'projected_stat')::numeric AS v0_current,
          (breakdown->>'season_avg_per_game')::numeric AS season_apg,
          (breakdown->>'season_iso')::numeric AS iso,
          (breakdown->>'season_hr_per_pa')::numeric AS hr_per_pa,
          (breakdown->>'lineup_spot')::int AS slot,
          (breakdown->>'park_hits_factor')::numeric AS park_hits,
          (breakdown->>'park_hr_factor')::numeric AS park_hr,
          (breakdown->>'pitcher_era')::numeric AS pitcher_era
        FROM public.pick_history
        WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
          AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
          AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
          AND breakdown ? 'lineup_spot'
          AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
      ) b
    )
    SELECT
      ROUND(100.0 * count(*) FILTER (WHERE
        ((v0_current > line) AND (actual_value > line)) OR
        ((v0_current < line) AND (actual_value < line)) OR
        ((v0_current = line) AND (actual_value = line))
      ) / NULLIF(count(*),0), 1) AS sign_v0,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((v1 > line) AND (actual_value > line)) OR
        ((v1 < line) AND (actual_value < line)) OR
        ((v1 = line) AND (actual_value = line))
      ) / NULLIF(count(*),0), 1) AS sign_v1,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((v4 > line) AND (actual_value > line)) OR
        ((v4 < line) AND (actual_value < line)) OR
        ((v4 = line) AND (actual_value = line))
      ) / NULLIF(count(*),0), 1) AS sign_v4,
      ROUND(100.0 * count(*) FILTER (WHERE
        ((v6 > line) AND (actual_value > line)) OR
        ((v6 < line) AND (actual_value < line)) OR
        ((v6 = line) AND (actual_value = line))
      ) / NULLIF(count(*),0), 1) AS sign_v6,
      count(*) AS n
    FROM s
  LOOP RAISE NOTICE '[D-539 §E.1] sign_v0=% sign_v1=% sign_v4=% sign_v6=% n=%',
    r.sign_v0, r.sign_v1, r.sign_v4, r.sign_v6, r.n; END LOOP;
END $$;

-- §F — OOS holdout split for the best candidate (V6 or whichever V_X has highest r)
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-539 §F: OOS holdout (game_date > 2026-06-05) r per candidate ========';
  FOR r IN
    WITH b AS (
      SELECT
        actual_value,
        (breakdown->>'projected_stat')::numeric AS v0,
        (breakdown->>'season_avg_per_game')::numeric AS season_apg,
        (breakdown->>'season_iso')::numeric AS iso,
        (breakdown->>'season_hr_per_pa')::numeric AS hr_per_pa,
        (breakdown->>'lineup_spot')::int AS slot,
        (breakdown->>'park_hits_factor')::numeric AS park_hits,
        (breakdown->>'park_hr_factor')::numeric AS park_hr,
        (breakdown->>'pitcher_era')::numeric AS pitcher_era
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='batter_rbis'
        AND breakdown ? 'projected_stat' AND actual_value IS NOT NULL
        AND breakdown ? 'lineup_spot'
        AND (breakdown->>'lineup_spot')::numeric BETWEEN 1 AND 9
        AND game_date > '2026-06-05'::date
    ),
    s AS (
      SELECT actual_value,
        v0,
        season_apg AS v1,
        CASE slot WHEN 1 THEN 0.45 WHEN 2 THEN 0.50 WHEN 3 THEN 0.65
          WHEN 4 THEN 0.70 WHEN 5 THEN 0.60 WHEN 6 THEN 0.55
          WHEN 7 THEN 0.45 WHEN 8 THEN 0.35 WHEN 9 THEN 0.40
          ELSE 0.50 END * (1 + 2 * COALESCE(iso, 0.140))
          * GREATEST(0.80, LEAST(1.25, pitcher_era / 4.20))
          * COALESCE(park_hits, 1.0)
          AS v4,
        0.35 * season_apg
        + 0.30 * (CASE slot
            WHEN 1 THEN 0.45 WHEN 2 THEN 0.50 WHEN 3 THEN 0.65
            WHEN 4 THEN 0.70 WHEN 5 THEN 0.60 WHEN 6 THEN 0.55
            WHEN 7 THEN 0.45 WHEN 8 THEN 0.35 WHEN 9 THEN 0.40
            ELSE 0.50 END)
        + 0.30 * (iso * 4.5 + COALESCE(hr_per_pa, 0.025) * 15)
        + 0.05 * (park_hits * 0.5 + park_hr * 0.5)
        AS v6
      FROM b
    )
    SELECT
      ROUND(corr(v0, actual_value)::numeric, 4) AS r_v0,
      ROUND(corr(v1, actual_value)::numeric, 4) AS r_v1,
      ROUND(corr(v4, actual_value)::numeric, 4) AS r_v4,
      ROUND(corr(v6, actual_value)::numeric, 4) AS r_v6,
      count(*) AS n
    FROM s
  LOOP RAISE NOTICE '[D-539 §F.1 HOLDOUT] r_v0=% r_v1=% r_v4=% r_v6=% n=%',
    r.r_v0, r.r_v1, r.r_v4, r.r_v6, r.n; END LOOP;
END $$;
