DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== 8 negative-score-injury UNDER picks (post-May-4 organic) ===';
  RAISE NOTICE 'These shouldn''t exist if side-flip is working — base penalty';
  RAISE NOTICE 'in getPlayerInjuryStatus is always <= 0, UNDER flips to >= 0.';
  RAISE NOTICE '';
  RAISE NOTICE '% | % | % | % | % | %',
    RPAD('player', 22), RPAD('prop', 12), LPAD('line', 6),
    LPAD('inj', 5), RPAD('game_date', 12), RPAD('created_at', 26);
  FOR r IN
    SELECT player_name, prop_type, line, score_player_injury,
      game_date, created_at::TEXT AS created_iso
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND created_at >= '2026-05-04'::timestamptz
      AND pick_side = 'under'
      AND score_player_injury < 0
      AND prop_type NOT IN ('spread','game_total')
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '% | % | % | % | % | %',
      RPAD(LEFT(r.player_name, 22), 22),
      RPAD(r.prop_type, 12), LPAD(r.line::TEXT, 6),
      LPAD(r.score_player_injury::TEXT, 5),
      RPAD(r.game_date::TEXT, 12),
      RPAD(LEFT(r.created_iso, 26), 26);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== same probe for the 13 negative OVERs (expected, sanity check) ===';
  RAISE NOTICE '% | % | % | % | %',
    RPAD('player', 22), RPAD('prop', 12), LPAD('inj', 5),
    RPAD('game_date', 12), RPAD('created_at', 26);
  FOR r IN
    SELECT player_name, prop_type, score_player_injury,
      game_date, created_at::TEXT AS created_iso
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND created_at >= '2026-05-04'::timestamptz
      AND pick_side = 'over'
      AND score_player_injury != 0
      AND prop_type NOT IN ('spread','game_total')
    ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      RPAD(LEFT(r.player_name, 22), 22),
      RPAD(r.prop_type, 12),
      LPAD(r.score_player_injury::TEXT, 5),
      RPAD(r.game_date::TEXT, 12),
      RPAD(LEFT(r.created_iso, 26), 26);
  END LOOP;
END $$;
