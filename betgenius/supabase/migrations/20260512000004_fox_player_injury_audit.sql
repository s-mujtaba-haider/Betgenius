DO $$
DECLARE r RECORD;
BEGIN
  -- TASK 1: Fox May 12 picks
  RAISE NOTICE '=== TASK 1: Fox picks on 2026-05-12 ===';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('prop_type', 12), RPAD('pick_side', 6), LPAD('line', 6),
    LPAD('confidence', 10), LPAD('inj_score', 9), RPAD('source', 18);
  FOR r IN
    SELECT player_name, prop_type, pick_side, line, confidence,
      score_player_injury, source, sport, is_synthetic
    FROM pick_history
    WHERE player_name ILIKE '%fox%'
      AND game_date = '2026-05-12'::DATE
      AND prop_type NOT IN ('spread','game_total')
    ORDER BY prop_type, pick_side
  LOOP
    RAISE NOTICE '% % | % | % | % | % | %',
      RPAD(LEFT(r.player_name, 16), 16),
      RPAD(r.prop_type, 12), RPAD(r.pick_side, 6),
      LPAD(r.line::TEXT, 6), LPAD(r.confidence::TEXT, 10),
      LPAD(r.score_player_injury::TEXT, 9),
      RPAD(LEFT(r.source, 18), 18);
  END LOOP;
END $$;
