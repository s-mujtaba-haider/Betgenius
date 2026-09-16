-- D-803 — Add pitcher hard-contact-allowed matchup factor column +
-- weight column. Closes the D-800 LOADED-THEN-DROPPED finding on pitcher
-- side: cache_statcast_pitchers_exit_velo had ev95percent / brl_pa / etc.
-- already, but OpposingPitcherContext interface dropped them. D-803 wires
-- them through + adds the matchup-side factor counterpart to D-797's
-- score_batter_hard_hit.
--
-- Companion migration (20260628020100) extends upsert_pick_history RPC.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_pitcher_hard_contact_allowed NUMERIC;

COMMENT ON COLUMN public.pick_history.score_pitcher_hard_contact_allowed IS
  'D-803 — opposing pitcher hard-contact-allowed (ev95percent) factor. Matchup-side counterpart to D-797 score_batter_hard_hit. Bucket bands at pitcher ev95% allowed vs league avg ~38%. Gated TB/HR/RBI markets, ≥20 IP sample floor.';

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_hard_contact_allowed NUMERIC DEFAULT 1.0;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_pitcher_hard_contact_allowed IS
  'D-803 — pitcher hard-contact-allowed factor weight. Default 1.0 provisional pending OOS tune.';

COMMIT;
