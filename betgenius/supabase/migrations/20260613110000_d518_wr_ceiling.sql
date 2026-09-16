DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §0 Context: when did the live weights last change?
  RAISE NOTICE '[D-518 §0] algorithm_weights row + last update (= D-499 apply boundary):';
  FOR r IN
    SELECT id, updated_at, backtest_win_pct, backtest_roi, backtest_picks
    FROM public.algorithm_weights ORDER BY id
  LOOP RAISE NOTICE '  id=% updated=% bt_wr=% bt_roi=% bt_picks=%',
    r.id, r.updated_at, r.backtest_win_pct, r.backtest_roi, r.backtest_picks; END LOOP;

  -- §1 OOS vs in-sample: split by game_date vs the D-499 apply boundary
  RAISE NOTICE '[D-518 §1] OOS vs IN-SAMPLE WR by sport (split at D-499 apply 2026-06-10):';
  FOR r IN
    SELECT
      sport,
      CASE WHEN game_date < DATE '2026-06-10' THEN 'IN-SAMPLE (pre-D499)'
           ELSE 'OOS (post-D499)' END AS regime,
      count(*) AS n,
      count(*) FILTER (WHERE hit) AS wins,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr,
      ROUND(avg(odds), 0) AS avg_odds
    FROM public.pick_history_real
    WHERE is_synthetic=false AND hit IS NOT NULL
    GROUP BY sport, regime
    ORDER BY sport, regime
  LOOP RAISE NOTICE '  sport=% regime=% n=% wins=% WR=% avg_odds=%',
    r.sport, r.regime, r.n, r.wins, r.wr, r.avg_odds; END LOOP;

  -- §1b Same but at conf>=80 tier (the "sellable" cohort)
  RAISE NOTICE '[D-518 §1b] OOS vs IN-SAMPLE at conf>=80 (sellable tier):';
  FOR r IN
    SELECT
      sport,
      CASE WHEN game_date < DATE '2026-06-10' THEN 'IN-SAMPLE' ELSE 'OOS' END AS regime,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE is_synthetic=false AND hit IS NOT NULL AND confidence >= 80
    GROUP BY sport, regime
    ORDER BY sport, regime
  LOOP RAISE NOTICE '  sport=% regime=% n=% WR=%',
    r.sport, r.regime, r.n, r.wr; END LOOP;

  -- §2 Per-market ceiling: MLB at top tier (conf>=80) by market
  RAISE NOTICE '[D-518 §2] MLB per-market WR at conf>=80 (sellable tier):';
  FOR r IN
    SELECT
      mlb_market_type,
      count(*) AS n_total,
      count(*) FILTER (WHERE confidence >= 80) AS n_80plus,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit)
            / NULLIF(count(*) FILTER (WHERE confidence >= 80), 0), 2) AS wr_80plus,
      count(*) FILTER (WHERE confidence >= 90) AS n_90plus,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 90 AND hit)
            / NULLIF(count(*) FILTER (WHERE confidence >= 90), 0), 2) AS wr_90plus,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr_overall
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
    GROUP BY mlb_market_type ORDER BY wr_80plus DESC NULLS LAST
  LOOP RAISE NOTICE '  market=% n_total=% n_80=% WR_80=% n_90=% WR_90=% WR_overall=%',
    r.mlb_market_type, r.n_total, r.n_80plus, r.wr_80plus, r.n_90plus, r.wr_90plus, r.wr_overall; END LOOP;

  -- §2b — MLB BUT only OOS data
  RAISE NOTICE '[D-518 §2b] MLB per-market WR at conf>=80 — OOS ONLY (post-D499):';
  FOR r IN
    SELECT mlb_market_type,
           count(*) FILTER (WHERE confidence >= 80) AS n_80,
           ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit)
                 / NULLIF(count(*) FILTER (WHERE confidence >= 80), 0), 2) AS wr_80
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
      AND game_date >= DATE '2026-06-10'
    GROUP BY mlb_market_type
    HAVING count(*) FILTER (WHERE confidence >= 80) > 0
    ORDER BY wr_80 DESC NULLS LAST
  LOOP RAISE NOTICE '  market=% n_80=% WR_80=%',
    r.mlb_market_type, r.n_80, r.wr_80; END LOOP;

  -- §3 NBA vs MLB head-to-head at top tier
  RAISE NOTICE '[D-518 §3] NBA vs MLB head-to-head — WR by conf band:';
  FOR r IN
    SELECT sport,
           CASE WHEN confidence >= 90 THEN '90+'
                WHEN confidence BETWEEN 80 AND 89 THEN '80-89'
                WHEN confidence BETWEEN 70 AND 79 THEN '70-79'
                WHEN confidence BETWEEN 60 AND 69 THEN '60-69'
                ELSE '<60' END AS band,
           count(*) AS n,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr,
           ROUND(avg(odds), 0) AS avg_odds
    FROM public.pick_history_real
    WHERE is_synthetic=false AND hit IS NOT NULL
    GROUP BY sport, band
    ORDER BY sport, band DESC
  LOOP RAISE NOTICE '  sport=% band=% n=% WR=% avg_odds=%',
    r.sport, r.band, r.n, r.wr, r.avg_odds; END LOOP;

  -- §4 Theoretical ceiling — high-implied-prob (heavy favorite) sub-cohort,
  -- per market. Highest WR achievable on each market without sport switching.
  RAISE NOTICE '[D-518 §4a] heavy favorites (odds<=-200) WR by market — practical ceiling:';
  FOR r IN
    SELECT mlb_market_type,
           count(*) AS n,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr_fav,
           ROUND(avg(odds), 0) AS avg_odds
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
      AND odds <= -200
    GROUP BY mlb_market_type
    HAVING count(*) >= 20
    ORDER BY wr_fav DESC
  LOOP RAISE NOTICE '  market=% n=% WR_fav=% avg_odds=%',
    r.mlb_market_type, r.n, r.wr_fav, r.avg_odds; END LOOP;

  -- §4b — Oracle ranking: if we sorted by hit (truth), top 10% of MLB picks
  -- per market by some implied-probability proxy. Compute "best 10% by odds-implied-prob"
  RAISE NOTICE '[D-518 §4b] WR of top 10pct by implied-prob proxy (odds-based), MLB:';
  FOR r IN
    WITH ranked AS (
      SELECT mlb_market_type, hit, odds,
             ROW_NUMBER() OVER (
               PARTITION BY mlb_market_type
               ORDER BY (CASE WHEN odds > 0 THEN 100.0/(odds+100) ELSE (-odds)*1.0/((-odds)+100) END) DESC,
                        random()
             ) AS rk,
             count(*) OVER (PARTITION BY mlb_market_type) AS total_per_mkt
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
    )
    SELECT mlb_market_type,
           count(*) AS n_top10,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr_top10
    FROM ranked
    WHERE rk <= total_per_mkt * 0.1
    GROUP BY mlb_market_type
    HAVING count(*) >= 20
    ORDER BY wr_top10 DESC
  LOOP RAISE NOTICE '  market=% top10pct_n=% WR=%',
    r.mlb_market_type, r.n_top10, r.wr_top10; END LOOP;

  -- §4c — break-even and edge per band (to know what WR matters at what odds)
  RAISE NOTICE '[D-518 §4c] MLB conf>=80 by market: avg_odds + BE rate + WR - BE = edge:';
  FOR r IN
    SELECT mlb_market_type,
           count(*) AS n,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr,
           ROUND(avg(odds), 0) AS avg_odds,
           ROUND(100.0 * avg(CASE WHEN odds > 0 THEN 100.0/(odds+100) ELSE (-odds)*1.0/((-odds)+100) END), 2) AS avg_be_pct
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL AND confidence >= 80
    GROUP BY mlb_market_type
    HAVING count(*) >= 20
    ORDER BY (
      100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0) -
      100.0 * avg(CASE WHEN odds > 0 THEN 100.0/(odds+100) ELSE (-odds)*1.0/((-odds)+100) END)
    ) DESC
  LOOP RAISE NOTICE '  market=% n=% WR=% avg_odds=% BE=% edge_pp=%',
    r.mlb_market_type, r.n, r.wr, r.avg_odds, r.avg_be_pct,
    r.wr - r.avg_be_pct; END LOOP;
END $$;
