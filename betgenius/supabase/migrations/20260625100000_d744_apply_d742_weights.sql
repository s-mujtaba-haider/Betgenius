-- D-744 STEP 1 — Apply D-742 OOS-tuned weights to algorithm_weights for pitcher_strikeouts.
--
-- §19.3 CEO-approved. Optimizer cron remains paused (D-737e SQL).
--
-- WHAT: 11 clean factors set to the D-742 logistic-regression OOS coefficients.
-- k_rate + form HELD at current (shadow — temporal-drift per D-740, not tunable yet).
-- 5 small-n collapsed factors (handedness, umpire, xera, baa, catcher_framing) set
-- to the D-742 value of 0 — flagged below as restore-candidates for future CEO/Claude review.
--
-- WHY: D-742 produced the first parity-clean OOS tune of pitcher_strikeouts on n=663
-- train / n=285 validate. Per-tier OOS win-rate at uncalibrated ≥65 was 63.6% on n=44
-- (+EV +21.48% ROI at -110). Tuning replaces months of biased-data optimizer drift.
--
-- WHEN: 2026-06-25 deploy.
--
-- ROLLBACK: re-apply prior values (saved in pre-D-744 audit table for safety):

-- Save pre-D-744 snapshot for audit / rollback
CREATE TABLE IF NOT EXISTS algorithm_weights_d744_snapshot AS
  SELECT *, now() AS snapshot_at FROM algorithm_weights;

-- Apply D-742 OOS-tuned values
UPDATE algorithm_weights SET
  -- TUNED — D-742 OOS coefficients (5 factors with non-zero fit)
  w_mlb_pitcher_velocity_trend       = 0.17,   -- was 1.0  (D-742 OOS coef +0.1724)
  w_mlb_pitcher_weather_wind         = -0.19,  -- was 0.25 (D-742 OOS coef -0.1938 — sign matters)
  w_mlb_pitcher_weather_temp         = 0.09,   -- was 0.25 (D-742 OOS coef +0.0904)
  w_mlb_rest_pitcher                 = -0.04,  -- was 0.5  (D-742 OOS coef -0.0418)
  w_mlb_pitch_count_trend            = 0.03,   -- was 0.5  (D-742 OOS coef +0.0271, post-D-739 sign flip)
  w_mlb_pitcher_ballpark_factor      = -0.01,  -- was 1.5  (D-742 OOS coef -0.0056)
  -- SMALL-N COLLAPSED — D-742 coef = 0. Flagged as restore-candidates (see CEO doc)
  w_mlb_handedness_matchup           = 0.0,    -- was 0.5  (collapsed; n=663 train too small)
  w_mlb_pitcher_umpire_k_zone        = 0.0,    -- was 0.75 (collapsed)
  w_mlb_pitcher_xera_edge            = 0.0,    -- was 1.0  (collapsed)
  w_mlb_pitcher_baa                  = 0.0,    -- was 1.0  (collapsed)
  w_mlb_catcher_framing              = 0.0,    -- was 1.0  (collapsed)
  -- SHADOW (HELD) — k_rate + form unchanged (temporal drift per D-740)
  -- w_mlb_pitcher_k_rate              = 0.25 (UNCHANGED — shadow)
  -- w_mlb_pitcher_form                = 1.0  (UNCHANGED — shadow)
  updated_at = now()
WHERE id = 1;

-- Per-change audit log: separate D-744 table (weight_change_log was an NBA-era
-- snapshot table with a different schema, not a per-change audit log).
CREATE TABLE IF NOT EXISTS d744_weight_change_log (
  id           bigserial PRIMARY KEY,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  reason       text NOT NULL,
  weight_name  text NOT NULL,
  old_value    numeric NOT NULL,
  new_value    numeric NOT NULL,
  status_flag  text                 -- 'TUNED' | 'SMALL_N_COLLAPSED_RESTORE_CANDIDATE'
);

INSERT INTO d744_weight_change_log (reason, weight_name, old_value, new_value, status_flag) VALUES
  ('D-744 — D-742 OOS-tuned (parity-clean factor)', 'w_mlb_pitcher_velocity_trend',  1.0,  0.17,  'TUNED'),
  ('D-744 — D-742 OOS-tuned (parity-clean factor)', 'w_mlb_pitcher_weather_wind',    0.25, -0.19, 'TUNED'),
  ('D-744 — D-742 OOS-tuned (parity-clean factor)', 'w_mlb_pitcher_weather_temp',    0.25, 0.09,  'TUNED'),
  ('D-744 — D-742 OOS-tuned (parity-clean factor)', 'w_mlb_rest_pitcher',            0.5,  -0.04, 'TUNED'),
  ('D-744 — D-742 OOS-tuned (parity-clean factor)', 'w_mlb_pitch_count_trend',       0.5,  0.03,  'TUNED'),
  ('D-744 — D-742 OOS-tuned (parity-clean factor)', 'w_mlb_pitcher_ballpark_factor', 1.5,  -0.01, 'TUNED'),
  ('D-744 — small-n collapsed (RESTORE CANDIDATE)', 'w_mlb_handedness_matchup',      0.5,  0.0,   'SMALL_N_COLLAPSED_RESTORE_CANDIDATE'),
  ('D-744 — small-n collapsed (RESTORE CANDIDATE)', 'w_mlb_pitcher_umpire_k_zone',   0.75, 0.0,   'SMALL_N_COLLAPSED_RESTORE_CANDIDATE'),
  ('D-744 — small-n collapsed (RESTORE CANDIDATE)', 'w_mlb_pitcher_xera_edge',       1.0,  0.0,   'SMALL_N_COLLAPSED_RESTORE_CANDIDATE'),
  ('D-744 — small-n collapsed (RESTORE CANDIDATE)', 'w_mlb_pitcher_baa',             1.0,  0.0,   'SMALL_N_COLLAPSED_RESTORE_CANDIDATE'),
  ('D-744 — small-n collapsed (RESTORE CANDIDATE)', 'w_mlb_catcher_framing',         1.0,  0.0,   'SMALL_N_COLLAPSED_RESTORE_CANDIDATE');
