-- D-542 — Reconcile TB edge: D-540 said -5.3pp (scope out), D-541 OOS
-- said +63-64% WR at conf>=70 (+EV). Resolve the conflict.
--
-- Hypothesis grid:
--   (a) D-520-APPLY (2026-06-13) sign-flipped 9 batter weights → TB
--       performance materially changed after that date.
--   (b) D-538 hard-gate (2026-06-16, 1 day ago) only filters picks where
--       projection direction disagrees with pick_side. Pre-D-538
--       corpus included disagree-picks; post-D-538 doesn't. D-540
--       measured -5.3pp on corpus that included losing disagree-picks;
--       D-541 filtered to only agree-picks (retroactively simulating
--       the gate).
--   (c) Different date windows in the two measurements.
--   (d) Measurement bug.
--
-- Method:
--   §A — Current TB picks since 2026-06-13 (post-D-520, includes
--        1 day of post-D-538). Win rate + edge from actual odds.
--   §B — Same recomputation pre-D-520 (before 2026-06-13). Compare.
--   §C — Compare PROJECTION-AGREES vs DISAGREES picks pre-D-538
--        (the gate's effect, retroactively).
--   §D — Full corpus at conf>=70/>=80 with REAL odds-based breakeven.
--   §E — Restate D-541's "63-64%" finding to confirm it isn't a bug.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- Helper: American odds to implied breakeven % (decimal).
  -- breakeven for over+under combined (each side has different
  -- breakeven; we use per-pick odds).
  --   negative odds: breakeven = -odds / (100 + -odds) * 100
  --                  e.g., -110 → 110 / 210 = 52.38%
  --   positive odds: breakeven = 100 / (odds + 100) * 100
  --                  e.g., +110 → 100 / 210 = 47.62%

  RAISE NOTICE '======== D-542 §A: TB current era (post-D-520-APPLY, since 2026-06-13) ========';

  FOR r IN
    SELECT
      'conf>=70 (any direction)' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit)
        / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 70
      AND game_date >= '2026-06-13'
  LOOP RAISE NOTICE '[D-542 §A.1] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  FOR r IN
    SELECT
      'conf>=80 (any direction)' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit)
        / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 80
      AND game_date >= '2026-06-13'
  LOOP RAISE NOTICE '[D-542 §A.2] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  RAISE NOTICE '======== D-542 §B: TB pre-D-520-APPLY (before 2026-06-13) ========';

  FOR r IN
    SELECT
      'conf>=70 PRE-D520' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit)
        / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 70
      AND game_date < '2026-06-13'
  LOOP RAISE NOTICE '[D-542 §B.1] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  FOR r IN
    SELECT
      'conf>=80 PRE-D520' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit)
        / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 80
      AND game_date < '2026-06-13'
  LOOP RAISE NOTICE '[D-542 §B.2] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  -- ===================================================================
  -- §C — Pre-D-538 retroactive gate effect.
  -- Split pre-2026-06-13 corpus into AGREES (projection direction
  -- matches pick_side) vs DISAGREES. Win rates side-by-side.
  -- ===================================================================
  RAISE NOTICE '======== D-542 §C: pre-D538 gate effect — AGREES vs DISAGREES ========';

  FOR r IN
    SELECT
      'AGREES conf>=70 pre-D538' AS bucket,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 70
      AND game_date < '2026-06-16'
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='over'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='under')
  LOOP RAISE NOTICE '[D-542 §C.1] %: n=% win=% avg_BE=%',
    r.bucket, r.n, r.win_pct, r.avg_BE; END LOOP;

  FOR r IN
    SELECT
      'DISAGREES conf>=70 pre-D538 (would be REJECTED by gate)' AS bucket,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 70
      AND game_date < '2026-06-16'
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='under'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='over')
  LOOP RAISE NOTICE '[D-542 §C.2] %: n=% win=% avg_BE=%',
    r.bucket, r.n, r.win_pct, r.avg_BE; END LOOP;

  -- ===================================================================
  -- §D — Full historical TB edge (the D-540 measurement, recomputed with real odds)
  -- ===================================================================
  RAISE NOTICE '======== D-542 §D: TB FULL HISTORICAL — no date filter ========';

  FOR r IN
    SELECT
      'conf>=70 FULL HIST (no gate)' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 70
  LOOP RAISE NOTICE '[D-542 §D.1] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  FOR r IN
    SELECT
      'conf>=80 FULL HIST (no gate)' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 80
  LOOP RAISE NOTICE '[D-542 §D.2] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  -- Gated FULL historical (the D-541 OOS-equivalent on full corpus)
  FOR r IN
    SELECT
      'conf>=70 FULL HIST + AGREE gate' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 70
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='over'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='under')
  LOOP RAISE NOTICE '[D-542 §D.3] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  FOR r IN
    SELECT
      'conf>=80 FULL HIST + AGREE gate' AS tier,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND confidence >= 80
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='over'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='under')
  LOOP RAISE NOTICE '[D-542 §D.4] %: n=% win=% avg_BE=% edge_pp=%',
    r.tier, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  -- ===================================================================
  -- §E — How many TB picks fall in each era? Sanity on volume.
  -- ===================================================================
  RAISE NOTICE '======== D-542 §E: TB volume by era ========';

  FOR r IN
    SELECT
      CASE
        WHEN game_date < '2026-06-13' THEN 'pre-D520'
        WHEN game_date < '2026-06-16' THEN 'post-D520 pre-D538'
        ELSE 'post-D538'
      END AS era,
      count(*) AS n_all,
      count(*) FILTER (WHERE confidence >= 70) AS n_c70,
      count(*) FILTER (WHERE confidence >= 80) AS n_c80,
      min(game_date) AS first_date, max(game_date) AS last_date
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
    GROUP BY 1 ORDER BY min(game_date)
  LOOP RAISE NOTICE '[D-542 §E.1] %: n_all=% n_c70=% n_c80=% (first=%, last=%)',
    r.era, r.n_all, r.n_c70, r.n_c80, r.first_date, r.last_date; END LOOP;

  -- ===================================================================
  -- §F — Did D-540 source the "-5.3pp" from somewhere I can verify?
  -- D-540 reason field says: "D-536/538: -5.3pp edge after gate".
  -- D-538 was deployed 2026-06-16. D-540 was 2026-06-17 (yesterday).
  -- So D-540's measurement post-D-538 was on AT MOST 1 day of data.
  -- That figure is likely from a D-538 backtest, not a D-540 live measure.
  -- Let me check the D-538 backtest by replicating: pre-D-538 corpus,
  -- AGREE-only (the gate's selection), conf>=70 OR full conf.
  -- ===================================================================
  RAISE NOTICE '======== D-542 §F: candidate source of D-540 "-5.3pp" claim ========';

  -- Full conf (no tier filter), AGREE-gated, edge_pp via odds
  FOR r IN
    SELECT
      'ALL conf + AGREE gate (pre-D538)' AS scenario,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND game_date < '2026-06-16'
      AND breakdown ? 'projected_stat'
      AND ((breakdown->>'projected_stat')::numeric > line AND pick_side='over'
        OR (breakdown->>'projected_stat')::numeric < line AND pick_side='under')
  LOOP RAISE NOTICE '[D-542 §F.1] %: n=% win=% avg_BE=% edge_pp=%',
    r.scenario, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;

  -- ALL conf, NO gate (pre-D-538)
  FOR r IN
    SELECT
      'ALL conf + NO gate (pre-D538)' AS scenario,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND mlb_market_type='batter_total_bases' AND hit IS NOT NULL
      AND game_date < '2026-06-16'
  LOOP RAISE NOTICE '[D-542 §F.2] %: n=% win=% avg_BE=% edge_pp=%',
    r.scenario, r.n, r.win_pct, r.avg_BE, r.edge_pp; END LOOP;
END $$;
