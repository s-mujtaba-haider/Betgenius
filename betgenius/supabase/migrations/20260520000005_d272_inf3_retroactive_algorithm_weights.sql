-- D-272-INF-3 (2026-05-20) — Retroactive migration for algorithm_weights.
--
-- Singleton row (id=1) holds the 26 NBA factor weights consumed by
-- _shared/scoring.ts loadWeightsFromDB(). Created out-of-band early
-- in project history. Schema captured from PostgREST OpenAPI 2026-05-20.
--
-- Rollback (production has table): no-op. For fresh environment:
--   DROP TABLE public.algorithm_weights CASCADE;

CREATE TABLE IF NOT EXISTS public.algorithm_weights (
  id                 integer PRIMARY KEY DEFAULT 1,
  updated_at         timestamptz DEFAULT now(),
  w_l5               numeric DEFAULT 1.0,
  w_l10              numeric DEFAULT 0.0,
  w_season           numeric DEFAULT 1.75,
  w_floor_ceiling    numeric DEFAULT 1.5,
  w_recent_form      numeric DEFAULT 1.5,
  w_home_away        numeric DEFAULT 0.0,
  w_minutes_trend    numeric DEFAULT 0.0,
  w_pace             numeric DEFAULT 0.5,
  w_opp_defense      numeric DEFAULT 0.0,
  w_rest             numeric DEFAULT 0.0,
  w_b2b              numeric DEFAULT 2.25,
  w_prop_type        numeric DEFAULT 0.25,
  w_z_score          numeric DEFAULT 0.25,
  w_role_change      numeric DEFAULT 2.0,
  w_vig_filter       numeric DEFAULT 0.0,
  w_usg_rate         numeric DEFAULT 1.0,
  w_regression       numeric DEFAULT 1.0,
  w_market_conf      numeric DEFAULT 2.0,
  w_ha_split         numeric DEFAULT 0.0,
  w_minutes_floor    numeric DEFAULT 2.5,
  w_consistency      numeric DEFAULT 1.0,
  w_stale_data       numeric DEFAULT 2.25,
  w_player_injury    numeric DEFAULT 0.75,
  backtest_win_pct   numeric,
  backtest_roi       numeric,
  backtest_picks     integer,
  w_low_min_risk     numeric NOT NULL DEFAULT 1.0,
  w_blowout_risk     numeric NOT NULL DEFAULT 1.0,
  w_line_movement    numeric NOT NULL DEFAULT 1.0
);

COMMENT ON TABLE public.algorithm_weights IS
  'D-272-INF-3 retroactive (schema captured 2026-05-20). Singleton '
  'row id=1 — 26 NBA factor weights consumed by _shared/scoring.ts '
  'loadWeightsFromDB(). 7 default-zero factors per D-239 INFO finding '
  '(l10, homeAway, rest, minutesTrend, oppDefense, vigFilter, haSplit) '
  'though live DB row may have different runtime values.';
