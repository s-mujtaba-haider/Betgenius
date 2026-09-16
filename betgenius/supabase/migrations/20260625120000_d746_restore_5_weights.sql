-- D-746 STEP 1 — Restore the 5 D-744 RESTORE_CANDIDATE weights to CEO-specified
-- logic-based values for pitcher_strikeouts.
--
-- §19.3 CEO-APPROVED. These factors were collapsed to 0 by the D-742 OOS optimizer
-- on tiny train sample (n=663, with even smaller per-factor signal). Not proven
-- worthless — just under-sampled. CEO sets logic-based weights from strikeout-prop
-- research (umpire + handedness are real K drivers; xera/baa/framing secondary).
--
-- TOUCH ONLY THESE 5. Do not change any other weight.
--
-- Rollback: re-apply algorithm_weights_d744_snapshot or algorithm_weights_d746_snapshot.

-- Save pre-D-746 snapshot for audit + rollback safety
CREATE TABLE IF NOT EXISTS algorithm_weights_d746_snapshot AS
  SELECT *, now() AS snapshot_at FROM algorithm_weights;

-- Apply ONLY the 5 CEO-specified weight changes
UPDATE algorithm_weights SET
  w_mlb_handedness_matchup     = 0.5,    -- was 0 (D-744 collapsed); CEO: K driver
  w_mlb_pitcher_umpire_k_zone  = 0.5,    -- was 0; CEO: K driver
  w_mlb_pitcher_xera_edge      = 0.25,   -- was 0; CEO: Statcast K signal (secondary)
  w_mlb_pitcher_baa            = 0.25,   -- was 0; CEO: Statcast K signal (secondary)
  w_mlb_catcher_framing        = 0.25,   -- was 0; CEO: catcher framing rv (secondary)
  updated_at = now()
WHERE id = 1;

-- Audit log entry
INSERT INTO d744_weight_change_log (reason, weight_name, old_value, new_value, status_flag) VALUES
  ('D-746 — CEO logic-based restore (K driver)',      'w_mlb_handedness_matchup',     0.0, 0.5,  'RESTORED_CEO_LOGIC'),
  ('D-746 — CEO logic-based restore (K driver)',      'w_mlb_pitcher_umpire_k_zone',  0.0, 0.5,  'RESTORED_CEO_LOGIC'),
  ('D-746 — CEO logic-based restore (Statcast 2°)',   'w_mlb_pitcher_xera_edge',      0.0, 0.25, 'RESTORED_CEO_LOGIC'),
  ('D-746 — CEO logic-based restore (Statcast 2°)',   'w_mlb_pitcher_baa',            0.0, 0.25, 'RESTORED_CEO_LOGIC'),
  ('D-746 — CEO logic-based restore (framing 2°)',    'w_mlb_catcher_framing',        0.0, 0.25, 'RESTORED_CEO_LOGIC');
