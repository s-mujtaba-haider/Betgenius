-- M4 — EV / recommendation_shown columns on recommendations_cache for Dashboard parity.

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS recommendation_shown boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS win_prob numeric,
  ADD COLUMN IF NOT EXISTS edge_vs_implied numeric,
  ADD COLUMN IF NOT EXISTS ev_per_unit numeric;

-- Rollback:
-- ALTER TABLE public.recommendations_cache
--   DROP COLUMN IF EXISTS recommendation_shown,
--   DROP COLUMN IF EXISTS win_prob,
--   DROP COLUMN IF EXISTS edge_vs_implied,
--   DROP COLUMN IF EXISTS ev_per_unit;
