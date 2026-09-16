-- D-543 follow-up — does the D-538 AGREE gate fix the apparent
-- pre-D-538 losses on pitcher_k and game_side?
--
-- For each market, count AGREE-gated vs DISAGREE-gated picks
-- (using projected_stat in breakdown when present, else a market-
-- specific direction proxy). Compute ROI both ways with real odds.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- Check breakdown coverage of projected_stat per market.
  RAISE NOTICE '======== D-543 follow §1: projected_stat coverage by market ========';
  FOR r IN
    SELECT
      mlb_market_type,
      count(*) AS n_total,
      count(*) FILTER (WHERE breakdown ? 'projected_stat') AS has_proj
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 follow §1] %: n_total=% has_projected_stat=%',
    r.mlb_market_type, r.n_total, r.has_proj; END LOOP;

  -- For BATTER markets (hits, pitcher_k, total_bases, etc.) the gate uses
  -- breakdown.projected_stat vs line.
  -- For GAME_SIDE the projection direction is in breakdown.expected_winner or similar.
  -- For now: only run gated for markets with projected_stat coverage.
  RAISE NOTICE '======== D-543 follow §2: AGREE-gated edge per sellable market, conf>=70 ========';

  FOR r IN
    SELECT
      mlb_market_type,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp,
      ROUND(SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                     WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                     WHEN NOT hit THEN -1.0 END)::numeric, 2) AS profit,
      ROUND(100.0 * SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                             WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                             WHEN NOT hit THEN -1.0 END) / NULLIF(count(*), 0)::numeric, 2) AS roi_pct
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
      AND mlb_market_type IN ('batter_hits', 'pitcher_k', 'batter_total_bases',
                              'batter_hr', 'batter_rbis')
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='over'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='under')
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 follow §2] AGREE %: n=% win=% real_BE=% edge_pp=% profit=% roi=%',
    r.mlb_market_type, r.n, r.win_pct, r.real_BE, r.edge_pp, r.profit, r.roi_pct; END LOOP;

  -- DISAGREE picks (the ones D-538 now rejects) — were they losing?
  RAISE NOTICE '======== D-543 follow §3: DISAGREE-gated (REJECTED post-D-538) per market, conf>=70 ========';
  FOR r IN
    SELECT
      mlb_market_type,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp,
      ROUND(100.0 * SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                             WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                             WHEN NOT hit THEN -1.0 END) / NULLIF(count(*), 0)::numeric, 2) AS roi_pct
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
      AND mlb_market_type IN ('batter_hits', 'pitcher_k', 'batter_total_bases',
                              'batter_hr', 'batter_rbis')
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='under'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='over')
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 follow §3] DISAGREE %: n=% win=% real_BE=% edge_pp=% roi=%',
    r.mlb_market_type, r.n, r.win_pct, r.real_BE, r.edge_pp, r.roi_pct; END LOOP;

  -- For game_side: look at the prop_type (spreads vs h2h)
  -- Spreads: line is the spread number. WR depends on team_pick + spread cover.
  -- h2h: pick the moneyline. The actual WR depends on team_pick vs winner.
  -- pre-gate measurement only — these markets don't have projected_stat
  -- written in the same way.
  RAISE NOTICE '======== D-543 follow §4: game_side and game_total — RAW conf>=70 with REAL odds ========';
  FOR r IN
    SELECT
      mlb_market_type, prop_type,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp,
      ROUND(100.0 * SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                             WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                             WHEN NOT hit THEN -1.0 END) / NULLIF(count(*), 0)::numeric, 2) AS roi_pct
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
      AND mlb_market_type IN ('game_side', 'game_total')
    GROUP BY mlb_market_type, prop_type ORDER BY mlb_market_type, prop_type
  LOOP RAISE NOTICE '[D-543 follow §4] mkt=% prop_type=% n=% win=% real_BE=% edge=% roi=%',
    r.mlb_market_type, r.prop_type, r.n, r.win_pct, r.real_BE, r.edge_pp, r.roi_pct; END LOOP;
END $$;
