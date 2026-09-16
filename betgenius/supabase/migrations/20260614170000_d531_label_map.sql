-- D-531 SHIP 1 — Label distribution: prop_type × is_synthetic × mlb_market_type
-- for MLB picks. Provides the ground-truth label map so the optimizer
-- code-read can be quantified.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §A — Full distribution
  RAISE NOTICE '[D-531 §A] MLB prop_type x is_synthetic x mlb_market_type (non-voided):';
  FOR r IN
    SELECT
      prop_type,
      is_synthetic,
      mlb_market_type,
      count(*) AS rows,
      count(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
      ROUND(100.0 * count(*) FILTER (WHERE hit IS NOT NULL) / NULLIF(count(*),0), 1) AS pct_resolved,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL),0), 1) AS wr_pct
    FROM public.pick_history
    WHERE sport='mlb' AND voided IS NOT TRUE
    GROUP BY prop_type, is_synthetic, mlb_market_type
    ORDER BY rows DESC
  LOOP RAISE NOTICE '  prop=% is_syn=% mlb_market=% rows=% resolved=% pct=% wr=%',
    r.prop_type, r.is_synthetic, COALESCE(r.mlb_market_type,'<null>'),
    r.rows, r.resolved, r.pct_resolved, r.wr_pct; END LOOP;

  -- §B — Map: for each prop_type, what's the dominant style (synthetic vs organic)?
  RAISE NOTICE '[D-531 §B] prop_type style summary:';
  FOR r IN
    SELECT
      prop_type,
      count(*) FILTER (WHERE is_synthetic = true) AS synth_rows,
      count(*) FILTER (WHERE is_synthetic = false) AS organic_rows,
      CASE
        WHEN count(*) FILTER (WHERE is_synthetic = true) > 0
         AND count(*) FILTER (WHERE is_synthetic = false) > 0 THEN 'BOTH'
        WHEN count(*) FILTER (WHERE is_synthetic = true) > 0 THEN 'SYNTHETIC_ONLY'
        ELSE 'ORGANIC_ONLY'
      END AS style
    FROM public.pick_history
    WHERE sport='mlb' AND voided IS NOT TRUE
    GROUP BY prop_type
    ORDER BY (count(*) FILTER (WHERE is_synthetic = true) + count(*) FILTER (WHERE is_synthetic = false)) DESC
  LOOP RAISE NOTICE '  prop=% synth=% organic=% style=%',
    r.prop_type, r.synth_rows, r.organic_rows, r.style; END LOOP;
END $$;
