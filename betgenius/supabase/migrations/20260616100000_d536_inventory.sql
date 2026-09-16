-- D-536 SHIP 1 — corpus inventory: what data exists to test the
-- projection / edge / CLV claims?
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-536 §A: pick_history columns vs CLV/projection ========';
  FOR r IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND (column_name ILIKE '%project%' OR column_name ILIKE '%actual%'
           OR column_name ILIKE '%closing%' OR column_name ILIKE '%clv%'
           OR column_name ILIKE '%vig%' OR column_name ILIKE '%edge%'
           OR column_name ILIKE '%implied%' OR column_name ILIKE '%hit%'
           OR column_name IN ('odds','line','confidence'))
    ORDER BY column_name
  LOOP RAISE NOTICE '[D-536 §A.1] col=% type=%', r.column_name, r.data_type; END LOOP;

  RAISE NOTICE '======== D-536 §B: breakdown JSONB key coverage (organic resolved) ========';
  FOR r IN
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE breakdown ? 'projected_stat') AS k_proj,
      count(*) FILTER (WHERE breakdown ? 'raw_edge') AS k_edge,
      count(*) FILTER (WHERE breakdown ? 'market_stat') AS k_mkt,
      count(*) FILTER (WHERE breakdown ? 'season_avg_per_game') AS k_season,
      count(*) FILTER (WHERE breakdown ? 'last10_avg') AS k_l10
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '[D-536 §B.1] total=% k_proj=% k_edge=% k_mkt=% k_season=% k_l10=%',
    r.total, r.k_proj, r.k_edge, r.k_mkt, r.k_season, r.k_l10; END LOOP;

  RAISE NOTICE '======== D-536 §C: CLV — closing_captured_at coverage ========';
  FOR r IN
    SELECT
      count(*) AS resolved_organic,
      count(*) FILTER (WHERE closing_captured_at IS NOT NULL) AS clv_captured,
      ROUND(100.0 * count(*) FILTER (WHERE closing_captured_at IS NOT NULL)
            / NULLIF(count(*),0), 1) AS pct_with_clv
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL
  LOOP RAISE NOTICE '[D-536 §C.1] resolved=% clv_captured=% pct_with_clv=%',
    r.resolved_organic, r.clv_captured, r.pct_with_clv; END LOOP;

  -- Look at the actual closing-related columns
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pick_history'
      AND column_name ILIKE '%closing%'
    ORDER BY column_name
  LOOP RAISE NOTICE '[D-536 §C.2] closing col: %', r.column_name; END LOOP;

  RAISE NOTICE '======== D-536 §D: sample of a real pick with all fields ========';
  FOR r IN
    SELECT id, mlb_market_type, line, pick_side, odds, confidence, hit, actual_value,
           breakdown->>'projected_stat' AS proj,
           breakdown->>'raw_edge' AS raw_edge,
           breakdown->>'market_stat' AS market_stat
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND breakdown IS NOT NULL
      AND breakdown ? 'projected_stat'
      AND mlb_market_type = 'batter_total_bases'
    ORDER BY random() LIMIT 1
  LOOP RAISE NOTICE '[D-536 §D.1] id=% market=% line=% side=% odds=% conf=% hit=% actual=% projected=% raw_edge=% market_stat=%',
    r.id, r.mlb_market_type, r.line, r.pick_side, r.odds, r.confidence, r.hit,
    r.actual_value, r.proj, r.raw_edge, r.market_stat; END LOOP;
END $$;
