-- D-540 cleanup — explicitly register the 'strikeouts' prop_type
-- (a 4-row variant of batter_strikeouts; see D-531 §A.4).
INSERT INTO public.product_market_config
  (sport, prop_type, mlb_market_type, is_sellable, reason)
VALUES
  ('mlb', 'strikeouts', 'batter_strikeouts', false,
    'D-540: variant of batter_strikeouts prop_type (4 organic rows); same scope-out as batter_strikeouts')
ON CONFLICT (sport, prop_type) DO UPDATE
  SET is_sellable = EXCLUDED.is_sellable, updated_at = now();

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT count(DISTINCT prop_type) AS distinct_props
    FROM public.recommendations_cache_sellable
    WHERE sport='mlb' AND game_date >= current_date - interval '7 days'
  LOOP RAISE NOTICE '[D-540 cleanup] view now shows % distinct prop_types (target=4)', r.distinct_props; END LOOP;
END $$;
