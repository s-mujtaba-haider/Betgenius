CREATE OR REPLACE FUNCTION public.d376_fraw_coverage_v3()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
SET statement_timeout = '180s'
AS $$
DECLARE
  v_hr_total INT;
  v_game_total INT;
  v_ww_nz INT;
  v_wdhr_nz INT;
  v_hr9_nz INT;
  v_offdiff_nz INT;
BEGIN
  -- HR-market scoped
  SELECT COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_weather_wind')::numeric, 0) <> 0),
    COUNT(*) FILTER (WHERE COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_wind_direction_hr')::numeric, 0) <> 0),
    COUNT(*) FILTER (WHERE COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_pitcher_hr_per_9')::numeric, 0) <> 0)
  INTO v_hr_total, v_ww_nz, v_wdhr_nz, v_hr9_nz
  FROM public.pick_history
  WHERE backfill_run_id IN (
      '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f','949a88e7-1c20-43e9-a674-ef90e9035f8b',
      'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef','61ff4c15-4678-4691-865c-264712fed0ca',
      '75bb70d1-6578-4c1f-a637-6f20ea158ce3')
    AND hit IS NOT NULL AND ai_analysis IS NOT NULL
    AND prop_type = 'batter_home_runs';
  -- Game scoped
  SELECT COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE((ai_analysis::jsonb -> 'factor_breakdown' ->> 'fraw_offense_differential')::numeric, 0) <> 0)
  INTO v_game_total, v_offdiff_nz
  FROM public.pick_history
  WHERE backfill_run_id IN (
      '01c0fbab-a7ed-412d-a43f-45b20e0b8a7f','949a88e7-1c20-43e9-a674-ef90e9035f8b',
      'cf9d0ccc-678d-4fc7-8ceb-f4b861d2bdef','61ff4c15-4678-4691-865c-264712fed0ca',
      '75bb70d1-6578-4c1f-a637-6f20ea158ce3')
    AND hit IS NOT NULL AND ai_analysis IS NOT NULL
    AND prop_type IN ('game_side','game_total');
  RETURN jsonb_build_object(
    'hr_total', v_hr_total,
    'game_total', v_game_total,
    'fraw_weather_wind_nonzero', v_ww_nz,
    'fraw_weather_wind_pct', round(100.0 * v_ww_nz / NULLIF(v_hr_total,0), 2),
    'fraw_wind_direction_hr_nonzero', v_wdhr_nz,
    'fraw_wind_direction_hr_pct', round(100.0 * v_wdhr_nz / NULLIF(v_hr_total,0), 2),
    'fraw_pitcher_hr_per_9_nonzero', v_hr9_nz,
    'fraw_pitcher_hr_per_9_pct', round(100.0 * v_hr9_nz / NULLIF(v_hr_total,0), 2),
    'fraw_offense_differential_nonzero', v_offdiff_nz,
    'fraw_offense_differential_pct', round(100.0 * v_offdiff_nz / NULLIF(v_game_total,0), 2)
  );
END $$;
GRANT EXECUTE ON FUNCTION public.d376_fraw_coverage_v3() TO service_role, authenticated;
