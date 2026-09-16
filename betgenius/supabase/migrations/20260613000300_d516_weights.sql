DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-516 weights] live algorithm_weights for batter hit-rate vs power-rate factors:';
  FOR r IN
    SELECT
      w_mlb_batter_hit_rate,
      w_mlb_batter_power_rate,
      w_mlb_batter_form,
      w_mlb_batter_form_power,
      w_mlb_pitcher_hr_per_9,
      w_mlb_batter_barrel_rate,
      w_mlb_batter_exit_velo_trend,
      w_mlb_batter_xba,
      w_mlb_batter_pitcher_hr_rate,
      w_mlb_batter_babip,
      w_mlb_batter_pitcher_quality,
      updated_at
    FROM public.algorithm_weights ORDER BY id LIMIT 1
  LOOP RAISE NOTICE 'w_hit_rate=% w_power_rate=% w_form=% w_form_power=% w_pitcher_hr9=% w_barrel=% w_evt=% w_xba=% w_pitcher_hr_rate=% w_babip=% w_pq=% upd=%',
    r.w_mlb_batter_hit_rate, r.w_mlb_batter_power_rate, r.w_mlb_batter_form,
    r.w_mlb_batter_form_power, r.w_mlb_pitcher_hr_per_9, r.w_mlb_batter_barrel_rate,
    r.w_mlb_batter_exit_velo_trend, r.w_mlb_batter_xba,
    r.w_mlb_batter_pitcher_hr_rate, r.w_mlb_batter_babip,
    r.w_mlb_batter_pitcher_quality, r.updated_at; END LOOP;
END $$;
