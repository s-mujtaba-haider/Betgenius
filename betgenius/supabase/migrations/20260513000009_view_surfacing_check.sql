DO $$
DECLARE matched_count INT; algo_ratio NUMERIC;
BEGIN
  RAISE NOTICE '=== real_money_bets surfacing the 11 newly-linked bets (via matched_pick_id) ===';
  SELECT COUNT(*) INTO matched_count
  FROM real_money_bets
  WHERE matched_pick_id IN (
    '40f29551-5448-4513-935b-a68b4267f6c6','993409e8-8dd8-471d-8438-6dac2038f96a',
    'ce36d30a-3a81-4e30-9e4f-f079ac788894','af06085a-64c1-4fcd-a1f6-0f0317e7d54c',
    'a5dff258-15d1-45e4-9481-76313b2b62ef','03c4bd97-8c1a-41d7-b13c-b3743adcaed0',
    '2fa8d4ae-cd23-44cd-9638-1b3454c649a4','091607d3-020d-4202-b7e6-c1fd109abe25',
    '6b2eb184-a1ab-40f1-ad94-b7a42249821c','198cf98d-34bb-4c7e-ae0c-18a31c638d76',
    '186bae07-00e9-4322-bc24-41b04a81ac3a'
  );
  RAISE NOTICE 'real_money_bets surfaces % of 11 newly-linked bets', matched_count;

  RAISE NOTICE '';
  RAISE NOTICE '=== is_matched true rate before vs after ===';
  SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_matched) / NULLIF(COUNT(*), 0), 1)
    INTO algo_ratio FROM real_money_bets;
  RAISE NOTICE 'real_money_bets.is_matched true rate now: %', algo_ratio;
END $$;
