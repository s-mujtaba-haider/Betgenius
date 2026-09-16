-- D-532 SHIP 1 — Fully map the training corpus.
-- READ-ONLY.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  RAISE NOTICE '======== D-532 §A: corpus inventory ========';

  FOR r IN
    SELECT
      'd366 MV (current trainer corpus)' AS source,
      count(*) AS rows,
      count(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
      count(*) FILTER (WHERE hit IS NOT NULL AND prop_type LIKE 'batter_%') AS batter_resolved,
      count(*) FILTER (WHERE hit IS NOT NULL AND prop_type IN ('pitcher_strikeouts','pitcher_k')) AS pitcher_resolved,
      count(*) FILTER (WHERE hit IS NOT NULL AND prop_type IN ('game_side','game_total')) AS game_resolved
    FROM public.d366_factor_scores
  LOOP RAISE NOTICE '[D-532 §A.1] %: rows=% resolved=% (batter=% pitcher=% game=%)',
    r.source, r.rows, r.resolved, r.batter_resolved, r.pitcher_resolved, r.game_resolved; END LOOP;

  FOR r IN
    SELECT
      'pick_history (mlb, organic, resolved)' AS source,
      count(*) FILTER (WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL AND voided IS NOT TRUE) AS rows
    FROM public.pick_history
  LOOP RAISE NOTICE '[D-532 §A.2] %: rows=%', r.source, r.rows; END LOOP;

  FOR r IN
    SELECT
      'pick_history (mlb, organic, resolved, with breakdown JSONB)' AS source,
      count(*) FILTER (WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL AND voided IS NOT TRUE AND breakdown IS NOT NULL) AS rows,
      count(*) FILTER (WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL AND voided IS NOT TRUE AND breakdown IS NOT NULL AND breakdown ? 'score_batter_hit_rate') AS with_scores
    FROM public.pick_history
  LOOP RAISE NOTICE '[D-532 §A.3] %: rows=% with_score_keys=%', r.source, r.rows, r.with_scores; END LOOP;

  RAISE NOTICE '======== D-532 §B: synth WR vs organic WR by mlb_market_type ========';
  -- Use mlb_market_type for the join (canonical algo key)
  -- For synthetic rows that have mlb_market_type=NULL, infer it from
  -- prop_type via the D-531 mapping.
  FOR r IN
    WITH labeled AS (
      SELECT
        CASE
          WHEN mlb_market_type IS NOT NULL THEN mlb_market_type
          WHEN prop_type = 'batter_hits'        THEN 'batter_hits'
          WHEN prop_type = 'batter_rbis'        THEN 'batter_rbis'
          WHEN prop_type = 'batter_total_bases' THEN 'batter_total_bases'
          WHEN prop_type = 'batter_home_runs'   THEN 'batter_hr'
          WHEN prop_type = 'pitcher_strikeouts' THEN 'pitcher_k'
          WHEN prop_type = 'game_total'         THEN 'game_total'
          WHEN prop_type = 'game_side'          THEN 'game_side'
          ELSE NULL
        END AS market_canonical,
        is_synthetic, hit, confidence
      FROM public.pick_history
      WHERE sport='mlb' AND voided IS NOT TRUE AND hit IS NOT NULL
    )
    SELECT
      market_canonical,
      count(*) FILTER (WHERE is_synthetic = true) AS synth_n,
      ROUND(100.0 * count(*) FILTER (WHERE is_synthetic = true AND hit) / NULLIF(count(*) FILTER (WHERE is_synthetic = true), 0), 1) AS synth_wr,
      count(*) FILTER (WHERE is_synthetic = false) AS organic_n,
      ROUND(100.0 * count(*) FILTER (WHERE is_synthetic = false AND hit) / NULLIF(count(*) FILTER (WHERE is_synthetic = false), 0), 1) AS organic_wr,
      ROUND(
        100.0 * count(*) FILTER (WHERE is_synthetic = true AND hit) / NULLIF(count(*) FILTER (WHERE is_synthetic = true), 0)
        - 100.0 * count(*) FILTER (WHERE is_synthetic = false AND hit) / NULLIF(count(*) FILTER (WHERE is_synthetic = false), 0)
      , 1) AS gap_pp
    FROM labeled
    WHERE market_canonical IS NOT NULL
    GROUP BY market_canonical ORDER BY organic_n DESC
  LOOP RAISE NOTICE '[D-532 §B.1] market=% synth_n=% synth_wr=% organic_n=% organic_wr=% gap=%pp',
    r.market_canonical, r.synth_n, r.synth_wr, r.organic_n, r.organic_wr, r.gap_pp; END LOOP;

  RAISE NOTICE '======== D-532 §C: organic-only resolved samples at conf>=70 and >=80 ========';
  FOR r IN
    SELECT
      CASE
        WHEN mlb_market_type IS NOT NULL THEN mlb_market_type
        WHEN prop_type = 'home_runs' THEN 'batter_hr'
        WHEN prop_type = 'hits' THEN 'batter_hits'
        WHEN prop_type = 'total_bases' THEN 'batter_total_bases'
        WHEN prop_type = 'rbis' THEN 'batter_rbis'
        WHEN prop_type IN ('totals') THEN 'game_total'
        WHEN prop_type IN ('spreads','h2h') THEN 'game_side'
        WHEN prop_type IN ('pitcher_strikeouts') THEN 'pitcher_k'
        ELSE NULL
      END AS market_canonical,
      count(*) AS total_n,
      count(*) FILTER (WHERE confidence >= 70) AS n_70,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 70), 0), 1) AS wr_70,
      count(*) FILTER (WHERE confidence >= 80) AS n_80,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 80), 0), 1) AS wr_80,
      count(*) FILTER (WHERE confidence >= 90) AS n_90,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 90 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 90), 0), 1) AS wr_90
    FROM public.pick_history
    WHERE sport='mlb' AND voided IS NOT TRUE AND is_synthetic = false
      AND hit IS NOT NULL
    GROUP BY market_canonical
    ORDER BY total_n DESC
  LOOP RAISE NOTICE '[D-532 §C.1] market=% total_n=% n_70=% wr_70=% n_80=% wr_80=% n_90=% wr_90=%',
    r.market_canonical, r.total_n, r.n_70, r.wr_70, r.n_80, r.wr_80, r.n_90, r.wr_90; END LOOP;

  RAISE NOTICE '======== D-532 §D: organic resolved + breakdown + ai_analysis coverage (for MV-compatible build) ========';
  FOR r IN
    SELECT
      count(*) AS organic_resolved,
      count(*) FILTER (WHERE breakdown IS NOT NULL) AS with_breakdown,
      count(*) FILTER (WHERE ai_analysis IS NOT NULL) AS with_ai,
      count(*) FILTER (WHERE breakdown IS NOT NULL AND breakdown ? 'score_batter_hit_rate') AS with_score_keys
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic = false AND voided IS NOT TRUE AND hit IS NOT NULL
  LOOP RAISE NOTICE '[D-532 §D.1] organic resolved=% with_breakdown=% with_ai=% with_score_keys=%',
    r.organic_resolved, r.with_breakdown, r.with_ai, r.with_score_keys; END LOOP;

  -- Age distribution — when did the organic resolved picks land?
  FOR r IN
    SELECT
      date_trunc('week', game_date::date) AS week,
      count(*) AS resolved,
      count(*) FILTER (WHERE breakdown IS NOT NULL) AS with_breakdown
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic = false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND game_date IS NOT NULL
    GROUP BY week
    ORDER BY week DESC LIMIT 10
  LOOP RAISE NOTICE '[D-532 §D.2] week=% resolved=% with_breakdown=%',
    r.week::date, r.resolved, r.with_breakdown; END LOOP;
END $$;
