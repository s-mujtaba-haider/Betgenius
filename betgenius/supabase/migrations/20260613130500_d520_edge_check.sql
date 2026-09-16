DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §H — edge check: WR vs BE for BEFORE/AFTER at sellable tier (conf>=80), per market
  RAISE NOTICE '[D-520 §H] WR vs BE per market (conf>=80) — edge in pp:';
  FOR r IN
    WITH t AS (
      SELECT confidence AS old_conf,
             public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf,
             mlb_market_type, hit, odds,
             (CASE WHEN odds > 0 THEN 100.0/(odds+100) ELSE (-odds)*1.0/((-odds)+100) END) AS implied
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    )
    SELECT mlb_market_type,
      -- BEFORE 80+ tier
      count(*) FILTER (WHERE old_conf >= 80) AS bef_n,
      ROUND(100.0 * count(*) FILTER (WHERE old_conf >= 80 AND hit)
            / NULLIF(count(*) FILTER (WHERE old_conf >= 80), 0), 2) AS bef_wr,
      ROUND(100.0 * avg(implied) FILTER (WHERE old_conf >= 80), 2) AS bef_be,
      ROUND(
        (100.0 * count(*) FILTER (WHERE old_conf >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE old_conf >= 80), 0))
        - (100.0 * avg(implied) FILTER (WHERE old_conf >= 80))
      , 2) AS bef_edge,
      -- AFTER 80+ tier
      count(*) FILTER (WHERE new_conf >= 80) AS aft_n,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 80 AND hit)
            / NULLIF(count(*) FILTER (WHERE new_conf >= 80), 0), 2) AS aft_wr,
      ROUND(100.0 * avg(implied) FILTER (WHERE new_conf >= 80), 2) AS aft_be,
      ROUND(
        (100.0 * count(*) FILTER (WHERE new_conf >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE new_conf >= 80), 0))
        - (100.0 * avg(implied) FILTER (WHERE new_conf >= 80))
      , 2) AS aft_edge
    FROM t GROUP BY mlb_market_type
  LOOP RAISE NOTICE '  market=% bef(n=% WR=% BE=% edge=%) aft(n=% WR=% BE=% edge=%)',
    r.mlb_market_type,
    r.bef_n, r.bef_wr, r.bef_be, r.bef_edge,
    r.aft_n, r.aft_wr, r.aft_be, r.aft_edge; END LOOP;

  -- §I — at 90+ tier
  RAISE NOTICE '[D-520 §I] edge at conf>=90 — per market:';
  FOR r IN
    WITH t AS (
      SELECT confidence AS old_conf,
             public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf,
             mlb_market_type, hit, odds,
             (CASE WHEN odds > 0 THEN 100.0/(odds+100) ELSE (-odds)*1.0/((-odds)+100) END) AS implied
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    )
    SELECT mlb_market_type,
      count(*) FILTER (WHERE old_conf >= 90) AS bef_n,
      ROUND(100.0 * count(*) FILTER (WHERE old_conf >= 90 AND hit) / NULLIF(count(*) FILTER (WHERE old_conf >= 90), 0), 2) AS bef_wr,
      ROUND(100.0 * avg(implied) FILTER (WHERE old_conf >= 90), 2) AS bef_be,
      ROUND(
        (100.0 * count(*) FILTER (WHERE old_conf >= 90 AND hit) / NULLIF(count(*) FILTER (WHERE old_conf >= 90), 0))
        - (100.0 * avg(implied) FILTER (WHERE old_conf >= 90))
      , 2) AS bef_edge,
      count(*) FILTER (WHERE new_conf >= 90) AS aft_n,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 90 AND hit) / NULLIF(count(*) FILTER (WHERE new_conf >= 90), 0), 2) AS aft_wr,
      ROUND(100.0 * avg(implied) FILTER (WHERE new_conf >= 90), 2) AS aft_be,
      ROUND(
        (100.0 * count(*) FILTER (WHERE new_conf >= 90 AND hit) / NULLIF(count(*) FILTER (WHERE new_conf >= 90), 0))
        - (100.0 * avg(implied) FILTER (WHERE new_conf >= 90))
      , 2) AS aft_edge
    FROM t GROUP BY mlb_market_type
  LOOP RAISE NOTICE '  market=% bef(n=% WR=% BE=% edge=%) aft(n=% WR=% BE=% edge=%)',
    r.mlb_market_type,
    r.bef_n, r.bef_wr, r.bef_be, r.bef_edge,
    r.aft_n, r.aft_wr, r.aft_be, r.aft_edge; END LOOP;
END $$;
