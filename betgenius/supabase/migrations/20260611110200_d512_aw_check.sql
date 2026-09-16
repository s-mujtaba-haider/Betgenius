DO $$
DECLARE r RECORD;
BEGIN
  -- Most recent algorithm_weights rows by updated_at
  RAISE NOTICE '[D-512 §d] algorithm_weights — rows by updated_at:';
  FOR r IN
    SELECT id, updated_at, backtest_win_pct, backtest_roi, backtest_picks
    FROM public.algorithm_weights
    ORDER BY updated_at DESC LIMIT 8
  LOOP RAISE NOTICE '  id=% updated=% backtest_wr=% roi=% picks=%',
    r.id, r.updated_at, r.backtest_win_pct, r.backtest_roi, r.backtest_picks; END LOOP;

  -- D-499 — 7 specific weights from the SHIP 2+3 batch
  -- Looking at the migrations table for the d499apply migration text
  RAISE NOTICE '[D-512 §e] D-499 weights (7 weights expected per spec):';
  FOR r IN
    SELECT
      w_l5, w_l10, w_minutes_trend, w_recent_form,
      w_floor_ceiling, w_home_away, w_z_score,
      backtest_win_pct, backtest_picks, updated_at
    FROM public.algorithm_weights
    ORDER BY updated_at DESC LIMIT 3
  LOOP RAISE NOTICE
    '  w_l5=% w_l10=% w_minutes_trend=% w_recent_form=% w_floor_ceiling=% w_home_away=% w_z_score=% bt_wr=% picks=% upd=%',
    r.w_l5, r.w_l10, r.w_minutes_trend, r.w_recent_form,
    r.w_floor_ceiling, r.w_home_away, r.w_z_score,
    r.backtest_win_pct, r.backtest_picks, r.updated_at; END LOOP;

  -- D-499/510 recent picks: cluster proof from yesterday (D-509/510 effect)
  RAISE NOTICE '[D-512 §f] yesterday cluster picks (D-509/D-510 effect — should NOT show OVER+150 conf>=80 except HR):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n, max(confidence) AS max_c
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      AND pick_side='over' AND confidence >= 80 AND odds >= 150
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% max_c=%', r.mlb_market_type, r.n, r.max_c; END LOOP;
END $$;
