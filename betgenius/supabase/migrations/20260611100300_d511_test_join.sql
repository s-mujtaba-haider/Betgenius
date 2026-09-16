-- D-511 SHIP 2 — sanity test the JOIN logic against today's picks BEFORE games start.
-- Simulates what the capture would do; does NOT write anything.
DO $$
DECLARE r RECORD; v_n INT; v_hr INT; v_any INT; v_line_match INT; v_absent INT;
BEGIN
  SELECT count(*) INTO v_n FROM public.pick_history
   WHERE sport='mlb' AND is_synthetic=false
     AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE;
  RAISE NOTICE '[D-511 join-test] total today picks: %', v_n;

  -- For each pick, count if a same-line Hard Rock match exists in props_cache
  WITH today_picks AS (
    SELECT id, player_name, team, opponent, prop_type, mlb_market_type,
           line, pick_side
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
  ),
  is_player AS (
    SELECT *, prop_type IN ('hits','home_runs','rbis','runs_scored','total_bases',
                            'pitcher_strikeouts','pitcher_outs') AS is_pl
    FROM today_picks
  ),
  matched AS (
    SELECT tp.id,
           EXISTS (
             SELECT 1 FROM public.props_cache pc
             WHERE pc.sport='mlb' AND pc.game_date='20260611'
               AND pc.prop_type = tp.prop_type AND pc.pick_side = tp.pick_side
               AND pc.line = tp.line AND pc.bookmaker = 'hardrockbet'
               AND ((tp.is_pl AND pc.player_name = tp.player_name)
                    OR (NOT tp.is_pl AND (
                          (pc.home_team=tp.team AND pc.away_team=tp.opponent)
                          OR (pc.home_team=tp.opponent AND pc.away_team=tp.team))))
           ) AS has_hr,
           EXISTS (
             SELECT 1 FROM public.props_cache pc
             WHERE pc.sport='mlb' AND pc.game_date='20260611'
               AND pc.prop_type = tp.prop_type AND pc.pick_side = tp.pick_side
               AND pc.line = tp.line
               AND ((tp.is_pl AND pc.player_name = tp.player_name)
                    OR (NOT tp.is_pl AND (
                          (pc.home_team=tp.team AND pc.away_team=tp.opponent)
                          OR (pc.home_team=tp.opponent AND pc.away_team=tp.team))))
           ) AS has_any_line_match,
           EXISTS (
             SELECT 1 FROM public.props_cache pc
             WHERE pc.sport='mlb' AND pc.game_date='20260611'
               AND pc.prop_type = tp.prop_type AND pc.pick_side = tp.pick_side
               AND ((tp.is_pl AND pc.player_name = tp.player_name)
                    OR (NOT tp.is_pl AND (
                          (pc.home_team=tp.team AND pc.away_team=tp.opponent)
                          OR (pc.home_team=tp.opponent AND pc.away_team=tp.team))))
           ) AS has_any_match
    FROM is_player tp
  )
  SELECT
    count(*) FILTER (WHERE has_hr)                AS hr_match_n,
    count(*) FILTER (WHERE has_any_line_match)    AS any_line_match_n,
    count(*) FILTER (WHERE has_any_match)         AS any_match_n,
    count(*)                                       AS total_n
  INTO v_hr, v_line_match, v_any, v_n FROM matched;

  RAISE NOTICE '[D-511 join-test] HR same-line matches:    % / %', v_hr,         v_n;
  RAISE NOTICE '[D-511 join-test] ANY-book same-line:      % / %', v_line_match, v_n;
  RAISE NOTICE '[D-511 join-test] ANY-book any-line:       % / %', v_any,        v_n;
  RAISE NOTICE '[D-511 join-test] would be market_absent:  % / %', v_n - v_any,  v_n;

  -- Manually run the capture function on a test window (bypass game_time gate
  -- by NOT using game_time at all — just touch a few picks for sanity).
  -- Skip; we'll verify in SHIP 3 when games actually start.
END $$;
