-- D-543 — Re-validate every MLB market against REAL per-pick break-even.
--
-- Read-only. The D-541 measurement bug (assumed -110 nominal BE of 52.4%)
-- could have biased every prior verdict on every market. Recompute for
-- ALL MLB markets at conf>=70 and conf>=80, using per-pick odds.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  RAISE NOTICE '======== D-543 §A: Every MLB market — conf>=70 with REAL per-pick BE ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(odds)::numeric, 1) AS avg_odds,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY odds)::numeric, 1) AS med_odds,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp_real,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric - 52.38, 2) AS edge_pp_nominal_110
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 §A.1] market=% n=% win=% avg_odds=% med_odds=% real_BE=% edge_REAL=% edge_NOMINAL=%',
    r.market, r.n, r.win_pct, r.avg_odds, r.med_odds, r.real_BE, r.edge_pp_real, r.edge_pp_nominal_110; END LOOP;

  RAISE NOTICE '======== D-543 §B: Every MLB market — conf>=80 with REAL per-pick BE ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(odds)::numeric, 1) AS avg_odds,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp_real,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric - 52.38, 2) AS edge_pp_nominal_110
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 80 AND odds IS NOT NULL
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 §B.1] market=% n=% win=% avg_odds=% real_BE=% edge_REAL=% edge_NOMINAL=%',
    r.market, r.n, r.win_pct, r.avg_odds, r.real_BE, r.edge_pp_real, r.edge_pp_nominal_110; END LOOP;

  -- ===================================================================
  -- §C — Sellable markets with the D-538 AGREE gate (the production filter)
  -- For markets where projection direction is in breakdown.projected_stat
  -- ===================================================================
  RAISE NOTICE '======== D-543 §C: Sellable markets WITH AGREE-gate, conf>=70, real BE ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
      AND mlb_market_type IN ('batter_hits', 'pitcher_k', 'game_side')
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='over'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='under')
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 §C.1] AGREE-gate %: n=% win=% real_BE=% edge_pp=%',
    r.market, r.n, r.win_pct, r.real_BE, r.edge_pp; END LOOP;

  -- game_side projection is via spread differential — different mechanic.
  -- The breakdown field for game_side picks differs. Run game_side specifically:
  RAISE NOTICE '======== D-543 §D: game_side picks broken down by spreads vs h2h prop_type ========';
  FOR r IN
    SELECT
      prop_type,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(odds)::numeric, 1) AS avg_odds,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
      AND mlb_market_type = 'game_side'
    GROUP BY prop_type ORDER BY prop_type
  LOOP RAISE NOTICE '[D-543 §D.1] game_side prop_type=% n=% win=% avg_odds=% real_BE=% edge_pp=%',
    r.prop_type, r.n, r.win_pct, r.avg_odds, r.real_BE, r.edge_pp; END LOOP;

  -- ===================================================================
  -- §E — Volume + odds distribution by market (juice profile)
  -- Show how many picks per market and how juicy each is on average.
  -- ===================================================================
  RAISE NOTICE '======== D-543 §E: per-market juice profile ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      ROUND(avg(odds)::numeric, 1) AS avg_odds,
      ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY odds)::numeric, 1) AS p25,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY odds)::numeric, 1) AS med,
      ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY odds)::numeric, 1) AS p75,
      count(*) FILTER (WHERE odds < -110) AS n_juicier_110,
      count(*) FILTER (WHERE odds < -150) AS n_juicier_150
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND odds IS NOT NULL
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 §E.1] %: n=% avg=% p25=% med=% p75=% n_lt-110=% pct_lt-110=% n_lt-150=% pct_lt-150=%',
    r.market, r.n, r.avg_odds, r.p25, r.med, r.p75, r.n_juicier_110,
    ROUND(100.0 * r.n_juicier_110 / NULLIF(r.n, 0)::numeric, 1), r.n_juicier_150,
    ROUND(100.0 * r.n_juicier_150 / NULLIF(r.n, 0)::numeric, 1); END LOOP;

  -- ===================================================================
  -- §F — ROI proxy: profit/loss in units (the bottom line)
  -- For each pick at +odds wins => odds/100, -odds wins => 100/abs(odds).
  -- Loss = -1. Sum across picks at conf>=70 with AGREE gate (sellable
  -- production filter).
  -- ===================================================================
  RAISE NOTICE '======== D-543 §F: ROI (units) per sellable market, conf>=70, AGREE gate ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n,
      ROUND(SUM(
        CASE
          WHEN hit AND odds > 0 THEN odds::numeric / 100.0
          WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
          WHEN NOT hit THEN -1.0
        END
      )::numeric, 2) AS profit_units,
      ROUND(100.0 * SUM(
        CASE
          WHEN hit AND odds > 0 THEN odds::numeric / 100.0
          WHEN hit AND odds < 0 THEN 100.0 / (-odds::numeric)
          WHEN NOT hit THEN -1.0
        END
      ) / NULLIF(count(*), 0)::numeric, 2) AS roi_pct
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND confidence >= 70 AND odds IS NOT NULL
      AND mlb_market_type IN ('batter_hits', 'pitcher_k', 'game_side',
                              'batter_total_bases', 'batter_hr', 'batter_rbis',
                              'game_total')
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '[D-543 §F.1] % n=% profit_units=% roi_pct=%',
    r.market, r.n, r.profit_units, r.roi_pct; END LOOP;
END $$;
