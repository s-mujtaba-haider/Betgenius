DO $$ DECLARE r RECORD; v_today date := (now() AT TIME ZONE 'America/New_York')::date; BEGIN
  RAISE NOTICE 'D-626 sellable audit — cross-check pick_history vs product_market_config:';
  RAISE NOTICE '';
  RAISE NOTICE 'Per-market today (game_date=%):', v_today;
  FOR r IN
    WITH cfg AS (
      SELECT mlb_market_type, prop_type, is_sellable, LEFT(reason, 60) AS reason
        FROM public.product_market_config WHERE sport='mlb'
    ),
    picks AS (
      SELECT COALESCE(mlb_market_type,'(null)') AS market,
             count(*) AS scored,
             count(*) FILTER (WHERE recommendation_shown = true) AS shown
        FROM public.pick_history
       WHERE sport='mlb' AND game_date = v_today AND is_synthetic = false
       GROUP BY mlb_market_type
    )
    SELECT p.market, p.scored, p.shown, c.is_sellable, c.reason
      FROM picks p
      LEFT JOIN cfg c ON c.mlb_market_type = p.market
     ORDER BY p.scored DESC
  LOOP
    RAISE NOTICE '  market=% scored=% shown=% sellable=% (%) reason=%',
      r.market, r.scored, r.shown, COALESCE(r.is_sellable::text, '(no config)'),
      CASE
        WHEN r.is_sellable IS NULL THEN 'NO CONFIG ROW'
        WHEN r.is_sellable AND r.shown > 0 THEN 'OK — sellable + visible'
        WHEN r.is_sellable AND r.shown = 0 THEN '⚠ sellable but 0 shown'
        WHEN NOT r.is_sellable AND r.shown > 0 THEN 'note — scope-out, but recommendation_shown set in pick_history'
        WHEN NOT r.is_sellable AND r.shown = 0 THEN 'OK — scope-out + hidden'
        ELSE '?'
      END,
      r.reason;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'recommendations_cache_sellable view — what the dashboard actually shows today:';
  FOR r IN
    SELECT COALESCE(prop_type,'(null)') AS prop, count(*) AS n
      FROM public.recommendations_cache_sellable
     WHERE sport='mlb' AND game_date::text = v_today::text
     GROUP BY prop_type
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  prop=% count=%', r.prop, r.n;
  END LOOP;
END $$;
