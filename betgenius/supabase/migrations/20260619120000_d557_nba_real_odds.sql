-- D-557 SHIP 1 — NBA per-market real-odds edge audit.
-- Mirrors D-543 §A.1 (MLB). For each NBA prop_type, recompute WR vs
-- per-pick real BE on the organic resolved corpus. The +EV verdicts
-- below are the headline finding; the data-gap audit follows in the doc.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- ===================================================================
  -- §A — Volume + odds profile per NBA market (organic resolved corpus)
  -- ===================================================================
  RAISE NOTICE '======== D-557 §A: NBA per-market juice profile ========';
  FOR r IN
    SELECT
      LOWER(prop_type) AS market,
      count(*) AS n,
      ROUND(avg(odds)::numeric, 1) AS avg_odds,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY odds)::numeric, 1) AS med_odds,
      count(*) FILTER (WHERE odds < -110) AS n_juicier_110,
      ROUND(100.0 * count(*) FILTER (WHERE odds < -110) / NULLIF(count(*), 0)::numeric, 1) AS pct_lt_110
    FROM public.pick_history
    WHERE sport='nba' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND odds IS NOT NULL
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '[D-557 §A.1] %: n=% avg_odds=% med_odds=% n_lt-110=% pct=%',
    r.market, r.n, r.avg_odds, r.med_odds, r.n_juicier_110, r.pct_lt_110; END LOOP;

  -- ===================================================================
  -- §B — Real-odds edge per market at ALL CONF
  -- ===================================================================
  RAISE NOTICE '======== D-557 §B: per-NBA-market real-odds edge — ALL CONF ========';
  FOR r IN
    SELECT
      LOWER(prop_type) AS market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp_real,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric - 52.38, 2) AS edge_pp_nominal_110,
      ROUND(SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                     WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                     WHEN NOT hit THEN -1.0 END)::numeric, 2) AS profit_units,
      ROUND(100.0 * SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                             WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                             WHEN NOT hit THEN -1.0 END) / NULLIF(count(*), 0)::numeric, 2) AS roi_pct
    FROM public.pick_history
    WHERE sport='nba' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND odds IS NOT NULL
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '[D-557 §B.1] %: n=% win=% real_BE=% edge_REAL=% edge_NOMINAL=% profit=% ROI=%',
    r.market, r.n, r.win_pct, r.real_BE, r.edge_pp_real, r.edge_pp_nominal_110, r.profit_units, r.roi_pct; END LOOP;

  -- ===================================================================
  -- §C — Real-odds edge per market at conf>=70
  -- ===================================================================
  RAISE NOTICE '======== D-557 §C: per-NBA-market real-odds edge — conf>=70 ========';
  FOR r IN
    SELECT
      LOWER(prop_type) AS market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp_real,
      ROUND(100.0 * SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                             WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                             WHEN NOT hit THEN -1.0 END) / NULLIF(count(*), 0)::numeric, 2) AS roi_pct
    FROM public.pick_history
    WHERE sport='nba' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND odds IS NOT NULL AND confidence >= 70
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '[D-557 §C.1] conf>=70 %: n=% win=% real_BE=% edge_REAL=% ROI=%',
    r.market, r.n, r.win_pct, r.real_BE, r.edge_pp_real, r.roi_pct; END LOOP;

  -- ===================================================================
  -- §D — Real-odds edge per market at conf>=80
  -- ===================================================================
  RAISE NOTICE '======== D-557 §D: per-NBA-market real-odds edge — conf>=80 ========';
  FOR r IN
    SELECT
      LOWER(prop_type) AS market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp_real,
      ROUND(100.0 * SUM(CASE WHEN hit AND odds > 0 THEN odds::numeric / 100.0
                             WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
                             WHEN NOT hit THEN -1.0 END) / NULLIF(count(*), 0)::numeric, 2) AS roi_pct
    FROM public.pick_history
    WHERE sport='nba' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND odds IS NOT NULL AND confidence >= 80
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '[D-557 §D.1] conf>=80 %: n=% win=% real_BE=% edge_REAL=% ROI=%',
    r.market, r.n, r.win_pct, r.real_BE, r.edge_pp_real, r.roi_pct; END LOOP;
END $$;
