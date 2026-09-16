-- D-678 SHIP 5 — standing factor-completeness monitor.
-- For each (market, factor_col) pair from MARKET_FACTOR_COLS, count what % of
-- the last 24h's picks have a non-zero value. Flag any factor at 0% or
-- flatline as DEAD. RPC is consumed by system-health which surfaces it on
-- the Admin dashboard so a future regression auto-flags within a day instead
-- of being found by eye.

-- Inventory mirrors src/pages/Dashboard.tsx MARKET_FACTOR_COLS (D-676 + D-678
-- curation). Keep in sync when MARKET_FACTOR_COLS changes.
CREATE OR REPLACE FUNCTION public.mlb_market_factor_health_24h()
RETURNS TABLE (
  market         TEXT,
  factor_col     TEXT,
  n_picks        INT,
  n_non_null     INT,
  n_non_zero     INT,
  pct_non_zero   NUMERIC(5,1)
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ := NOW() - INTERVAL '24 hours';
  v_inventory JSONB := jsonb_build_object(
    'pitcher_outs',       jsonb_build_array('score_pitcher_avg_ip','score_pitcher_recent_ip_trend','score_pitcher_volatility_v2','score_rest_pitcher','score_pitcher_walk_efficiency','score_pitcher_recent_pitch_count','score_first_inning_trouble','score_bullpen_game_or_opener','score_own_pen_rest','score_game_script_risk','score_opp_k_rate','score_opp_obp_patience','score_opp_walk_rate','score_opp_pitch_grind','score_opp_chase_rate','score_ballpark_factor','score_weather_temp'),
    'pitcher_k',          jsonb_build_array('score_pitcher_k_rate','score_pitcher_form','score_opposing_lineup_k','score_handedness_matchup','score_pitch_count_trend','score_rest_pitcher','score_ballpark_factor','score_weather_wind','score_weather_temp','score_umpire_k_zone','score_pitcher_command_trend','score_pitcher_velocity_trend','score_lineup_k_composition','score_pitch_type_matchup','score_pitcher_xera_edge','score_pitcher_baa','score_catcher_framing','score_pitcher_pitch_mix_k','score_pitcher_whiff_skill_v2'),
    'batter_runs_scored', jsonb_build_array('score_batter_hit_rate','score_batter_form','score_batter_form_power','score_batter_power_rate','score_batter_babip','score_batter_xba','score_batter_barrel_rate','score_batter_exit_velo_trend','score_batter_xslg_regression','score_batter_vs_pitcher_hand_split','score_batter_recent_at_bats','score_recent_run_form','score_batter_obp','score_opp_pitcher_pitchtype_quality','score_opposing_pitcher_quality','score_bullpen_quality','score_ballpark_factor','score_lineup_spot'),
    'batter_rbis',        jsonb_build_array('score_batter_form_power','score_batter_power_rate','score_batter_babip','score_batter_xba','score_batter_barrel_rate','score_batter_exit_velo_trend','score_batter_xslg_regression','score_batter_vs_pitcher_hand_split','score_recent_at_bats','score_batter_line_hit_rate','score_opp_pitcher_pitchtype_quality','score_opposing_pitcher_quality','score_pitcher_baa_vs_hand','score_pitcher_gb_fb_rate','score_pitcher_hr_per_9','score_pitcher_hr_rate','score_handedness_matchup','score_lineup_consistency','score_lineup_spot','score_bullpen_quality','score_hitter_streak_fatigue','score_day_after_night_fatigue','score_ballpark_factor','score_weather_wind','score_weather_temp'),
    'batter_hr',          jsonb_build_array('score_batter_form_power','score_batter_power_rate','score_batter_barrel_rate','score_batter_exit_velo_trend','score_batter_xslg_regression','score_batter_vs_pitcher_hand_split','score_recent_at_bats','score_batter_line_hit_rate','score_opp_pitcher_pitchtype_quality','score_opposing_pitcher_quality','score_pitcher_baa_vs_hand','score_pitcher_gb_fb_rate','score_pitcher_hr_per_9','score_pitcher_hr_rate','score_handedness_matchup','score_lineup_consistency','score_lineup_spot','score_bullpen_quality','score_hitter_streak_fatigue','score_day_after_night_fatigue','score_ballpark_factor','score_weather_wind','score_weather_temp','score_wind_direction_hr'),
    'batter_total_bases', jsonb_build_array('score_batter_form_power','score_batter_power_rate','score_batter_babip','score_batter_xba','score_batter_barrel_rate','score_batter_exit_velo_trend','score_batter_xslg_regression','score_batter_vs_pitcher_hand_split','score_recent_at_bats','score_batter_line_hit_rate','score_opp_pitcher_pitchtype_quality','score_opposing_pitcher_quality','score_pitcher_baa_vs_hand','score_pitcher_hr_rate','score_handedness_matchup','score_lineup_consistency','score_lineup_spot','score_bullpen_quality','score_hitter_streak_fatigue','score_day_after_night_fatigue','score_ballpark_factor','score_weather_wind','score_weather_temp'),
    'batter_hits',        jsonb_build_array('score_batter_hit_rate','score_batter_form','score_batter_babip','score_batter_xba','score_batter_vs_pitcher_hand_split','score_recent_at_bats','score_batter_line_hit_rate','score_opp_pitcher_pitchtype_quality','score_opposing_pitcher_quality','score_pitcher_baa_vs_hand','score_handedness_matchup','score_lineup_consistency','score_lineup_spot','score_bullpen_quality','score_hitter_streak_fatigue','score_day_after_night_fatigue','score_ballpark_factor','score_weather_temp'),
    'batter_strikeouts',  jsonb_build_array('score_batter_hit_rate','score_batter_form','score_batter_form_power','score_batter_babip','score_batter_xba','score_batter_vs_pitcher_hand_split','score_recent_at_bats','score_opposing_pitcher_quality','score_ballpark_factor','score_weather_temp'),
    'game_side',          jsonb_build_array('score_team_offense_form_v3','score_team_run_prevention_form_v3','score_sp_statcast_quality_v3','score_bullpen_quality_v3','score_team_defense_oaa_v3','score_park_runs_v3','score_lineup_confirmation_v3','score_pitcher_gb_fb_rate_v3','score_team_ops_v3','score_sp_ip_depth_v3','score_blowout_tendency_v3','score_team_iso_v3','score_pen_rest_v3','score_bob_quality_v3','score_sp_last3_form_v3','score_lineup_depth_v3','score_pitching_matchup','score_lineup_vs_hand_split','score_h2h_recent','score_team_form','score_recent_run_diff','score_bullpen_strength','score_k_matchup_v2','score_team_offense_strength_v2'),
    'game_total',         jsonb_build_array('score_team_offense_form_v3','score_team_run_prevention_form_v3','score_sp_statcast_quality_v3','score_bullpen_quality_v3','score_team_defense_oaa_v3','score_park_runs_v3','score_lineup_confirmation_v3','score_pitcher_gb_fb_rate_v3','score_team_ops_v3','score_sp_ip_depth_v3','score_blowout_tendency_v3','score_team_iso_v3','score_pen_rest_v3','score_bob_quality_v3','score_sp_last3_form_v3','score_lineup_depth_v3','score_pitching_matchup','score_lineup_vs_hand_split','score_h2h_recent','score_team_form','score_recent_run_diff','score_bullpen_strength','score_ballpark_factor','score_weather_wind','score_weather_temp','score_umpire_k_zone','score_k_matchup_v2','score_team_offense_strength_v2')
  );
  v_market TEXT;
  v_cols JSONB;
  v_col TEXT;
BEGIN
  FOR v_market, v_cols IN
    SELECT key, value FROM jsonb_each(v_inventory)
  LOOP
    FOR v_col IN SELECT jsonb_array_elements_text(v_cols)
    LOOP
      RETURN QUERY
      WITH base AS (
        SELECT (breakdown ->> v_col) AS raw
        FROM pick_history
        WHERE created_at >= v_cutoff
          AND is_synthetic = FALSE
          AND mlb_market_type = v_market
      )
      SELECT
        v_market::TEXT,
        v_col::TEXT,
        COUNT(*)::INT AS n_picks,
        COUNT(raw)::INT AS n_non_null,
        SUM(CASE WHEN raw IS NOT NULL AND raw <> '0' THEN 1 ELSE 0 END)::INT AS n_non_zero,
        CASE WHEN COUNT(*) > 0
             THEN ROUND(100.0 * SUM(CASE WHEN raw IS NOT NULL AND raw <> '0' THEN 1 ELSE 0 END) / COUNT(*), 1)
             ELSE 0 END::NUMERIC(5,1) AS pct_non_zero
      FROM base;
    END LOOP;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.mlb_market_factor_health_24h() TO service_role;
GRANT EXECUTE ON FUNCTION public.mlb_market_factor_health_24h() TO authenticated;

COMMENT ON FUNCTION public.mlb_market_factor_health_24h() IS
  'D-678 SHIP 5 — per-market per-factor fire-rate over last 24h of live picks. Surfaces ANY factor in MARKET_FACTOR_COLS at 0% as DEAD. Used by system-health to flag silent regressions within 24h.';

-- D-678 SHIP 5b — companion RPC: returns a single severity rollup for
-- system-health to consume as one check row instead of N rows.
CREATE OR REPLACE FUNCTION public.mlb_market_factor_health_summary_24h()
RETURNS TABLE (
  total_factors          INT,
  dead_factors           INT,
  starved_factors        INT,
  healthy_factors        INT,
  dead_examples          TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH per_factor AS (
    SELECT * FROM public.mlb_market_factor_health_24h()
    WHERE n_picks > 0  -- skip markets with no picks in 24h (dormant)
  )
  SELECT
    COUNT(*)::INT AS total_factors,
    SUM(CASE WHEN pct_non_zero = 0 THEN 1 ELSE 0 END)::INT AS dead_factors,
    SUM(CASE WHEN pct_non_zero > 0 AND pct_non_zero < 25 THEN 1 ELSE 0 END)::INT AS starved_factors,
    SUM(CASE WHEN pct_non_zero >= 25 THEN 1 ELSE 0 END)::INT AS healthy_factors,
    COALESCE(STRING_AGG(
      market || '.' || factor_col,
      ', ' ORDER BY market, factor_col
    ) FILTER (WHERE pct_non_zero = 0), '')::TEXT AS dead_examples
  FROM per_factor;
END $$;

GRANT EXECUTE ON FUNCTION public.mlb_market_factor_health_summary_24h() TO service_role;
GRANT EXECUTE ON FUNCTION public.mlb_market_factor_health_summary_24h() TO authenticated;

COMMENT ON FUNCTION public.mlb_market_factor_health_summary_24h() IS
  'D-678 SHIP 5b — single-row rollup of mlb_market_factor_health_24h for system-health. Returns dead/starved/healthy counts + first N dead market.factor names.';
