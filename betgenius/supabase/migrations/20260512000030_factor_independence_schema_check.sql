-- Tier 4 #10 Phase 1 — schema verification before correlation run.
-- Read-only DO block lists all score_* columns currently on pick_history
-- so the correlation SQL targets actual names (avoids
-- "score_trivial_line_penalty vs score_trivial_pen"-style misses).

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== pick_history score_* columns ===';
  FOR r IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pick_history'
      AND column_name LIKE 'score_%'
    ORDER BY column_name
  LOOP
    RAISE NOTICE 'col=% type=% null=%', RPAD(r.column_name, 32), r.data_type, r.is_nullable;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Resolved organic universe post-May-4 ===';
  FOR r IN
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
      COUNT(*) FILTER (WHERE hit IS NOT NULL AND voided = false) AS resolved_unvoided
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND game_date >= '2026-05-04'
  LOOP
    RAISE NOTICE 'total=% resolved=% resolved_unvoided=%', r.total, r.resolved, r.resolved_unvoided;
  END LOOP;
END $$;
