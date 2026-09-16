-- score_home_away_split dead-factor audit (D-128 follow-up, May 12, 2026).
-- READ-ONLY.
-- Two probes:
--   A) cache_player_game_logs is_home population rate (post-Phase-2 writers
--      mirror live fetchGameLog's homeAway field — NULL rate here ≈ rate at
--      which ESPN returns empty homeAway).
--   B) score_home_away_split fire rate cross-checked vs the dead-factor
--      finding from Phase 1 (NULL correlation).

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== Probe A: cache_player_game_logs.is_home population ===';
  FOR r IN
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_home IS NULL) AS null_home,
      COUNT(*) FILTER (WHERE is_home = true) AS true_home,
      COUNT(*) FILTER (WHERE is_home = false) AS away,
      ROUND(100.0 * COUNT(*) FILTER (WHERE is_home IS NULL) / NULLIF(COUNT(*), 0), 2) AS pct_null
    FROM cache_player_game_logs
  LOOP
    RAISE NOTICE 'total=% null_home=% true_home=% away=% pct_null=%',
      r.total, r.null_home, r.true_home, r.away, r.pct_null;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Probe A2: is_home NULL rate by source (espn vs other) ===';
  FOR r IN
    SELECT source,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_home IS NULL) AS null_home,
      ROUND(100.0 * COUNT(*) FILTER (WHERE is_home IS NULL) / NULLIF(COUNT(*), 0), 2) AS pct_null
    FROM cache_player_game_logs
    GROUP BY source
  LOOP
    RAISE NOTICE 'source=% total=% null_home=% pct_null=%',
      r.source, r.total, r.null_home, r.pct_null;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Probe A3: per-player is_home fill rate, top 10 by sample ===';
  FOR r IN
    SELECT player_name,
      COUNT(*) AS games,
      COUNT(*) FILTER (WHERE is_home IS NULL) AS null_home,
      COUNT(*) FILTER (WHERE is_home = true) AS home_count,
      COUNT(*) FILTER (WHERE is_home = false) AS away_count
    FROM cache_player_game_logs
    GROUP BY player_name
    ORDER BY games DESC
    LIMIT 10
  LOOP
    RAISE NOTICE 'player=% games=% null=% home=% away=%',
      RPAD(r.player_name, 24), r.games, r.null_home, r.home_count, r.away_count;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Probe B: score_home_away_split fire rate, post-May-4 ===';
  FOR r IN
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE score_home_away_split <> 0) AS nonzero,
      COUNT(*) FILTER (WHERE score_home_away_split IS NULL) AS null_score,
      COUNT(*) FILTER (WHERE score_home_away_split = 0) AS zero_score,
      ROUND(100.0 * COUNT(*) FILTER (WHERE score_home_away_split <> 0) / NULLIF(COUNT(*), 0), 2) AS pct_fired
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND game_date >= '2026-05-04'
  LOOP
    RAISE NOTICE 'total=% nonzero=% NULL=% zero=% pct_fired=%',
      r.total, r.nonzero, r.null_score, r.zero_score, r.pct_fired;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Probe B2: home_away_split fire rate by game_date ===';
  FOR r IN
    SELECT game_date,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE score_home_away_split <> 0) AS nonzero
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND game_date >= '2026-05-04'
    GROUP BY game_date
    ORDER BY game_date
  LOOP
    RAISE NOTICE 'date=% total=% nonzero=%',
      r.game_date, r.total, r.nonzero;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== Probe C: pre-D-058 baseline — fire rate ALL TIME ===';
  FOR r IN
    SELECT
      CASE WHEN game_date < '2026-05-02' THEN 'pre_D058_before_May2'
           WHEN game_date < '2026-05-04' THEN 'D058_window_May2_3'
           ELSE 'post_May4' END AS era,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE score_home_away_split <> 0) AS nonzero,
      ROUND(100.0 * COUNT(*) FILTER (WHERE score_home_away_split <> 0) / NULLIF(COUNT(*), 0), 2) AS pct_fired
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE 'era=% total=% nonzero=% pct_fired=%',
      RPAD(r.era, 24), r.total, r.nonzero, r.pct_fired;
  END LOOP;
END $$;
