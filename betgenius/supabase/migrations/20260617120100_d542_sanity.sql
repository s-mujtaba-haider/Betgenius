-- D-542 sanity — verify post-D-520 / post-D-538 TB volume and odds distribution.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-542 sanity §1: ALL TB picks since 2026-06-13 (not just resolved) ========';
  FOR r IN
    SELECT
      count(*) AS n_all,
      count(*) FILTER (WHERE hit IS NOT NULL) AS n_resolved,
      count(*) FILTER (WHERE confidence >= 70) AS n_c70_all,
      count(*) FILTER (WHERE confidence >= 70 AND hit IS NOT NULL) AS n_c70_resolved,
      count(*) FILTER (WHERE confidence >= 80) AS n_c80_all,
      min(game_date) AS first_dt, max(game_date) AS last_dt
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND game_date >= '2026-06-13'
  LOOP RAISE NOTICE '[D-542 SANITY 1] n_all=% resolved=% c70_all=% c70_resolved=% c80_all=% (% .. %)',
    r.n_all, r.n_resolved, r.n_c70_all, r.n_c70_resolved, r.n_c80_all, r.first_dt, r.last_dt; END LOOP;

  RAISE NOTICE '======== D-542 sanity §2: odds distribution on resolved TB picks (D-541 confusion) ========';
  FOR r IN
    SELECT
      'conf>=70 PRE-D520 odds distribution' AS bucket,
      count(*) AS n,
      ROUND(avg(odds)::numeric, 1) AS avg_odds,
      ROUND(min(odds)::numeric, 1) AS min_odds,
      ROUND(max(odds)::numeric, 1) AS max_odds,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY odds)::numeric, 1) AS median_odds,
      count(*) FILTER (WHERE odds < -110) AS n_juicier_than_110
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 70 AND game_date < '2026-06-13'
  LOOP RAISE NOTICE '[D-542 SANITY 2] %: n=% avg_odds=% median_odds=% min=% max=% n_juicier_than_-110=%',
    r.bucket, r.n, r.avg_odds, r.median_odds, r.min_odds, r.max_odds, r.n_juicier_than_110; END LOOP;

  RAISE NOTICE '======== D-542 sanity §3: hits market for comparison (proven +EV) ========';
  FOR r IN
    SELECT
      'hits conf>=70 PRE-D520' AS bucket,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_hits' AND hit IS NOT NULL
      AND confidence >= 70 AND game_date < '2026-06-13'
  LOOP RAISE NOTICE '[D-542 SANITY 3] %: n=% win=% avg_BE=% edge_pp=%',
    r.bucket, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;
END $$;
