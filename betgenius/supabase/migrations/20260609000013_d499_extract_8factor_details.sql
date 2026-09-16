-- D-499 extract the per-weight log entries for the 8 D-498-added factors so
-- we can report WHY each was/wasn't proposed.
DO $$
DECLARE
  v_content TEXT;
  v_log     JSONB;
  r RECORD;
BEGIN
  SELECT content INTO v_content
  FROM net._http_response WHERE id = 10063;

  v_log := v_content::jsonb -> 'per_weight_log';

  RAISE NOTICE '[D-499 — per-weight log for the 8 D-498-added weights]:';
  FOR r IN
    SELECT
      v ->> 'weight'                                AS weight,
      v ->> 'market'                                AS market,
      v ->> 'era'                                   AS era,
      v ->> 'classification'                        AS classification,
      (v ->> 'current')::numeric                    AS current_v,
      (v ->> 'train_best_value')::numeric           AS train_best,
      (v ->> 'train_hr_pre')::numeric               AS train_pre,
      (v ->> 'train_hr_post')::numeric              AS train_post,
      (v ->> 'validate_hr_at_best')::numeric        AS validate_at_best,
      v -> 'validate_market_regressions'            AS validate_regress,
      v ->> 'note'                                  AS note
    FROM jsonb_array_elements(v_log) AS v
    WHERE v ->> 'weight' IN (
      'w_mlb_lineup_spot',
      'w_mlb_day_after_night_fatigue',
      'w_mlb_travel_getaway',
      'w_mlb_pitcher_command_trend',
      'w_mlb_pitcher_velocity_trend',
      'w_mlb_pitcher_baa_vs_hand',
      'w_mlb_lineup_k_composition',
      'w_mlb_hitter_streak_fatigue'
    )
  LOOP
    RAISE NOTICE '%(%): class=% current=% train_best=% (train HR %→%) validate@best=% market_regress=% note=%',
      r.weight, r.era, r.classification,
      r.current_v, r.train_best,
      round(r.train_pre * 100, 3), round(r.train_post * 100, 3),
      round(r.validate_at_best * 100, 3),
      r.validate_regress, r.note;
  END LOOP;

  -- Also count total entries in per_weight_log to confirm = 54
  RAISE NOTICE '[D-499] per_weight_log total entries = %', jsonb_array_length(v_log);
END $$;
