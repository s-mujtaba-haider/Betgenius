-- D-469 (2026-06-06) — Win-rate by confidence tier view.
--
-- WHY: CEO needs documented WR by confidence tier (the sell-the-app metric)
-- and the admin Performance page was showing "No Performance Data Yet"
-- despite 87,547 resolved pick_history rows existing. D-466 + D-467 made
-- the calibration question urgent; this view is the read-layer answer.
--
-- DEFINITION OF A WIN: pick_history.hit = true on resolved rows, excluding
-- synthetic (D-359 minted), quarantined (D-214), and voided picks. Pushes
-- are not in this dataset — resolve-picks records them as voided.
--
-- TIER BOUNDARIES (mirror Admin.tsx + scoring_mlb_v2.ts:200-204 getScoreLabel):
--   ELITE  90-100
--   STRONG 80-89
--   GOOD   70-79
--   LEAN   60-69
--   PASS   < 60
--
-- USAGE:
--   SELECT * FROM wr_by_tier WHERE sport='mlb' AND window='30d';
--   SELECT * FROM wr_by_tier WHERE window='lifetime';
--
-- This is a VIEW (not a materialized view) — pick_history changes are
-- immediately reflected; small enough at current scale (~25K real picks)
-- that view computation is sub-second. Switch to MATERIALIZED if cost
-- becomes noticeable.

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
  WHERE hit IS NOT NULL                        -- resolved only
    AND COALESCE(is_synthetic, false) = false  -- exclude D-359 minted
    AND COALESCE(is_d214_quarantined, false) = false
    AND COALESCE(voided, false) = false
)
SELECT
  sport,
  tier,
  'lifetime'::text AS window,
  COUNT(*) AS n,
  SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct
FROM base
GROUP BY sport, tier

UNION ALL

SELECT
  sport,
  tier,
  '30d'::text AS window,
  COUNT(*) AS n,
  SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct
FROM base
WHERE COALESCE(resolved_at, game_date::timestamptz) >= NOW() - INTERVAL '30 days'
GROUP BY sport, tier

UNION ALL

SELECT
  sport,
  tier,
  '7d'::text AS window,
  COUNT(*) AS n,
  SUM(CASE WHEN hit THEN 1 ELSE 0 END) AS wins,
  ROUND(100.0 * SUM(CASE WHEN hit THEN 1 ELSE 0 END) / COUNT(*), 1) AS wr_pct
FROM base
WHERE COALESCE(resolved_at, game_date::timestamptz) >= NOW() - INTERVAL '7 days'
GROUP BY sport, tier;

COMMENT ON VIEW public.wr_by_tier IS
  'D-469 (2026-06-06). Win-rate by confidence tier (ELITE/STRONG/GOOD/LEAN/PASS) '
  'across sport + window (lifetime/30d/7d). Excludes synthetic, D-214-quarantined, '
  'and voided picks. WR=100*SUM(hit)/COUNT. Used by Admin.tsx Performance section '
  'and as the canonical sell-the-app metric.';

-- Grant read to anon + authenticated (admin page reads via anon key + email gate)
GRANT SELECT ON public.wr_by_tier TO anon, authenticated;
