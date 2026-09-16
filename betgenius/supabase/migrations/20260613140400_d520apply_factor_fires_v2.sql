-- D-520-APPLY SHIP 2 §E + §F (v2) — schema-correct version.
-- Previous v1 used `mlb_market_type` on recommendations_cache which doesn't exist.
DO $$
DECLARE r RECORD; v_cache_market_col text;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- Discover the cache's market column at runtime so the migration is robust
  SELECT column_name INTO v_cache_market_col
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='recommendations_cache'
    AND column_name IN ('mlb_market_type','market_type','market','prop_type','market_key')
  ORDER BY array_position(
    ARRAY['mlb_market_type','market_type','market','prop_type','market_key']::text[],
    column_name)
  LIMIT 1;

  RAISE NOTICE '[D-520-APPLY §E.0] recommendations_cache market column = %', v_cache_market_col;

  -- §E.1 — pick_history_real batter picks with new factor in breakdown
  RAISE NOTICE '[D-520-APPLY §E.1] pick_history_real batter picks with new factor:';
  FOR r IN
    SELECT
      count(*) AS total_batter,
      count(*) FILTER (WHERE breakdown ? 'score_batter_line_hit_rate') AS with_new_factor,
      count(*) FILTER (WHERE breakdown ? 'score_batter_line_hit_rate' AND created_at > now() - interval '1 hour') AS post_apply_1h
    FROM public.pick_history_real
    WHERE sport='mlb' AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '  total_batter=% with_new_factor=% post_apply_1h=%',
    r.total_batter, r.with_new_factor, r.post_apply_1h; END LOOP;

  -- §E.2 — recommendations_cache batter picks with new factor (dynamic SQL
  -- because the market column name may vary)
  RAISE NOTICE '[D-520-APPLY §E.2] recommendations_cache batter picks with new factor:';
  IF v_cache_market_col IS NULL THEN
    RAISE NOTICE '  (recommendations_cache market column unknown — skipping)';
  ELSE
    FOR r IN EXECUTE format($f$
      SELECT
        count(*) AS total_batter,
        count(*) FILTER (WHERE breakdown ? 'score_batter_line_hit_rate') AS with_new_factor,
        count(*) FILTER (WHERE breakdown ? 'score_batter_line_hit_rate'
                         AND created_at > now() - interval '1 hour') AS post_apply_1h
      FROM public.recommendations_cache
      WHERE sport='mlb' AND %I LIKE 'batter_%%' AND breakdown IS NOT NULL
    $f$, v_cache_market_col)
    LOOP RAISE NOTICE '  total_batter=% with_new_factor=% post_apply_1h=%',
      r.total_batter, r.with_new_factor, r.post_apply_1h; END LOOP;
  END IF;

  -- §E.3 — sample post-apply batter breakdowns showing the new factor firing
  RAISE NOTICE '[D-520-APPLY §E.3] sample batter breakdowns with new factor:';
  IF v_cache_market_col IS NOT NULL THEN
    FOR r IN EXECUTE format($f$
      SELECT
        %I::text AS market,
        pick_side::text AS side,
        confidence::int AS conf,
        breakdown->>'last10_hit_rate_pct'        AS l10_pct,
        breakdown->>'score_batter_line_hit_rate' AS lhr_score,
        breakdown->>'score_handedness_matchup'   AS hand_score,
        breakdown->>'score_recent_at_bats'       AS rab_score
      FROM public.recommendations_cache
      WHERE sport='mlb' AND %I LIKE 'batter_%%'
        AND breakdown ? 'score_batter_line_hit_rate'
      ORDER BY created_at DESC LIMIT 5
    $f$, v_cache_market_col, v_cache_market_col)
    LOOP RAISE NOTICE '  market=% side=% conf=% l10=% lhr=% hand=% rab=%',
      r.market, r.side, r.conf, r.l10_pct, r.lhr_score, r.hand_score, r.rab_score;
    END LOOP;
  END IF;

  -- §F — non-batter market sanity (pre-existing pick_history_real, last 7d)
  RAISE NOTICE '[D-520-APPLY §F] pre-deploy pick_history_real non-batter distribution (7d):';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      ROUND(avg(confidence)::numeric, 2) AS mean_conf,
      min(confidence) AS min_conf,
      max(confidence) AS max_conf
    FROM public.pick_history_real
    WHERE sport='mlb'
      AND mlb_market_type IN ('pitcher_strikeouts', 'game_side', 'game_total', 'game_spread')
      AND created_at > now() - interval '7 days'
    GROUP BY mlb_market_type
    ORDER BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% mean=% min=% max=%',
    r.market, r.n, r.mean_conf, r.min_conf, r.max_conf;
  END LOOP;
END $$;
