-- D-511 SHIP 3 — spot check 5 captures: compare against props_cache, hand-verify CLV.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-511 spot] 5 random successful captures from yesterday — show all CLV inputs:';
  FOR r IN
    SELECT ph.id, ph.player_name, ph.mlb_market_type, ph.prop_type,
           ph.line AS pick_line, ph.pick_side, ph.odds AS pick_odds,
           ph.closing_line, ph.closing_odds, ph.clv_pct, ph.closing_capture_reason,
           public._d511_implied_prob(ph.odds) AS pick_implied,
           public._d511_implied_prob(ph.closing_odds) AS close_implied,
           ROUND((public._d511_implied_prob(ph.closing_odds)
                  - public._d511_implied_prob(ph.odds)) * 100, 2) AS handcalc_clv
    FROM public.pick_history ph
    WHERE ph.sport='mlb' AND ph.is_synthetic=false
      AND ph.game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      AND ph.closing_capture_reason = 'success'
    ORDER BY random() LIMIT 5
  LOOP
    RAISE NOTICE '----- pick %', r.id;
    RAISE NOTICE '  player=% market=% line=% side=% pick_odds=%',
      r.player_name, r.mlb_market_type, r.pick_line, r.pick_side, r.pick_odds;
    RAISE NOTICE '  closing_line=% closing_odds=% reason=%',
      r.closing_line, r.closing_odds, r.closing_capture_reason;
    RAISE NOTICE '  pick_implied=% close_implied=% stored_clv=% handcalc_clv=% match=%',
      ROUND(r.pick_implied, 4), ROUND(r.close_implied, 4),
      r.clv_pct, r.handcalc_clv,
      CASE WHEN r.clv_pct = r.handcalc_clv THEN '✓' ELSE '✗' END;
  END LOOP;

  -- Aggregate stats
  DECLARE r2 RECORD;
  BEGIN
    RAISE NOTICE '[D-511 spot] aggregate CLV stats on yesterday:';
    FOR r2 IN
      SELECT closing_capture_reason,
             count(*) AS n,
             ROUND(avg(clv_pct), 2) AS avg_clv,
             ROUND(min(clv_pct), 2) AS min_clv,
             ROUND(max(clv_pct), 2) AS max_clv,
             count(*) FILTER (WHERE clv_pct > 0) AS positive_n,
             ROUND(100.0 * count(*) FILTER (WHERE clv_pct > 0) / NULLIF(count(*), 0), 2) AS positive_pct
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
        AND closing_capture_reason IS NOT NULL
      GROUP BY closing_capture_reason ORDER BY n DESC
    LOOP RAISE NOTICE '  reason=% n=% avg_clv=% min=% max=% positive_n=% positive_pct=%',
      r2.closing_capture_reason, r2.n, r2.avg_clv, r2.min_clv, r2.max_clv,
      r2.positive_n, r2.positive_pct; END LOOP;
  END;

  -- Cluster check: do picks with positive CLV win more?
  DECLARE r3 RECORD;
  BEGIN
    RAISE NOTICE '[D-511 spot] CLV ↔ outcome cross-tab (yesterday):';
    FOR r3 IN
      SELECT CASE WHEN clv_pct > 0 THEN 'beat_close'
                  WHEN clv_pct = 0 THEN 'matched'
                  WHEN clv_pct < 0 THEN 'lost_to_close'
                  ELSE 'no_clv' END AS clv_band,
             count(*) AS n,
             count(*) FILTER (WHERE hit) AS wins,
             ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*) FILTER (WHERE hit IS NOT NULL), 0), 2) AS wr
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
        AND hit IS NOT NULL
      GROUP BY clv_band ORDER BY clv_band
    LOOP RAISE NOTICE '  band=% n=% wins=% wr=%',
      r3.clv_band, r3.n, r3.wins, r3.wr; END LOOP;
  END;
END $$;
