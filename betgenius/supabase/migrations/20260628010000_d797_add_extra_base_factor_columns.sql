-- D-797 — schema additions for the 4 new extra-base factors + babip persistence.
--
-- D-796 found that xwOBA, launch angle, sweet-spot %, and hard-hit % were
-- loaded from Statcast caches but discarded at the context boundary, hiding
-- the strongest TB predictors from the scorer. D-797 wires them end-to-end.
-- Also fixes the score_batter_babip non-return on the TB path (D-794-class
-- gap: computed + contributing to confidence but not returned at top-level).
--
-- This migration:
--   1. Adds 5 columns to public.pick_history (the 4 new factor scores + babip)
--   2. Adds 4 weight columns to public.algorithm_weights (DB-tunable seeds)
--
-- Companion migration (20260628010100) extends the upsert_pick_history RPC.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_batter_babip NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_xwoba NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_launch_angle NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_sweet_spot NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_hard_hit NUMERIC;

COMMENT ON COLUMN public.pick_history.score_batter_babip IS
  'D-797 — BABIP regression factor at top-level (was computed + contributing to confidence but not returned pre-D-797).';
COMMENT ON COLUMN public.pick_history.score_batter_xwoba IS
  'D-797 — xwOBA factor. Research-validated single best TB predictor. Bucket bands at xwoba_diff from .320 league avg.';
COMMENT ON COLUMN public.pick_history.score_batter_launch_angle IS
  'D-797 — average launch angle factor. Distinguishes 2B/3B from grounders. TB market uses line-drive zone 10-22°; HR uses 22-32°.';
COMMENT ON COLUMN public.pick_history.score_batter_sweet_spot IS
  'D-797 — anglesweetspotpercent factor. % batted balls in 8-32° sweet-spot zone. League avg ~33%.';
COMMENT ON COLUMN public.pick_history.score_batter_hard_hit IS
  'D-797 — ev95percent factor. % batted balls ≥95mph EV. Most stable power predictor (stabilizes ~30 PA). League avg ~38%.';

-- Weight columns (DB-tunable seeds). Defaults match DEFAULT_W_BATTER literals:
-- xwoba seeded higher (1.5) per research; the others at 1.0 provisional.
ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_xwoba NUMERIC DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_launch_angle NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_sweet_spot NUMERIC DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_hard_hit NUMERIC DEFAULT 1.0;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_xwoba IS
  'D-797 — xwOBA factor weight. Default 1.5 (research-validated primary TB signal).';
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_launch_angle IS
  'D-797 — launch angle factor weight. Default 1.0 provisional pending OOS tune.';
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_sweet_spot IS
  'D-797 — sweet-spot % factor weight. Default 1.0 provisional pending OOS tune.';
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_hard_hit IS
  'D-797 — hard-hit % factor weight. Default 1.0 provisional pending OOS tune.';

COMMIT;
