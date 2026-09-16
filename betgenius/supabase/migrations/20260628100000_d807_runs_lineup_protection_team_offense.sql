-- D-807 — Add 2 high-value runs-only factor columns + 2 weight columns.
-- Closes D-806 PART 1 audit findings: lineup_protection (NEW INGESTION
-- via lineup data + memoized batterSeason) and team_offense (data already
-- in TeamSeasonContext but not propagated to BatterScoringContext).
--
-- Both factors are runs-specific. They zero-default in scoreBatterMarket
-- (TB/HR/RBI/hits/strikeouts) — the interface contract preserves type safety
-- without contaminating other markets' confidence math.
--
-- Companion migration (20260628100100) extends upsert_pick_history RPC.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_batter_lineup_protection NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_team_offense NUMERIC;

COMMENT ON COLUMN public.pick_history.score_batter_lineup_protection IS
  'D-807 — runs-only factor. Avg OPS of next 2 hitters batting BEHIND this batter (slot +1, +2 same side, wrapping 9→1). Bucket vs ~0.720 league avg, ±5 magnitudes. Strong protection → favor OVER (more likely to be driven in).';

COMMENT ON COLUMN public.pick_history.score_batter_team_offense IS
  'D-807 — runs-only factor. Batter team season OPS (cache_team_batting_stats.ops_season). Bucket vs ~0.720 league avg, ±4 magnitudes. High team OPS → more rallies → more chances to score.';

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_lineup_protection NUMERIC DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_team_offense NUMERIC DEFAULT 1.0;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_lineup_protection IS
  'D-807 — lineup protection weight. Default 1.5 provisional. Highest-value runs-only signal per D-806 audit.';

COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_team_offense IS
  'D-807 — batter team offense weight. Default 1.0 provisional.';

COMMIT;
