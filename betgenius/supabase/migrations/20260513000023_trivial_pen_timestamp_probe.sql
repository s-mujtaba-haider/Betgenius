-- Read-only timestamp probe for D-127 §1.12 failure diagnostic.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== 9 trivial-line rows from last 18h with full timestamps (UTC) ===';
  RAISE NOTICE 'created_utc | player | prop side @line | odds | conf | pen | cap';
  FOR r IN
    SELECT LEFT(player_name, 22) AS player,
      prop_type, pick_side, line, odds, confidence,
      score_trivial_line_penalty AS pen,
      score_trivial_line_cap AS cap,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created_utc
    FROM pick_history
    WHERE created_at > NOW() - INTERVAL '18 hours'
      AND line <= 0.5 AND ABS(odds) >= 200
    ORDER BY created_at ASC
  LOOP
    RAISE NOTICE '% | % | %/%@% | % | % | % | %',
      r.created_utc, RPAD(r.player, 22),
      RPAD(r.prop_type, 8), RPAD(r.pick_side, 6), r.line,
      r.odds, r.confidence, r.pen, COALESCE(r.cap::TEXT, 'NULL');
  END LOOP;
END $$;
