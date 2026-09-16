-- Read-only probe for Tier 1 #7 — identify the correct source filter for
-- "reference #4" (synthetic backtest on post-megadeploy organic-resolved corpus).
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== pick_history distinct sources where is_synthetic=true ===';
  FOR r IN
    SELECT source, COUNT(*) AS n,
      COUNT(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
      MIN(game_date) AS first_gd, MAX(game_date) AS last_gd
    FROM pick_history
    WHERE is_synthetic = true
    GROUP BY source ORDER BY n DESC
  LOOP
    RAISE NOTICE 'source=% n=% resolved=% first=% last=%',
      RPAD(r.source, 26), r.n, r.resolved, r.first_gd, r.last_gd;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Reference #4 candidate cuts — synthetic + post-May-4 + resolved ===';
  FOR r IN
    SELECT source,
      COUNT(*) FILTER (WHERE confidence >= 90) AS n_90,
      ROUND(100.0 * COUNT(*) FILTER (WHERE confidence >= 90 AND hit) / NULLIF(COUNT(*) FILTER (WHERE confidence >= 90), 0), 1) AS wr_90,
      COUNT(*) FILTER (WHERE confidence >= 80 AND confidence < 90) AS n_80,
      ROUND(100.0 * COUNT(*) FILTER (WHERE confidence >= 80 AND confidence < 90 AND hit) / NULLIF(COUNT(*) FILTER (WHERE confidence >= 80 AND confidence < 90), 0), 1) AS wr_80,
      COUNT(*) FILTER (WHERE confidence >= 70 AND confidence < 80) AS n_70,
      ROUND(100.0 * COUNT(*) FILTER (WHERE confidence >= 70 AND confidence < 80 AND hit) / NULLIF(COUNT(*) FILTER (WHERE confidence >= 70 AND confidence < 80), 0), 1) AS wr_70,
      COUNT(*) FILTER (WHERE confidence >= 60 AND confidence < 70) AS n_60,
      ROUND(100.0 * COUNT(*) FILTER (WHERE confidence >= 60 AND confidence < 70 AND hit) / NULLIF(COUNT(*) FILTER (WHERE confidence >= 60 AND confidence < 70), 0), 1) AS wr_60
    FROM pick_history
    WHERE is_synthetic = true AND hit IS NOT NULL AND voided = false
      AND game_date >= '2026-05-04'
    GROUP BY source ORDER BY COUNT(*) DESC
  LOOP
    RAISE NOTICE 'source=% 90+: n=% wr=% | 80-89: n=% wr=% | 70-79: n=% wr=% | 60-69: n=% wr=%',
      RPAD(r.source, 26),
      r.n_90, COALESCE(r.wr_90::TEXT, '—'),
      r.n_80, COALESCE(r.wr_80::TEXT, '—'),
      r.n_70, COALESCE(r.wr_70::TEXT, '—'),
      r.n_60, COALESCE(r.wr_60::TEXT, '—');
  END LOOP;
END $$;
