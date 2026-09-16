-- Prep: confirm real_money_bets view columns + pick_history natural-key
-- columns + bets table shape before designing calibration_input view.
-- Read-only NOTICE.
DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE '=== real_money_bets columns ===';
  FOR v_row IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'real_money_bets'
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  % %', v_row.column_name, v_row.data_type;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== pick_history relevant columns ===';
  FOR v_row IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pick_history'
      AND column_name IN ('id','player_name','prop_type','line','pick_side',
                          'game_date','confidence','hit','voided','resolved_at',
                          'is_synthetic','score_player_injury','score_l5',
                          'score_season','score_recent_form','sport')
    ORDER BY ordinal_position
  LOOP
    RAISE NOTICE '  % %', v_row.column_name, v_row.data_type;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== current bets in last 7 days (per source) ===';
  FOR v_row IN
    SELECT status, COUNT(*) AS n
    FROM bets
    WHERE placed_at >= NOW() - INTERVAL '14 days'
    GROUP BY status
    ORDER BY n DESC
  LOOP
    RAISE NOTICE '  status=%  n=%', v_row.status, v_row.n;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== real_money_bets match rate last 14 days ===';
  FOR v_row IN
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE is_matched) AS matched,
      COUNT(*) FILTER (WHERE NOT is_matched) AS unmatched
    FROM real_money_bets
    WHERE placed_at >= NOW() - INTERVAL '14 days'
  LOOP
    RAISE NOTICE '  total=% matched=% unmatched=%',
      v_row.total, v_row.matched, v_row.unmatched;
  END LOOP;
END $$;
