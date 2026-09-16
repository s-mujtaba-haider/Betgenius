-- D-520-APPLY SHIP 1 — Snapshot algorithm_weights row 1 to a backup table
-- BEFORE any sign-flip / new-column changes. This is the rollback artifact.
--
-- Idempotent: drop+recreate so re-running is safe.
-- Pre-apply git SHA: 4b1eb991f65d19c5ae65c76d97eb06e54b765f87
DO $$
DECLARE r RECORD;
BEGIN
  -- 1) Persistent backup table (rollback artifact stays in the DB)
  DROP TABLE IF EXISTS public.algorithm_weights_d520apply_snapshot;
  CREATE TABLE public.algorithm_weights_d520apply_snapshot AS
    SELECT *, now() AS snapshot_taken_at, '4b1eb991'::text AS snapshot_git_sha
    FROM public.algorithm_weights
    WHERE id = 1;

  RAISE NOTICE '[D-520-APPLY snapshot] rows captured = %',
    (SELECT count(*) FROM public.algorithm_weights_d520apply_snapshot);

  -- 2) Print the row as JSON so the chained_final can quote it verbatim
  FOR r IN
    SELECT to_jsonb(t.*) AS j
    FROM public.algorithm_weights t WHERE id = 1
  LOOP
    RAISE NOTICE '[D-520-APPLY snapshot] row_json=%', r.j::text;
  END LOOP;

  -- 3) Pre-print the 9 current values that SHIP 1 will negate.
  --    STOP-IF check: if any of these differ from the D-520 validation
  --    table (handedness=0.75, weather_wind=0.5, lineup_consistency=0.5,
  --    weather_temp=1.25, wind_direction_hr=0.25, pitcher_quality=1.5,
  --    form_power=0.5, recent_ab=1.0, babip=0.125) the operator should
  --    abort the apply migration and surface — D-520 validated against
  --    those exact magnitudes.
  RAISE NOTICE '[D-520-APPLY pre-check] current weights about to be negated:';
  FOR r IN
    SELECT
      w_mlb_batter_handedness_matchup     AS handedness,
      w_mlb_batter_weather_wind           AS weather_wind,
      w_mlb_batter_lineup_consistency     AS lineup_consistency,
      w_mlb_batter_weather_temp           AS weather_temp,
      w_mlb_wind_direction_hr             AS wind_direction_hr,
      w_mlb_batter_pitcher_quality        AS pitcher_quality,
      w_mlb_batter_form_power             AS form_power,
      w_mlb_batter_recent_ab              AS recent_ab,
      w_mlb_batter_babip                  AS babip
    FROM public.algorithm_weights WHERE id = 1
  LOOP
    RAISE NOTICE '  handedness=% weather_wind=% lineup_consistency=% weather_temp=% wind_direction_hr=% pitcher_quality=% form_power=% recent_ab=% babip=%',
      r.handedness, r.weather_wind, r.lineup_consistency, r.weather_temp,
      r.wind_direction_hr, r.pitcher_quality, r.form_power, r.recent_ab, r.babip;
  END LOOP;
END $$;
