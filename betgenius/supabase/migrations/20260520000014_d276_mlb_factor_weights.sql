-- D-276-FACTORS (2026-05-20) — algorithm_weights MLB factor columns.
--
-- Adds 22 new factor weight columns for the MLB factor expansion
-- from D-275 SHIP 3 (deferred) → D-276 SHIP 1. Per escalation rule 1,
-- factors with data sources not yet available ship as zero-weight
-- placeholders so the column registry is forward-compatible.
--
-- WIRED FULLY THIS BATCH (3): use Statcast accessor module
-- + 3 pilot scoring helpers shipped in D-274 Phase 2:
--   w_mlb_pitcher_xera_edge          — pitcher_k (scorePitcherXeraEdge)
--   w_mlb_batter_barrel_rate         — batter_hr (scoreBatterBarrelPa)
--   w_mlb_batter_xslg_regression     — batter_hr + total_bases (scoreBatterXslgRegression)
--
-- PLACEHOLDER (19): default weight 0.0 until accessors / cache
-- tables / data sources land. Listed exhaustively below by spec
-- group so D-277 has a concrete list to wire.
--
-- Rollback:
--   ALTER TABLE public.algorithm_weights DROP COLUMN w_mlb_pitcher_xera_edge, ...;

ALTER TABLE public.algorithm_weights
  -- pitcher_strikeouts group (6 factors)
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_xera_edge         numeric NOT NULL DEFAULT 1.0,  -- WIRED
  ADD COLUMN IF NOT EXISTS w_mlb_catcher_framing           numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_pitch_mix_k       numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_lineup_k_composition      numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_park_k_factor             numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_umpire_k_factor           numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_baa_vs_hand       numeric NOT NULL DEFAULT 0.0,

  -- batter hits/tb/rbis group (7 factors)
  ADD COLUMN IF NOT EXISTS w_mlb_batter_xba                numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_xslg_regression    numeric NOT NULL DEFAULT 1.0,  -- WIRED (shared with HR)
  ADD COLUMN IF NOT EXISTS w_mlb_batter_babip              numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_batter_vs_pitcher_hand    numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_baa               numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_lineup_spot               numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_bullpen_quality           numeric NOT NULL DEFAULT 0.0,

  -- batter_hr-specific group (7 factors; 2 shared with batter group: xslg, exit_velo)
  ADD COLUMN IF NOT EXISTS w_mlb_batter_barrel_rate        numeric NOT NULL DEFAULT 1.0,  -- WIRED
  ADD COLUMN IF NOT EXISTS w_mlb_batter_exit_velo_trend    numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_hr_per_9          numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_pitcher_fly_ball_rate     numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_wind_direction_hr         numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_park_hr_factor            numeric NOT NULL DEFAULT 0.0,

  -- game_side / game_total group (4 factors)
  ADD COLUMN IF NOT EXISTS w_mlb_manager_bullpen_tendency  numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_day_after_night_fatigue   numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_lineup_vs_hand_split      numeric NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS w_mlb_umpire_run_factor         numeric NOT NULL DEFAULT 0.0;

COMMENT ON COLUMN public.algorithm_weights.w_mlb_pitcher_xera_edge IS
  'D-276-FACTORS WIRED: pitcher xERA vs league avg 4.20. Reads via _shared/statcast.ts getPitcherStatcast(). Bucket-based ±10. Default 1.0.';
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_barrel_rate IS
  'D-276-FACTORS WIRED: batter barrels/PA % vs league avg 6%. Reads via _shared/statcast.ts getBatterStatcast(). Bucket-based ±8. Default 1.0.';
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_xslg_regression IS
  'D-276-FACTORS WIRED: actual SLG vs expected SLG delta. Reads via _shared/statcast.ts getBatterStatcast(). Bucket-based ±4. Default 1.0.';
