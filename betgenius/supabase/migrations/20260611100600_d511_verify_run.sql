-- D-511 SHIP 3 — run capture on yesterday's slate (lookback large to include past day).
DO $$
DECLARE v_result JSON; v_pending BIGINT;
BEGIN
  -- pending count before
  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE sport='mlb' AND is_synthetic=false
     AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
     AND closing_captured_at IS NULL;
  RAISE NOTICE '[D-511 verify] pending yesterday: %', v_pending;

  -- Run capture with lookback that includes yesterday (game_time within 36h)
  v_result := public.capture_closing_odds_mlb(500, 2160);  -- 36h lookback
  RAISE NOTICE '[D-511 verify] capture run #1: %', v_result;

  v_result := public.capture_closing_odds_mlb(500, 2160);
  RAISE NOTICE '[D-511 verify] capture run #2: %', v_result;

  v_result := public.capture_closing_odds_mlb(500, 2160);
  RAISE NOTICE '[D-511 verify] capture run #3: %', v_result;

  SELECT count(*) INTO v_pending FROM public.pick_history
   WHERE sport='mlb' AND is_synthetic=false
     AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
     AND closing_captured_at IS NULL;
  RAISE NOTICE '[D-511 verify] pending yesterday AFTER: %', v_pending;
END $$;
