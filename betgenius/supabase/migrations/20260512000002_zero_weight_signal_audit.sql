-- Tier 1 #5 — Zero-weight reactivation signal audit (May 12, 2026).
-- READ-ONLY. TASKs 1.2 + 1.3 + 2 from the spec:
--   1.2 current weights snapshot
--   1.3 distribution of each factor on organic post-May-4 data
--   2.  hit-rate per bucket (monotonic signal check)

DO $$
DECLARE
  cw RECORD;
  r RECORD;
BEGIN
  -- TASK 1.2: weights snapshot
  SELECT * INTO cw FROM algorithm_weights WHERE id = 1 LIMIT 1;
  RAISE NOTICE '=== CURRENT WEIGHTS (id=1, updated_at=%) ===', cw.updated_at;
  RAISE NOTICE 'Zero-weight 4 candidates:';
  RAISE NOTICE '  w_pace         = %', cw.w_pace;
  RAISE NOTICE '  w_opp_defense  = %', cw.w_opp_defense;
  RAISE NOTICE '  w_ha_split     = %', cw.w_ha_split;
  RAISE NOTICE '  w_minutes_trend = %', cw.w_minutes_trend;
  RAISE NOTICE 'Selected non-zero for context:';
  RAISE NOTICE '  w_l5=% w_l10=% w_season=% w_recent_form=% w_floor_ceiling=%',
    cw.w_l5, cw.w_l10, cw.w_season, cw.w_recent_form, cw.w_floor_ceiling;
  RAISE NOTICE '  w_b2b=% w_rest=% w_market_conf=% w_regression=% w_z_score=%',
    cw.w_b2b, cw.w_rest, cw.w_market_conf, cw.w_regression, cw.w_z_score;

  -- TASK 1.3 + 2 combined: distribution + per-bucket WR per factor.
  -- Filter: post-May-4 organic process-games, points/rebounds/assists,
  -- resolved (hit IS NOT NULL), not voided.
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== score_pace distribution + per-bucket WR ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | %',
    LPAD('bucket', 7), LPAD('n', 6), LPAD('hits', 5), LPAD('miss', 5), LPAD('wr%', 7);
  FOR r IN
    SELECT score_pace AS b,
      COUNT(*) AS n,
      SUM(CASE WHEN hit=true THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN hit=false THEN 1 ELSE 0 END) AS miss,
      ROUND(100.0 * SUM(CASE WHEN hit=true THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 2) AS wr
    FROM pick_history
    WHERE source = 'process-games'
      AND created_at >= '2026-05-04'::timestamptz
      AND hit IS NOT NULL AND voided IS NOT TRUE
      AND prop_type IN ('points','rebounds','assists')
    GROUP BY score_pace ORDER BY score_pace
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      LPAD(COALESCE(r.b::TEXT,'(null)'), 7),
      LPAD(r.n::TEXT, 6), LPAD(r.hits::TEXT, 5), LPAD(r.miss::TEXT, 5),
      LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== score_opp_defense distribution + per-bucket WR ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | %',
    LPAD('bucket', 7), LPAD('n', 6), LPAD('hits', 5), LPAD('miss', 5), LPAD('wr%', 7);
  FOR r IN
    SELECT score_opp_defense AS b, COUNT(*) AS n,
      SUM(CASE WHEN hit=true THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN hit=false THEN 1 ELSE 0 END) AS miss,
      ROUND(100.0 * SUM(CASE WHEN hit=true THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 2) AS wr
    FROM pick_history
    WHERE source = 'process-games'
      AND created_at >= '2026-05-04'::timestamptz
      AND hit IS NOT NULL AND voided IS NOT TRUE
      AND prop_type IN ('points','rebounds','assists')
    GROUP BY score_opp_defense ORDER BY score_opp_defense
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      LPAD(COALESCE(r.b::TEXT,'(null)'), 7),
      LPAD(r.n::TEXT, 6), LPAD(r.hits::TEXT, 5), LPAD(r.miss::TEXT, 5),
      LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== score_home_away_split distribution + per-bucket WR ===';
  RAISE NOTICE '   (note: column is score_home_away_split, weight key w_ha_split)';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | %',
    LPAD('bucket', 7), LPAD('n', 6), LPAD('hits', 5), LPAD('miss', 5), LPAD('wr%', 7);
  FOR r IN
    SELECT score_home_away_split AS b, COUNT(*) AS n,
      SUM(CASE WHEN hit=true THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN hit=false THEN 1 ELSE 0 END) AS miss,
      ROUND(100.0 * SUM(CASE WHEN hit=true THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 2) AS wr
    FROM pick_history
    WHERE source = 'process-games'
      AND created_at >= '2026-05-04'::timestamptz
      AND hit IS NOT NULL AND voided IS NOT TRUE
      AND prop_type IN ('points','rebounds','assists')
    GROUP BY score_home_away_split ORDER BY score_home_away_split
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      LPAD(COALESCE(r.b::TEXT,'(null)'), 7),
      LPAD(r.n::TEXT, 6), LPAD(r.hits::TEXT, 5), LPAD(r.miss::TEXT, 5),
      LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== score_minutes_trend distribution + per-bucket WR ===';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '% | % | % | % | %',
    LPAD('bucket', 7), LPAD('n', 6), LPAD('hits', 5), LPAD('miss', 5), LPAD('wr%', 7);
  FOR r IN
    SELECT score_minutes_trend AS b, COUNT(*) AS n,
      SUM(CASE WHEN hit=true THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN hit=false THEN 1 ELSE 0 END) AS miss,
      ROUND(100.0 * SUM(CASE WHEN hit=true THEN 1 ELSE 0 END)
        / NULLIF(COUNT(*), 0), 2) AS wr
    FROM pick_history
    WHERE source = 'process-games'
      AND created_at >= '2026-05-04'::timestamptz
      AND hit IS NOT NULL AND voided IS NOT TRUE
      AND prop_type IN ('points','rebounds','assists')
    GROUP BY score_minutes_trend ORDER BY score_minutes_trend
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      LPAD(COALESCE(r.b::TEXT,'(null)'), 7),
      LPAD(r.n::TEXT, 6), LPAD(r.hits::TEXT, 5), LPAD(r.miss::TEXT, 5),
      LPAD(COALESCE(r.wr::TEXT, '—'), 7);
  END LOOP;

  -- TASK 1.3 additional: how often does each factor fire (non-zero) on
  -- the post-May-4 organic corpus? Dead factors won't help even if
  -- weight reactivation passes backtest.
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== Fire rate per factor (post-May-4 organic, all prop_types ex spread/game_total) ===';
  RAISE NOTICE '========================================================';
  FOR r IN
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE COALESCE(score_pace, 0) <> 0) AS pace_fires,
      COUNT(*) FILTER (WHERE COALESCE(score_opp_defense, 0) <> 0) AS opp_fires,
      COUNT(*) FILTER (WHERE COALESCE(score_home_away_split, 0) <> 0) AS ha_fires,
      COUNT(*) FILTER (WHERE COALESCE(score_minutes_trend, 0) <> 0) AS mt_fires
    FROM pick_history
    WHERE source = 'process-games'
      AND created_at >= '2026-05-04'::timestamptz
      AND prop_type NOT IN ('spread','game_total')
  LOOP
    RAISE NOTICE 'total=%  pace_fires=% (%%%)  opp_fires=% (%%%)  ha_fires=% (%%%)  mt_fires=% (%%%)',
      r.total,
      r.pace_fires, ROUND(100.0 * r.pace_fires / NULLIF(r.total, 0), 1),
      r.opp_fires,  ROUND(100.0 * r.opp_fires  / NULLIF(r.total, 0), 1),
      r.ha_fires,   ROUND(100.0 * r.ha_fires   / NULLIF(r.total, 0), 1),
      r.mt_fires,   ROUND(100.0 * r.mt_fires   / NULLIF(r.total, 0), 1);
  END LOOP;
END $$;
