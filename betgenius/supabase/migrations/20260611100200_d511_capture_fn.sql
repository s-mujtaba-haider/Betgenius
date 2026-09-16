-- D-511 SHIP 2 — closing-odds capture as a SQL function + pg_cron entry.
--
-- For each pending pick (closing_captured_at IS NULL, game_time within last
-- 25 min), find the matching props_cache row (Hard Rock preferred, any book
-- as fallback) and stamp closing_odds / closing_line / clv_pct / reason.
--
-- Quota cost: ZERO (reads from props_cache populated by fetch-odds-mlb-30min).
-- Runtime budget: target <30s per call (200 picks limit).
--
-- CLV formula:
--   implied(odds) = odds >= 100 ? 100/(odds+100) : -odds/(-odds+100)
--   clv_pct = (implied(closing_odds) - implied(pick_odds)) * 100
--   Positive = beat the close.

CREATE OR REPLACE FUNCTION public._d511_implied_prob(p_odds INTEGER)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_odds IS NULL THEN RETURN NULL; END IF;
  IF p_odds >= 100 THEN
    RETURN 100.0 / (p_odds + 100.0);
  ELSIF p_odds <= -100 THEN
    RETURN (-p_odds) * 1.0 / ((-p_odds) + 100.0);
  ELSE
    -- odds in (-100, 100) excluding 100 — rare/invalid for American odds;
    -- treat -99..99 as same-as-100 floor to avoid div errors
    RETURN 0.5;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.capture_closing_odds_mlb(p_limit INT DEFAULT 200)
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
      AND game_time::timestamptz BETWEEN NOW() - INTERVAL '25 minutes' AND NOW()
    ORDER BY game_time
    LIMIT p_limit
  LOOP
    v_total_seen := v_total_seen + 1;
    v_close := NULL;
    v_reason := NULL;
    v_clv := NULL;
    v_game_date_text := to_char(v_pick.game_date, 'YYYYMMDD');

    -- Branch by market type. Player markets have unique player_name;
    -- game markets must match by (home_team, away_team) pair.
    v_is_player_market := v_pick.prop_type IN (
      'hits','home_runs','rbis','runs_scored','total_bases',
      'pitcher_strikeouts','pitcher_outs'
    );

    IF v_is_player_market THEN
      -- 1) Try Hard Rock at exact line
      SELECT odds, line, bookmaker, last_seen INTO v_close
      FROM public.props_cache
      WHERE sport='mlb' AND game_date = v_game_date_text
        AND player_name = v_pick.player_name
        AND prop_type   = v_pick.prop_type
        AND pick_side   = v_pick.pick_side
        AND line        = v_pick.line
        AND bookmaker   = 'hardrockbet'
      ORDER BY last_seen DESC LIMIT 1;

      -- 2) Fall back to any book at same line
      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker, last_seen INTO v_close
        FROM public.props_cache
        WHERE sport='mlb' AND game_date = v_game_date_text
          AND player_name = v_pick.player_name
          AND prop_type   = v_pick.prop_type
          AND pick_side   = v_pick.pick_side
          AND line        = v_pick.line
        ORDER BY last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'book_absent_hr';
          v_book_absent_hr := v_book_absent_hr + 1;
        END IF;
      END IF;

      -- 3) Line moved check: same player+side but different line
      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker, last_seen INTO v_close
        FROM public.props_cache
        WHERE sport='mlb' AND game_date = v_game_date_text
          AND player_name = v_pick.player_name
          AND prop_type   = v_pick.prop_type
          AND pick_side   = v_pick.pick_side
        ORDER BY (bookmaker = 'hardrockbet') DESC, last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'line_moved';
          v_line_moved := v_line_moved + 1;
        END IF;
      END IF;

    ELSE
      -- Game market: prop_type ∈ (h2h, spreads, totals).
      -- Match by (home_team, away_team) in either direction.
      SELECT odds, line, bookmaker, last_seen INTO v_close
      FROM public.props_cache
      WHERE sport='mlb' AND game_date = v_game_date_text
        AND prop_type   = v_pick.prop_type
        AND pick_side   = v_pick.pick_side
        AND line        = v_pick.line
        AND (
          (home_team = v_pick.team AND away_team = v_pick.opponent) OR
          (home_team = v_pick.opponent AND away_team = v_pick.team)
        )
        AND bookmaker   = 'hardrockbet'
      ORDER BY last_seen DESC LIMIT 1;

      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker, last_seen INTO v_close
        FROM public.props_cache
        WHERE sport='mlb' AND game_date = v_game_date_text
          AND prop_type   = v_pick.prop_type
          AND pick_side   = v_pick.pick_side
          AND line        = v_pick.line
          AND (
            (home_team = v_pick.team AND away_team = v_pick.opponent) OR
            (home_team = v_pick.opponent AND away_team = v_pick.team)
          )
        ORDER BY last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'book_absent_hr';
          v_book_absent_hr := v_book_absent_hr + 1;
        END IF;
      END IF;

      IF v_close IS NULL THEN
        SELECT odds, line, bookmaker, last_seen INTO v_close
        FROM public.props_cache
        WHERE sport='mlb' AND game_date = v_game_date_text
          AND prop_type   = v_pick.prop_type
          AND pick_side   = v_pick.pick_side
          AND (
            (home_team = v_pick.team AND away_team = v_pick.opponent) OR
            (home_team = v_pick.opponent AND away_team = v_pick.team)
          )
        ORDER BY (bookmaker='hardrockbet') DESC, last_seen DESC LIMIT 1;
        IF v_close.bookmaker IS NOT NULL THEN
          v_reason := 'line_moved';
          v_line_moved := v_line_moved + 1;
        END IF;
      END IF;
    END IF;

    -- Decide reason + write
    IF v_close.bookmaker IS NULL THEN
      v_reason := 'market_absent';
      v_market_absent := v_market_absent + 1;
      UPDATE public.pick_history
        SET closing_captured_at = NOW(),
            closing_capture_reason = v_reason
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
        SET closing_odds = v_close.odds,
            closing_line = v_close.line,
            clv_pct = v_clv,
            closing_captured_at = NOW(),
            closing_capture_reason = v_reason
        WHERE id = v_pick.id;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'total_seen', v_total_seen,
    'success', v_success,
    'line_moved', v_line_moved,
    'book_absent_hr', v_book_absent_hr,
    'market_absent', v_market_absent
  );
END $$;

-- Quick smoke verify the functions compile.
DO $$ DECLARE v_result NUMERIC; BEGIN
  v_result := public._d511_implied_prob(150);
  RAISE NOTICE '[D-511] implied(+150)=% (expect 0.40)', ROUND(v_result, 3);
  v_result := public._d511_implied_prob(-110);
  RAISE NOTICE '[D-511] implied(-110)=% (expect 0.524)', ROUND(v_result, 3);
  v_result := public._d511_implied_prob(100);
  RAISE NOTICE '[D-511] implied(+100)=% (expect 0.500)', ROUND(v_result, 3);
END $$;
