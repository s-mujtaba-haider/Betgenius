-- D-824 — ADD COLUMN w_mlb_batter_contact_rate to wide-format algorithm_weights.
-- Same pattern as D-816 w_mlb_batter_pull_rate. CEO-approved seed=1.5 per
-- §19.3 AskUserQuestion gate (D-824 SHIP turn, 2026-06-29). Rollback record:
-- docs/loop/rollbacks/d824_weight_insert.md.

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_contact_rate NUMERIC DEFAULT 1.5;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_contact_rate IS
  'D-824 — batter contact-rate / whiff-rate factor weight (hits market only). Seed 1.5 matches D-816 pull_rate parity (same Savant-leaderboard factor class, same -5..+5 bucket scale). D-825 retune will refine.';
