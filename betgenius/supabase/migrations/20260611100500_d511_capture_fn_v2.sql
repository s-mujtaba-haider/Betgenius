-- D-511 SHIP 3 — extend capture function with configurable lookback window
-- to enable verification on yesterday's slate before tonight's games start.
-- p_lookback_minutes defaults to 25 (= original window); test uses larger.
CREATE OR REPLACE FUNCTION public.capture_closing_odds_mlb(
  p_limit INT DEFAULT 200,
  p_lookback_minutes INT DEFAULT 25
)
RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE
  v_pick RECORD;
  v_close RECORD;
  v_pick_implied NUMERIC;
  v_close_implied NUMERIC;
  v_clv NUMERIC;
  v_reason TEXT;
  v_success INT := 0;
  v_line_moved INT := 0;
  v_market_absent INT := 0;
  v_book_absent_hr INT := 0;
  v_total_seen INT := 0;
  v_is_player_market BOOLEAN;
  v_game_date_text TEXT;
BEGIN
  FOR v_pick IN
    SELECT id, player_name, team, opponent, prop_type, mlb_market_type,
           line, pick_side, odds, game_time, game_date
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND closing_captured_at IS NULL
      AND game_time::timestamptz BETWEEN
          NOW() - (p_lookback_minutes || ' minutes')::INTERVAL AND NOW()
    ORDER BY game_time
    LIMIT p_limit
  LOOP
    v_total_seen := v_total_seen + 1;
    v_close := NULL;
    v_reason := NULL;
    v_clv := NULL;
    v_game_date_text := to_char(v_pick.game_date, 'YYYYMMDD');

    v_is_player_market := v_pick.prop_type IN (
      'hits','home_runs','rbis','runs_scored','total_bases',
      'pitcher_strikeouts','pitcher_outs'
    );

    IF v_is_player_market THEN
      SELECT odds, line, bookmaker INTO v_close FROM public.props_cache
       WHERE sport='mlb' AND game_date = v_game_date_text
         AND player_name = v_pick.player_name AND prop_type = v_pick.prop_type
         AND pick_side = v_pick.pick_side AND line = v_pick.line
         AND bookmaker = 'hardrockbet'
       ORDER BY last_seen DESC LIMIT 1;

      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker INTO v_close FROM public.props_cache
         WHERE sport='mlb' AND game_date = v_game_date_text
           AND player_name = v_pick.player_name AND prop_type = v_pick.prop_type
           AND pick_side = v_pick.pick_side AND line = v_pick.line
         ORDER BY last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'book_absent_hr';
          v_book_absent_hr := v_book_absent_hr + 1;
        END IF;
      END IF;

      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker INTO v_close FROM public.props_cache
         WHERE sport='mlb' AND game_date = v_game_date_text
           AND player_name = v_pick.player_name AND prop_type = v_pick.prop_type
           AND pick_side = v_pick.pick_side
         ORDER BY (bookmaker='hardrockbet') DESC, last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'line_moved';
          v_line_moved := v_line_moved + 1;
        END IF;
      END IF;
    ELSE
      SELECT odds, line, bookmaker INTO v_close FROM public.props_cache
       WHERE sport='mlb' AND game_date = v_game_date_text
         AND prop_type = v_pick.prop_type AND pick_side = v_pick.pick_side
         AND line = v_pick.line
         AND ((home_team=v_pick.team AND away_team=v_pick.opponent)
              OR (home_team=v_pick.opponent AND away_team=v_pick.team))
         AND bookmaker = 'hardrockbet'
       ORDER BY last_seen DESC LIMIT 1;

      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker INTO v_close FROM public.props_cache
         WHERE sport='mlb' AND game_date = v_game_date_text
           AND prop_type = v_pick.prop_type AND pick_side = v_pick.pick_side
           AND line = v_pick.line
           AND ((home_team=v_pick.team AND away_team=v_pick.opponent)
                OR (home_team=v_pick.opponent AND away_team=v_pick.team))
         ORDER BY last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'book_absent_hr';
          v_book_absent_hr := v_book_absent_hr + 1;
        END IF;
      END IF;

      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker INTO v_close FROM public.props_cache
         WHERE sport='mlb' AND game_date = v_game_date_text
           AND prop_type = v_pick.prop_type AND pick_side = v_pick.pick_side
           AND ((home_team=v_pick.team AND away_team=v_pick.opponent)
                OR (home_team=v_pick.opponent AND away_team=v_pick.team))
         ORDER BY (bookmaker='hardrockbet') DESC, last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'line_moved';
          v_line_moved := v_line_moved + 1;
        END IF;
      END IF;
    END IF;

    IF v_close.bookmaker IS NULL THEN
      v_reason := 'market_absent';
      v_market_absent := v_market_absent + 1;
      UPDATE public.pick_history
        SET closing_captured_at = NOW(), closing_capture_reason = v_reason
        WHERE id = v_pick.id;
    ELSIF v_reason = 'line_moved' THEN
      UPDATE public.pick_history
        SET closing_line = v_close.line,
            closing_captured_at = NOW(),
            closing_capture_reason = v_reason
        WHERE id = v_pick.id;
    ELSE
      v_pick_implied := public._d511_implied_prob(v_pick.odds);
      v_close_implied := public._d511_implied_prob(v_close.odds);
      v_clv := ROUND((v_close_implied - v_pick_implied) * 100, 2);
      IF v_reason IS NULL THEN
        v_reason := 'success';
        v_success := v_success + 1;
      END IF;
      UPDATE public.pick_history
        SET closing_odds = v_close.odds, closing_line = v_close.line,
            clv_pct = v_clv, closing_captured_at = NOW(),
            closing_capture_reason = v_reason
        WHERE id = v_pick.id;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'total_seen', v_total_seen, 'success', v_success,
    'line_moved', v_line_moved, 'book_absent_hr', v_book_absent_hr,
    'market_absent', v_market_absent
  );
END $$;
