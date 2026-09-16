-- Read-only verification: are backfill rows' odds populated?
-- If yes, Fix #3 can pass real historical odds through scoreSlateForDate.
-- If NULL on most, fallback to -110 for those rows specifically.

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== backfill odds distribution ===';
  FOR r IN
    SELECT
      source, is_synthetic,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE odds IS NULL) AS null_odds,
      COUNT(*) FILTER (WHERE odds = -110) AS exactly_neg110,
      COUNT(*) FILTER (WHERE odds IS NOT NULL AND odds <> -110) AS real_odds,
      MIN(odds), MAX(odds),
      ROUND(AVG(odds)::NUMERIC, 1) AS avg_odds
    FROM pick_history
    WHERE prop_type NOT IN ('spread','game_total')
      AND source IN ('process-games','backfill','backfill-may7-9-organic')
    GROUP BY source, is_synthetic
    ORDER BY total DESC
  LOOP
    RAISE NOTICE 'source=% is_syn=% total=% null_odds=% =-110: % real_odds(!=-110): % min=% max=% avg=%',
      r.source, r.is_synthetic, r.total, r.null_odds, r.exactly_neg110, r.real_odds, r.min, r.max, r.avg_odds;
  END LOOP;
END $$;
