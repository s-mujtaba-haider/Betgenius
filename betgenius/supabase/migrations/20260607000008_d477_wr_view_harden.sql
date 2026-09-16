-- D-477 (2026-06-07) — Harden the WR read-layer: permanently exclude
-- synthetic + NULL-game_date contamination from the documented-WR metric.
--
-- WHY: D-471 found D-470's GOOD-tier -6.1% ROI was half synthetic-backfill
-- contamination because D-470's ad-hoc Python analysis bypassed wr_by_tier
-- and queried pick_history directly without the is_synthetic filter. The
-- existing view already excludes is_synthetic, but:
--   (a) it does NOT filter NULL game_date → 4 NBA Evaluator-source rows
--       slip in (is_synthetic=false but game_date NULL). Tiny but real.
--   (b) any direct pick_history query — e.g. an ad-hoc Python script,
--       a future analyst, a copy-paste from D-469-era SQL — can still
--       accidentally re-introduce the contamination.
--
-- WHAT THIS MIGRATION DOES:
--   1. Adds `AND game_date IS NOT NULL` to the wr_by_tier base CTE
--      (Admin.tsx:315 already enforces this; bring the view to parity).
--   2. Creates a NEW VIEW `pick_history_real` exposing the canonical
--      filtered cohort. Any ad-hoc query that wants "real production
--      picks" should hit pick_history_real instead of pick_history.
--      Future contamination becomes impossible by construction.
--   3. Adds a comment to pick_history table itself warning that DIRECT
--      reads include synthetic + quarantined + voided + NULL-date rows
--      and SHOULD NOT be used as the documented-WR source.
--
-- NEGATIVE SCOPE: zero change to scoring/weights/picks. Zero deletion
-- of synthetic rows (training/backtest needs them). PURE read-layer
-- hardening.
--
-- CANONICAL FILTER (the single source of truth for "real production picks"):
--   hit IS NOT NULL
--   AND COALESCE(is_synthetic, false) = false
--   AND COALESCE(is_d214_quarantined, false) = false
--   AND COALESCE(voided, false) = false
--   AND game_date IS NOT NULL
--
-- These five conditions together define a real, resolved, ungated,
-- non-voided, dated production pick. Any documented-WR query should
-- mirror this set exactly.

-- ============================================================
-- 1. Re-create wr_by_tier with game_date IS NOT NULL added.
-- ============================================================

CREATE OR REPLACE VIEW public.wr_by_tier AS
WITH base AS (
  SELECT
    sport,
    confidence,
    hit,
    resolved_at,
    game_date,
    CASE
      WHEN confidence >= 90 THEN 'ELITE'
      WHEN confidence >= 80 THEN 'STRONG'
      WHEN confidence >= 70 THEN 'GOOD'
      WHEN confidence >= 60 THEN 'LEAN'
      ELSE 'PASS'
    END AS tier
  FROM public.pick_history
  WHERE hit IS NOT NULL                            -- resolved only
    AND COALESCE(is_synthetic, false) = false      -- exclude D-359 minted
    AND COALESCE(is_d214_quarantined, false) = false
    AND COALESCE(voided, false) = false
    AND game_date IS NOT NULL                      -- D-477 — exclude Evaluator NULL-date rows
)
SELECT
  sport, tier, 'lifetime'::text AS window,
  COUNT(*) AS n,
  SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct
FROM base
GROUP BY sport, tier

UNION ALL

SELECT
  sport, tier, '30d'::text AS window,
  COUNT(*) AS n,
  SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct
FROM base
WHERE COALESCE(resolved_at, game_date::timestamptz) >= NOW() - INTERVAL '30 days'
GROUP BY sport, tier

UNION ALL

SELECT
  sport, tier, '7d'::text AS window,
  COUNT(*) AS n,
  SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct
FROM base
WHERE COALESCE(resolved_at, game_date::timestamptz) >= NOW() - INTERVAL '7 days'
GROUP BY sport, tier;

COMMENT ON VIEW public.wr_by_tier IS
  'D-469 + D-477 hardened (2026-06-07). Win-rate by confidence tier '
  '(ELITE/STRONG/GOOD/LEAN/PASS) across sport + window (lifetime/30d/7d). '
  'CANONICAL filter: hit IS NOT NULL, COALESCE(is_synthetic,false)=false, '
  'COALESCE(is_d214_quarantined,false)=false, COALESCE(voided,false)=false, '
  'game_date IS NOT NULL. This is the single source of truth for documented '
  'WR. Used by Admin.tsx Performance section and external readers. Direct '
  'pick_history queries WILL include synthetic + voided + NULL-date rows '
  'and MUST NOT be used as a WR source — use pick_history_real instead.';

GRANT SELECT ON public.wr_by_tier TO anon, authenticated;

-- ============================================================
-- 2. NEW VIEW: pick_history_real — canonical filtered table for
--    any ad-hoc query that wants "real production picks".
--    Re-exposes all pick_history columns through the canonical filter.
-- ============================================================

CREATE OR REPLACE VIEW public.pick_history_real AS
SELECT * FROM public.pick_history
WHERE hit IS NOT NULL
  AND COALESCE(is_synthetic, false) = false
  AND COALESCE(is_d214_quarantined, false) = false
  AND COALESCE(voided, false) = false
  AND game_date IS NOT NULL;

COMMENT ON VIEW public.pick_history_real IS
  'D-477 (2026-06-07). Canonical real-production-picks view. Filters to the '
  'same cohort wr_by_tier aggregates. Any ad-hoc analysis querying for '
  '"documented WR / edge / ROI" must use this view, NOT pick_history directly. '
  'pick_history retains synthetic + quarantined + voided + NULL-date rows '
  'for training/backtest/replay use. Direct pick_history reads for WR-class '
  'metrics WILL contaminate the number (as D-471 found with D-470).';

GRANT SELECT ON public.pick_history_real TO anon, authenticated;

-- ============================================================
-- 3. Warning comment on pick_history itself — surfaces in pgAdmin /
--    PostgREST introspection so any future querier sees the gotcha.
-- ============================================================

COMMENT ON TABLE public.pick_history IS
  'Mixed cohort: real production picks + D-359 synthetic-minted backfill + '
  'D-214-quarantined + voided + Evaluator-source NULL-date rows. '
  'WARNING: do NOT use as a WR / edge / ROI source directly. '
  'Use the pick_history_real view for documented-edge metrics (D-477). '
  'Use wr_by_tier for pre-aggregated WR per tier (D-469).';
