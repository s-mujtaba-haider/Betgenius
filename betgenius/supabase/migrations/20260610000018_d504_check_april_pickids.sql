-- D-504 pre-check — do the April-stuck-bets' pick_ids point at resolved
-- pick_history rows? If yes, the pick_id-direct branch will settle them
-- automatically. READ-ONLY.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-504 PRE] April stuck bets pick_id -> pick_history.hit lookup:';
  FOR r IN
    SELECT b.id AS bet_id, b.player_name, b.placed_at,
           ph.id AS pick_id, ph.hit, ph.actual_value, ph.resolved_at, ph.player_name AS ph_name
    FROM public.bets b
    LEFT JOIN public.pick_history ph ON ph.id = b.pick_id
    WHERE b.status='pending'
      AND b.placed_at < NOW() - INTERVAL '3 days'
      AND b.pick_id IS NOT NULL
    ORDER BY b.placed_at
  LOOP
    RAISE NOTICE 'bet=% bet_player=% placed=% pick_hit=% pick_actual=% pick_resolved=% pick_player=%',
      r.bet_id, r.player_name, r.placed_at,
      COALESCE(r.hit::text, '<null>'),
      COALESCE(r.actual_value::text, '<null>'),
      COALESCE(r.resolved_at::text, '<null>'),
      COALESCE(r.ph_name, '<null>');
  END LOOP;
END $$;
