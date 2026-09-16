CREATE OR REPLACE FUNCTION public.d376_fraw_coverage()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
SET statement_timeout = '60s'
AS $$
WITH base AS (
  SELECT prop_type, ai_analysis::jsonb -> 'factor_breakdown' AS fb
  FROM public.pick_history
  WHERE backfill_run_id IN (
      '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f',
      '949a88e7-1c20-43e9-a674-ef90e9035f8b',
      'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef',
      '61ff4c15-4678-4691-865c-264712fed0ca',
      '75bb70d1-6578-4c1f-a637-6f20ea158ce3'
    )
    AND hit IS NOT NULL
    AND ai_analysis IS NOT NULL
    AND prop_type IN ('batter_home_runs','game_side','game_total')
)
SELECT jsonb_build_object(
  'total_affected', COUNT(*),
  'hr_total', COUNT(*) FILTER (WHERE prop_type = 'batter_home_runs'),
  'game_total', COUNT(*) FILTER (WHERE prop_type IN ('game_side','game_total')),
  'fraw_weather_wind_nonzero', COUNT(*) FILTER (WHERE COALESCE((fb ->> 'fraw_weather_wind')::numeric, 0) <> 0),
  'fraw_wind_direction_hr_nonzero', COUNT(*) FILTER (WHERE COALESCE((fb ->> 'fraw_wind_direction_hr')::numeric, 0) <> 0),
  'fraw_pitcher_hr_per_9_nonzero', COUNT(*) FILTER (WHERE COALESCE((fb ->> 'fraw_pitcher_hr_per_9')::numeric, 0) <> 0),
  'fraw_offense_differential_nonzero', COUNT(*) FILTER (WHERE COALESCE((fb ->> 'fraw_offense_differential')::numeric, 0) <> 0),
  'has_fraw_key_total', COUNT(*) FILTER (WHERE fb ? 'fraw_weather_wind')
)
FROM base
$$;
