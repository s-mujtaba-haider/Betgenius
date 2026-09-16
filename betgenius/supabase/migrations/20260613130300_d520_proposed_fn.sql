-- D-520 SHIP 2 — SQL harness for the proposed scoring change.
-- The function d520_new_conf computes what a pick's confidence WOULD HAVE
-- BEEN if we had: (a) flipped signs on the 9 confirmed-inverted factors,
-- AND (b) added the D-517 v2 line_hit_rate factor with weight 2.0.
-- LIVE SCORING IS UNCHANGED. The function is invoked only in validation queries.

-- The 9 confirmed-inverted factors (from SHIP 1 OOS check):
--   score_handedness_matchup          (-41pp / -39pp on A/B halves)
--   score_weather_wind                (-35 / -34)
--   score_lineup_consistency          (-27 / -23)
--   score_weather_temp                (-22 / -17)
--   score_wind_direction_hr           (-69 / -16)
--   score_opposing_pitcher_quality    ( -9 / -6)
--   score_batter_form_power           (-10 / -6)
--   score_recent_at_bats              ( -9 / -5)
--   score_batter_babip                ( -5 / -10)
--
-- For each, NEW contribution = -OLD contribution.
-- Net change to confidence = -2 × stored_score_value.
--
-- Plus D-517 v2 line_hit_rate factor (penalty-only, weight 2.0).
--   bands -3/-6/-10/-15 on l10 < 60/50/40/30.

CREATE OR REPLACE FUNCTION public.d520_new_conf(
  p_old_conf  INTEGER,
  p_market    TEXT,
  p_pick_side TEXT,
  p_breakdown JSONB
)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_delta NUMERIC := 0;
  v_old   NUMERIC;
  v_l10   NUMERIC;
  v_l10_f INTEGER;
BEGIN
  -- Touch only batter markets (the analysis was on batter picks only)
  IF p_market IS NULL OR p_market NOT LIKE 'batter_%' THEN RETURN p_old_conf; END IF;
  IF p_breakdown IS NULL THEN RETURN p_old_conf; END IF;

  -- 9 sign flips inline (subtract OLD contribution + add -OLD = -2 × OLD):
  v_old := COALESCE((p_breakdown->>'score_handedness_matchup')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_weather_wind')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_lineup_consistency')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_weather_temp')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_wind_direction_hr')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_opposing_pitcher_quality')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_batter_form_power')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_recent_at_bats')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;
  v_old := COALESCE((p_breakdown->>'score_batter_babip')::NUMERIC, 0);
  v_delta := v_delta - 2 * v_old;

  -- Add D-517 v2 line_hit_rate factor (penalty-only, weight 2.0).
  IF p_breakdown ? 'last10_hit_rate_pct' THEN
    v_l10 := (p_breakdown->>'last10_hit_rate_pct')::NUMERIC;
    v_l10_f := CASE
      WHEN v_l10 >= 60 THEN 0
      WHEN v_l10 >= 50 THEN -3
      WHEN v_l10 >= 40 THEN -6
      WHEN v_l10 >= 30 THEN -10
      ELSE -15
    END;
    v_delta := v_delta + ROUND(v_l10_f * 2.0);
  END IF;

  RETURN LEAST(100, GREATEST(0, p_old_conf + v_delta::INTEGER));
END;
$$;

GRANT EXECUTE ON FUNCTION public.d520_new_conf(INTEGER, TEXT, TEXT, JSONB) TO PUBLIC;
