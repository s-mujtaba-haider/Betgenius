-- D-540 SHIP 1 — Scope the product to +EV markets.
--
-- Design:
--   1. product_market_config table — the SOURCE OF TRUTH for which
--      (sport, prop_type) tuples are sellable. CEO-editable; admin
--      operations are plain UPDATEs.
--   2. recommendations_cache_sellable VIEW — PostgREST-exposed read
--      of rec_cache filtered by is_sellable. Frontend swaps the
--      table name; query shape stays the same.
--
-- Hard rule (per D-540 spec): scoring is UNCHANGED. process-games-mlb
-- continues to score every market (data accumulates for future
-- rebuild attempts). Only the SURFACING (the dashboard view) filters.

-- =====================================================================
-- §A — product_market_config table
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.product_market_config (
  sport TEXT NOT NULL,
  prop_type TEXT NOT NULL,
  mlb_market_type TEXT,
  is_sellable BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sport, prop_type)
);

GRANT SELECT ON public.product_market_config TO authenticated, anon;

-- =====================================================================
-- §B — Seed: SELLABLE = 3 markets per D-540 spec.
--   game_side, batter_hits, pitcher_k (from D-538 OOS holdout edges)
--
-- All other MLB markets default is_sellable=false (scored for data
-- accumulation but hidden from product). NBA markets are intentionally
-- left UNREGISTERED so the view's left-join default-true behavior
-- continues to surface them — NBA scope-out is a separate decision.
-- =====================================================================
INSERT INTO public.product_market_config (sport, prop_type, mlb_market_type, is_sellable, reason) VALUES
  -- SELLABLE (+EV under D-538 hard-gate)
  ('mlb', 'hits',               'batter_hits',  true,
    'D-538: +8.4pp OOS edge at conf>=70 (n=159/day)'),
  ('mlb', 'pitcher_strikeouts', 'pitcher_k',    true,
    'D-538: +2.3pp OOS edge at conf>=70 (n=117/day)'),
  ('mlb', 'spreads',            'game_side',    true,
    'D-533: +4.2pp OOS edge at conf>=70 / +9.6pp at conf>=80 (game-side via spreads market)'),
  ('mlb', 'h2h',                'game_side',    true,
    'D-533: same as spreads — game-side picks via moneyline'),

  -- NON-SELLABLE (scored for data, hidden from product)
  ('mlb', 'home_runs',          'batter_hr',    false,
    'D-536: WR drops at conf>=80; D-538 gate insufficient; D-541 rebuild candidate'),
  ('mlb', 'total_bases',        'batter_total_bases', false,
    'D-536/538: -5.3pp edge after gate; D-541 rebuild candidate'),
  ('mlb', 'rbis',               'batter_rbis',  false,
    'D-539: data-limited; max OOS r=0.117 not predictive; scope-out until D-540 data pipeline extension'),
  ('mlb', 'totals',             'game_total',   false,
    'D-533: marginal -EV (-2.7pp); not validated +EV'),
  ('mlb', 'runs_scored',        'batter_runs_scored', false,
    'D-536: not validated +EV; small sample'),
  ('mlb', 'batter_strikeouts',  'batter_strikeouts', false,
    'D-536: n=2 insufficient; not validated'),
  ('mlb', 'pitcher_outs',       'pitcher_outs', false,
    'D-533: untunable (no breakdown JSONB); D-538 followup needed')
ON CONFLICT (sport, prop_type) DO UPDATE
  SET is_sellable = EXCLUDED.is_sellable,
      mlb_market_type = EXCLUDED.mlb_market_type,
      reason = EXCLUDED.reason,
      updated_at = now();

-- =====================================================================
-- §C — recommendations_cache_sellable VIEW
--
-- LEFT JOIN to product_market_config so that:
--   - (sport, prop_type) rows with is_sellable=true → surfaced
--   - rows with no config entry (e.g., NBA) → default TRUE → surfaced
--   - rows with is_sellable=false → HIDDEN
--
-- The default-true behavior on NULL is intentional: it keeps NBA
-- (un-configured today) working without scope changes.
-- =====================================================================
CREATE OR REPLACE VIEW public.recommendations_cache_sellable AS
SELECT rc.*
FROM public.recommendations_cache rc
LEFT JOIN public.product_market_config cfg
  ON cfg.sport = rc.sport AND cfg.prop_type = rc.prop_type
WHERE COALESCE(cfg.is_sellable, true) = true;

GRANT SELECT ON public.recommendations_cache_sellable TO authenticated, anon;

-- =====================================================================
-- §D — Smoke
-- =====================================================================
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-540 §A: sellable config row count ========';
  FOR r IN
    SELECT sport,
           count(*) AS total_rows,
           count(*) FILTER (WHERE is_sellable) AS sellable_count,
           count(*) FILTER (WHERE NOT is_sellable) AS hidden_count
    FROM public.product_market_config GROUP BY sport
  LOOP RAISE NOTICE '[D-540 §A.1] sport=% total=% sellable=% hidden=%',
    r.sport, r.total_rows, r.sellable_count, r.hidden_count; END LOOP;

  RAISE NOTICE '======== D-540 §B: sellable list (the active +EV set) ========';
  FOR r IN
    SELECT sport, prop_type, mlb_market_type, reason
    FROM public.product_market_config WHERE is_sellable ORDER BY sport, prop_type
  LOOP RAISE NOTICE '  [SELLABLE] sport=% prop_type=% (mlb_market=%) reason=%',
    r.sport, r.prop_type, r.mlb_market_type, r.reason; END LOOP;

  RAISE NOTICE '======== D-540 §C: scoped-out list (still scored, not surfaced) ========';
  FOR r IN
    SELECT sport, prop_type, mlb_market_type, reason
    FROM public.product_market_config WHERE NOT is_sellable ORDER BY sport, prop_type
  LOOP RAISE NOTICE '  [HIDDEN] sport=% prop_type=% (mlb_market=%) reason=%',
    r.sport, r.prop_type, r.mlb_market_type, r.reason; END LOOP;

  RAISE NOTICE '======== D-540 §D: VIEW filter check (rec_cache today) ========';
  FOR r IN
    SELECT
      'recommendations_cache (raw)' AS source,
      count(*) AS rows,
      count(DISTINCT prop_type) AS distinct_props
    FROM public.recommendations_cache
    WHERE sport='mlb' AND game_date >= current_date - interval '7 days'
  LOOP RAISE NOTICE '[D-540 §D.1] %: rows=% distinct_props=%',
    r.source, r.rows, r.distinct_props; END LOOP;

  FOR r IN
    SELECT
      'recommendations_cache_sellable (view)' AS source,
      count(*) AS rows,
      count(DISTINCT prop_type) AS distinct_props
    FROM public.recommendations_cache_sellable
    WHERE sport='mlb' AND game_date >= current_date - interval '7 days'
  LOOP RAISE NOTICE '[D-540 §D.2] %: rows=% distinct_props=%',
    r.source, r.rows, r.distinct_props; END LOOP;

  FOR r IN
    SELECT prop_type, count(*) AS rows
    FROM public.recommendations_cache_sellable
    WHERE sport='mlb' AND game_date >= current_date - interval '7 days'
    GROUP BY prop_type ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-540 §D.3] view shows prop_type=% rows=%', r.prop_type, r.rows; END LOOP;

  RAISE NOTICE '======== D-540 §E: pick_history unchanged (data still flows) ========';
  FOR r IN
    SELECT
      count(*) AS organic_picks_last_7d,
      count(DISTINCT mlb_market_type) AS distinct_mlb_markets
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND game_date >= current_date - interval '7 days'
  LOOP RAISE NOTICE '[D-540 §E.1] pick_history rows last 7d=% distinct_mlb_markets=% (all markets still scored)',
    r.organic_picks_last_7d, r.distinct_mlb_markets; END LOOP;
END $$;
