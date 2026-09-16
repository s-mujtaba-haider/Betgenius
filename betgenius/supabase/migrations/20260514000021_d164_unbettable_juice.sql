-- D-164 unbettable juice detection (May 14, 2026)
--
-- Some under-side picks land at high confidence but the juice makes them
-- unbettable. Example: under at 70 confidence with side_odds -300 needs
-- 75% WR to break even but the algorithm only requires 53% WR to confidence-
-- gate. Add a per-tier breakeven gate.
--
-- Thresholds (side_odds at which break-even WR exceeds tier-required WR):
--   60-69 tier: needs >=50% WR → unbettable if side_odds <= -200 (66.7% bk)
--   70-79 tier: needs >=53% WR → unbettable if side_odds <= -250 (71.4% bk)
--   80-89 tier: needs >=56% WR → unbettable if side_odds <= -300 (75.0% bk)
--   90+ tier:   needs >=60% WR → unbettable if side_odds <= -350 (77.8% bk)
--
-- Applied to UNDER-side picks (where heavy juice is most common). Flag does
-- NOT hide the pick — Dashboard surfaces a warning indicator.
--
-- Closes D-148 §15.10 #5.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS unbettable_juice_flag BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS unbettable_juice_flag BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing rows: leave FALSE (column default). No retroactive
-- computation; the flag is forward-looking (process-games writers populate
-- post-deploy).

COMMENT ON COLUMN public.pick_history.unbettable_juice_flag IS
  'D-164: TRUE when under-side pick odds are beyond tier breakeven threshold. Tiered: 60-69/-200, 70-79/-250, 80-89/-300, 90+/-350.';
COMMENT ON COLUMN public.recommendations_cache.unbettable_juice_flag IS
  'D-164: TRUE when under-side pick odds are beyond tier breakeven threshold. See pick_history column comment for thresholds.';

COMMIT;
