-- v2: bets uses `placed_at` not `created_at`. Read-only audit only.
DO $$
DECLARE r RECORD; orphan_count INT;
BEGIN
  RAISE NOTICE '=== TASK 1: orphan bets (pick_id IS NULL) ===';
  SELECT COUNT(*) INTO orphan_count FROM bets WHERE pick_id IS NULL;
  RAISE NOTICE 'orphan_count=%', orphan_count;
  RAISE NOTICE '';

  FOR r IN
    SELECT id, player_name, prop_type, line, pick_side, odds, stake, status, sport,
           placed_at::DATE AS bet_date, placed_at::TIME(0) AS bet_time
    FROM bets
    WHERE pick_id IS NULL
    ORDER BY placed_at DESC
  LOOP
    RAISE NOTICE 'bet_id=% | % | %/%@% | odds=% stake=% status=% sport=% placed=% %',
      r.id,
      RPAD(COALESCE(r.player_name, 'NULL'), 24),
      RPAD(r.prop_type, 13), RPAD(r.pick_side, 6), r.line,
      r.odds, r.stake, RPAD(r.status, 9), RPAD(COALESCE(r.sport, 'NULL'), 4),
      r.bet_date, r.bet_time;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== TASK 2: candidate pick_history matches ===';
  RAISE NOTICE '';
  FOR r IN
    WITH orphans AS (
      SELECT id AS bet_id, player_name, prop_type, line, pick_side,
             placed_at::DATE AS bet_date
      FROM bets WHERE pick_id IS NULL
    )
    SELECT
      o.bet_id, LEFT(o.player_name, 24) AS player,
      o.prop_type, o.pick_side, o.line, o.bet_date,
      p.id AS candidate_pick_id, p.game_date AS pick_game_date,
      p.confidence, p.source, p.is_synthetic, p.hit, p.voided
    FROM orphans o
    LEFT JOIN pick_history p
      ON LOWER(p.player_name) = LOWER(o.player_name)
      AND p.prop_type = o.prop_type
      AND p.line = o.line
      AND p.pick_side = o.pick_side
      AND p.game_date BETWEEN (o.bet_date - INTERVAL '1 day') AND (o.bet_date + INTERVAL '1 day')
    ORDER BY o.bet_id, p.game_date DESC NULLS LAST
  LOOP
    IF r.candidate_pick_id IS NULL THEN
      RAISE NOTICE 'bet_id=% player=% %/%@% bet=% — NO MATCH',
        r.bet_id, RPAD(r.player, 24),
        RPAD(r.prop_type, 13), RPAD(r.pick_side, 6), r.line, r.bet_date;
    ELSE
      RAISE NOTICE 'bet_id=% player=% %/%@% bet=% -> pick_id=% gd=% conf=% src=% syn=% hit=% void=%',
        r.bet_id, RPAD(r.player, 24),
        RPAD(r.prop_type, 13), RPAD(r.pick_side, 6), r.line, r.bet_date,
        r.candidate_pick_id, r.pick_game_date, r.confidence,
        RPAD(r.source, 14), r.is_synthetic,
        COALESCE(r.hit::TEXT, 'NULL'), COALESCE(r.voided::TEXT, 'NULL');
    END IF;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== TASK 2b: per-orphan match counts ===';
  FOR r IN
    WITH orphans AS (
      SELECT id AS bet_id, player_name, prop_type, line, pick_side,
             placed_at::DATE AS bet_date
      FROM bets WHERE pick_id IS NULL
    )
    SELECT o.bet_id, LEFT(o.player_name, 24) AS player,
      o.prop_type, o.pick_side, o.line, o.bet_date,
      COUNT(p.id) AS match_count,
      COUNT(DISTINCT p.is_synthetic) AS distinct_syn,
      COUNT(*) FILTER (WHERE p.is_synthetic = false) AS organic_matches,
      COUNT(*) FILTER (WHERE p.is_synthetic = true) AS synth_matches
    FROM orphans o
    LEFT JOIN pick_history p
      ON LOWER(p.player_name) = LOWER(o.player_name)
      AND p.prop_type = o.prop_type
      AND p.line = o.line
      AND p.pick_side = o.pick_side
      AND p.game_date BETWEEN (o.bet_date - INTERVAL '1 day') AND (o.bet_date + INTERVAL '1 day')
    GROUP BY 1, 2, 3, 4, 5, 6
    ORDER BY o.bet_id
  LOOP
    RAISE NOTICE 'bet_id=% player=% %/%@% bet=% — total=% organic=% synth=%',
      r.bet_id, RPAD(r.player, 24),
      RPAD(r.prop_type, 13), RPAD(r.pick_side, 6), r.line, r.bet_date,
      r.match_count, r.organic_matches, r.synth_matches;
  END LOOP;
END $$;
