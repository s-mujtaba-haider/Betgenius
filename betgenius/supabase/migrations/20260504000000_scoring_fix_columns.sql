-- ============================================================================
-- Migration : 20260504000000_scoring_fix_columns.sql
-- Date      : 2026-05-04
-- Purpose   : Add observability columns for trivialLinePenalty + new
--             minutes-floor decomposition factors as part of the May 4
--             comprehensive scoring fix deploy.
--
-- Context   :
--   - trivialLinePenalty has been computed in scoring since launch but NEVER
--     stored on pick_history. Backtest function (002_backtest_weights_v2.sql)
--     can't reproduce production score for trivial picks → contributes to
--     C16 backtest-vs-production divergence (66.2% vs 49.6%).
--   - score_minutes_floor was a hybrid signal (volume floor + variance) with
--     symmetric +3/-4 bonus regardless of pick side. Decomposed into:
--       * score_minutes_volume   — high-floor signal, side-flipped
--       * score_minutes_stability — low-spread signal, NOT side-flipped
--     Existing score_minutes_floor column LEFT IN PLACE (deprecated, will be
--     dropped in a follow-up migration once historical data ages out).
--
-- Rollback  :
--     ALTER TABLE public.pick_history DROP COLUMN IF EXISTS score_trivial_line_penalty;
--     ALTER TABLE public.pick_history DROP COLUMN IF EXISTS score_trivial_line_cap;
--     ALTER TABLE public.pick_history DROP COLUMN IF EXISTS score_minutes_volume;
--     ALTER TABLE public.pick_history DROP COLUMN IF EXISTS score_minutes_stability;
--     ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS score_trivial_line_penalty;
--     ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS score_trivial_line_cap;
--     ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS score_minutes_volume;
--     ALTER TABLE public.recommendations_cache DROP COLUMN IF EXISTS score_minutes_stability;
-- ============================================================================

-- pick_history additions
ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_trivial_line_penalty NUMERIC DEFAULT 0;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_trivial_line_cap BOOLEAN DEFAULT false;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_minutes_volume NUMERIC DEFAULT 0;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_minutes_stability NUMERIC DEFAULT 0;

-- recommendations_cache additions (so dashboard can read these directly,
-- mirrors the existing parallel structure between the two tables)
ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS score_trivial_line_penalty NUMERIC DEFAULT 0;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS score_trivial_line_cap BOOLEAN DEFAULT false;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS score_minutes_volume NUMERIC DEFAULT 0;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS score_minutes_stability NUMERIC DEFAULT 0;

COMMENT ON COLUMN public.pick_history.score_trivial_line_penalty IS
  'Confidence penalty for trivial-line picks (line<=0.5). -8 default, -15 if odds>=200. May 4 megadeploy.';
COMMENT ON COLUMN public.pick_history.score_trivial_line_cap IS
  'TRUE if double-trivial (line<=0.5 AND odds>=200) cap at finalScore=65 was applied. May 4 megadeploy.';
COMMENT ON COLUMN public.pick_history.score_minutes_volume IS
  'High-minute-floor signal (replaces volume half of legacy score_minutes_floor). Side-flipped. May 4 megadeploy.';
COMMENT ON COLUMN public.pick_history.score_minutes_stability IS
  'Low-spread predictability signal (replaces variance half of legacy score_minutes_floor). NOT side-flipped. May 4 megadeploy.';
