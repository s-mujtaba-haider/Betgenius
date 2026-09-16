-- D-376 SHIP 1 — FROZEN_AT_ZERO f_raw recovery.
--
-- Re-derives f_raw for the 4 FROZEN_AT_ZERO factors using inputs already stored
-- in pick_history.ai_analysis::jsonb -> factor_breakdown. No re-scoring engine,
-- no external API calls, no re-fetch from caches.
--
-- Factors:
--   fraw_weather_wind         (HR-market batter picks only)
--   fraw_wind_direction_hr    (HR-market batter picks only)
--   fraw_pitcher_hr_per_9     (HR-market batter picks only)
--   fraw_offense_differential (game-side + game-total picks)
--
-- Scope: pick_history rows where
--   backfill_run_id IN (D-358, D-359, D-360-FIX, D-363, D-368) -- the 5 MV-tracked runs
--   AND hit IS NOT NULL
--   AND ai_analysis IS NOT NULL
--   AND prop_type IN ('batter_home_runs', 'game_side', 'game_total')
-- Expected affected count: ~9,601 (8,062 HR + 769 game_side + 770 game_total)
--
-- Write path (NON-DESTRUCTIVE):
--   ai_analysis = jsonb_set(ai_analysis::jsonb, '{factor_breakdown}',
--                   factor_breakdown || {fraw_*: ...})::text
--   Existing score_* keys are NOT modified.
--
-- Rollback (single statement, idempotent):
--   UPDATE public.pick_history SET ai_analysis = jsonb_set(
--     ai_analysis::jsonb, '{factor_breakdown}',
--     (ai_analysis::jsonb -> 'factor_breakdown')
--       - 'fraw_weather_wind' - 'fraw_wind_direction_hr'
--       - 'fraw_pitcher_hr_per_9' - 'fraw_offense_differential'
--   )::text
--   WHERE backfill_run_id IN (...)
--   AND ai_analysis::jsonb -> 'factor_breakdown' ? 'fraw_weather_wind';

CREATE OR REPLACE FUNCTION public.d376_recover_fraw_chunk(
  p_offset INT DEFAULT 0,
  p_limit  INT DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_processed INT := 0;
  v_modified  INT := 0;
  v_skipped_already_has INT := 0;
  v_rec RECORD;
  v_fb JSONB;
  v_ms TEXT;
  v_ps TEXT;
  v_pt TEXT;
  v_sideflip INT;
  v_is_dome BOOLEAN;
  v_ws NUMERIC;
  v_wd NUMERIC;
  v_cf_deg NUMERIC;
  v_hr9 NUMERIC;
  v_ip NUMERIC;
  v_home_rpg NUMERIC;
  v_away_rpg NUMERIC;
  v_market TEXT;
  v_fraw_ww NUMERIC;
  v_fraw_wd_hr NUMERIC;
  v_fraw_hr9 NUMERIC;
  v_fraw_offdiff NUMERIC;
  v_wind_to NUMERIC;
  v_delta NUMERIC;
  v_dir_effect NUMERIC;
  v_speed_mult NUMERIC;
  v_score NUMERIC;
  v_diff NUMERIC;
  v_d NUMERIC;
  v_totoff NUMERIC;
  v_flip INT;
  v_league_avg_rpg CONSTANT NUMERIC := 4.5;
  v_new_fb JSONB;
BEGIN
  FOR v_rec IN
    SELECT
      ph.id,
      ph.ai_analysis::jsonb AS aij,
      ph.prop_type,
      ph.pick_side
    FROM public.pick_history ph
    WHERE ph.backfill_run_id IN (
        '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f',  -- D-358
        '949a88e7-1c20-43e9-a674-ef90e9035f8b',  -- D-359
        'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef',  -- D-360-FIX
        '61ff4c15-4678-4691-865c-264712fed0ca',  -- D-363
        '75bb70d1-6578-4c1f-a637-6f20ea158ce3'   -- D-368
      )
      AND ph.hit IS NOT NULL
      AND ph.ai_analysis IS NOT NULL
      AND ph.prop_type IN ('batter_home_runs','game_side','game_total')
    ORDER BY ph.id
    OFFSET p_offset LIMIT p_limit
  LOOP
    v_processed := v_processed + 1;
    v_fb := v_rec.aij -> 'factor_breakdown';

    -- idempotency guard
    IF v_fb ? 'fraw_weather_wind' OR v_fb ? 'fraw_offense_differential' THEN
      v_skipped_already_has := v_skipped_already_has + 1;
      CONTINUE;
    END IF;

    v_ms := v_fb ->> 'market_stat';
    v_ps := v_rec.pick_side;
    v_pt := v_rec.prop_type;
    v_sideflip := CASE WHEN v_ps = 'under' THEN -1 ELSE 1 END;

    -- defaults — formulas return 0 unless inputs + gates met
    v_fraw_ww      := 0;
    v_fraw_wd_hr   := 0;
    v_fraw_hr9     := 0;
    v_fraw_offdiff := 0;

    -- ===========================================================
    -- HR-MARKET batter factors (batter_home_runs only)
    -- ===========================================================
    IF v_pt = 'batter_home_runs' THEN
      v_is_dome := COALESCE((v_fb ->> 'park_is_dome')::boolean, false);
      v_ws := NULLIF(v_fb ->> 'weather_wind_mph', '')::numeric;
      v_wd := NULLIF(v_fb ->> 'wind_dir_deg', '')::numeric;
      v_cf_deg := NULLIF(v_fb ->> 'park_cf_compass_deg', '')::numeric;
      v_hr9 := NULLIF(v_fb ->> 'pitcher_hr9', '')::numeric;
      v_ip  := NULLIF(v_fb ->> 'opposing_pitcher_ip', '')::numeric;

      -- fraw_weather_wind
      IF NOT v_is_dome AND v_ws IS NOT NULL THEN
        v_fraw_ww := CASE
          WHEN v_ws >= 14 THEN 3 * v_sideflip
          WHEN v_ws >=  8 THEN 1 * v_sideflip
          WHEN v_ws <=  3 THEN -1 * v_sideflip
          ELSE 0
        END;
      END IF;

      -- fraw_wind_direction_hr
      IF NOT v_is_dome AND v_wd IS NOT NULL AND v_ws IS NOT NULL AND v_ws >= 5
         AND v_cf_deg IS NOT NULL THEN
        v_wind_to := ((v_wd + 180)::int % 360)::numeric;
        v_delta := ABS(v_wind_to - v_cf_deg);
        v_delta := (v_delta::int % 360)::numeric;
        IF v_delta > 180 THEN
          v_delta := 360 - v_delta;
        END IF;
        v_dir_effect := cos(v_delta * pi() / 180);
        v_speed_mult := CASE
          WHEN v_ws >= 15 THEN 1.0
          WHEN v_ws >= 10 THEN 0.6
          ELSE 0.3
        END;
        v_score := v_dir_effect * v_speed_mult;
        v_fraw_wd_hr := CASE
          WHEN v_score >= 0.6   THEN 6
          WHEN v_score >= 0.3   THEN 3
          WHEN v_score >= 0.15  THEN 1
          WHEN v_score <= -0.6  THEN -6
          WHEN v_score <= -0.3  THEN -3
          WHEN v_score <= -0.15 THEN -1
          ELSE 0
        END;
        v_fraw_wd_hr := v_fraw_wd_hr * v_sideflip;
      END IF;

      -- fraw_pitcher_hr_per_9
      IF v_hr9 IS NOT NULL AND v_ip IS NOT NULL AND v_ip >= 20 THEN
        v_fraw_hr9 := CASE
          WHEN v_hr9 >= 1.8 THEN 6
          WHEN v_hr9 >= 1.4 THEN 3
          WHEN v_hr9 >= 1.1 THEN 1
          WHEN v_hr9 <= 0.6 THEN -6
          WHEN v_hr9 <= 0.9 THEN -3
          WHEN v_hr9 <= 1.0 THEN -1
          ELSE 0
        END;
        v_fraw_hr9 := v_fraw_hr9 * v_sideflip;
      END IF;
    END IF;

    -- ===========================================================
    -- GAME-MARKET factor (game_side + game_total)
    -- ===========================================================
    IF v_pt IN ('game_side','game_total') THEN
      v_market := v_fb ->> 'market';
      v_home_rpg := NULLIF(v_fb ->> 'home_rpg', '')::numeric;
      v_away_rpg := NULLIF(v_fb ->> 'away_rpg', '')::numeric;

      IF v_home_rpg IS NOT NULL AND v_away_rpg IS NOT NULL THEN
        IF v_market = 'side' THEN
          -- D-339: zeroed on home-side; only away-side computes
          IF v_ps = 'away' THEN
            v_diff := v_home_rpg - v_away_rpg;
            v_d := -v_diff;
            v_fraw_offdiff := CASE
              WHEN v_d >=  1.0  THEN  8
              WHEN v_d >=  0.5  THEN  4
              WHEN v_d >=  0.25 THEN  2
              WHEN v_d <= -1.0  THEN -8
              WHEN v_d <= -0.5  THEN -4
              WHEN v_d <= -0.25 THEN -2
              ELSE 0
            END;
          END IF;
        ELSE
          -- total market
          v_flip := CASE WHEN v_ps = 'over' THEN 1 ELSE -1 END;
          v_totoff := v_home_rpg + v_away_rpg;
          v_d := (v_totoff - 2 * v_league_avg_rpg) * v_flip;
          v_fraw_offdiff := CASE
            WHEN v_d >=  1.5   THEN  8
            WHEN v_d >=  0.75  THEN  4
            WHEN v_d >=  0.3   THEN  2
            WHEN v_d <= -1.5   THEN -8
            WHEN v_d <= -0.75  THEN -4
            WHEN v_d <= -0.3   THEN -2
            ELSE 0
          END;
        END IF;
      END IF;
    END IF;

    -- ===========================================================
    -- Merge new fraw_* keys into factor_breakdown and write back
    -- ===========================================================
    v_new_fb := v_fb || jsonb_build_object(
      'fraw_weather_wind',         v_fraw_ww,
      'fraw_wind_direction_hr',    v_fraw_wd_hr,
      'fraw_pitcher_hr_per_9',     v_fraw_hr9,
      'fraw_offense_differential', v_fraw_offdiff
    );

    UPDATE public.pick_history
    SET ai_analysis = jsonb_set(v_rec.aij, '{factor_breakdown}', v_new_fb)::text
    WHERE id = v_rec.id;

    v_modified := v_modified + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'offset', p_offset,
    'limit', p_limit,
    'processed', v_processed,
    'modified', v_modified,
    'skipped_already_has_fraw', v_skipped_already_has
  );
END $$;

GRANT EXECUTE ON FUNCTION public.d376_recover_fraw_chunk(int, int) TO service_role, authenticated;

COMMENT ON FUNCTION public.d376_recover_fraw_chunk IS
'D-376 SHIP 1 — recovers f_raw for the 4 FROZEN_AT_ZERO MLB factors by re-deriving from inputs stored in pick_history.ai_analysis.factor_breakdown. Writes 4 new keys (fraw_weather_wind, fraw_wind_direction_hr, fraw_pitcher_hr_per_9, fraw_offense_differential). Non-destructive — existing score_* keys untouched. Idempotent — skips picks that already have the keys. Chunked via (offset, limit). Rollback: strip the 4 keys via UPDATE.';
