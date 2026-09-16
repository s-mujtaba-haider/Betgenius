-- D-272-INF-3 (2026-05-20) — Retroactive migration for recommendations_cache.
--
-- Table was created out-of-band in early project history (pre-formal-
-- migration era). This file documents its current schema so the repo
-- is schema-as-code complete. Uses CREATE TABLE IF NOT EXISTS so it's
-- a no-op against production (table already exists with 8,569 rows
-- as of 2026-05-20).
--
-- Schema captured from PostgREST OpenAPI introspection on 2026-05-20.
--
-- Rollback (production already has table): do nothing. For a fresh
-- environment provisioned from migrations, dropping this table would
-- require: DROP TABLE public.recommendations_cache CASCADE;

CREATE TABLE IF NOT EXISTS public.recommendations_cache (
  id                          bigserial PRIMARY KEY,
  created_at                  timestamptz DEFAULT now(),
  game_id                     text,
  game_time                   text,
  player_name                 text NOT NULL,
  team                        text,
  opponent                    text,
  is_home                     boolean,
  prop_type                   text NOT NULL,
  line                        numeric,
  pick_side                   text DEFAULT 'over',
  odds                        integer,
  bookmaker                   text,
  confidence                  integer,
  verdict                     text,
  ai_analysis                 text,
  season_avg                  numeric,
  recent_avg                  numeric,
  floor_val                   numeric,
  ceiling_val                 numeric,
  l5_hit_count                integer,
  l10_hit_count               integer,
  season_hit_pct              numeric,
  is_b2b                      boolean DEFAULT false,
  rest_days                   integer,
  minutes_l5_avg              numeric,
  minutes_l10_avg             numeric,
  minutes_trend               text,
  opp_ppg_allowed             numeric,
  opp_rpg_allowed             numeric,
  opp_fg_pct_allowed          numeric,
  opp_3pt_pct_allowed         numeric,
  pace_opp_ppg                numeric,
  score_l5                    numeric DEFAULT 0,
  score_l10                   numeric DEFAULT 0,
  score_season                numeric DEFAULT 0,
  score_floor_ceiling         numeric DEFAULT 0,
  score_recent_form           numeric DEFAULT 0,
  score_home_away             numeric DEFAULT 0,
  score_rest                  numeric DEFAULT 0,
  score_b2b                   numeric DEFAULT 0,
  score_minutes_trend         numeric DEFAULT 0,
  score_pace                  numeric DEFAULT 0,
  score_opp_defense           numeric DEFAULT 0,
  score_odds_value            numeric DEFAULT 0,
  score_z_score               numeric DEFAULT 0,
  score_role_change           numeric DEFAULT 0,
  score_vig_filter            numeric DEFAULT 0,
  score_usg_rate              numeric DEFAULT 0,
  score_regression            numeric DEFAULT 0,
  score_market_conf           numeric DEFAULT 0,
  score_home_away_split       numeric DEFAULT 0,
  score_minutes_floor         numeric DEFAULT 0,
  score_consistency           numeric DEFAULT 0,
  score_prop_type_penalty     numeric DEFAULT 0,
  score_stale_data            numeric DEFAULT 0,
  score_player_injury         numeric DEFAULT 0,
  score_l10_form              numeric,
  score_ha_record             numeric,
  score_point_diff            numeric,
  score_rest_advantage        numeric,
  score_scoring_trend         numeric,
  score_h2h                   numeric,
  score_sos                   numeric,
  score_net_rating            numeric,
  projected_stat              numeric,
  stat_stdev                  numeric,
  z_score                     numeric,
  per_minute_rate             numeric,
  projected_minutes           numeric,
  teammate_injuries_count     integer,
  usage_boost                 numeric,
  hit_rates_display           jsonb,
  last5_values                jsonb,
  breakdown                   jsonb,
  absence_info                jsonb,
  team_stats                  jsonb,
  available_books             jsonb,
  sport                       text NOT NULL DEFAULT 'nba',
  score_trivial_line_penalty  numeric DEFAULT 0,
  score_trivial_line_cap      boolean DEFAULT false,
  score_minutes_volume        numeric DEFAULT 0,
  score_minutes_stability     numeric DEFAULT 0,
  game_date                   date NOT NULL,
  score_low_min_risk          numeric NOT NULL DEFAULT 0,
  score_blowout_risk          numeric NOT NULL DEFAULT 0,
  score_line_movement         numeric NOT NULL DEFAULT 0,
  unbettable_juice_flag       boolean NOT NULL DEFAULT false,
  is_secondary_market         boolean NOT NULL DEFAULT false,
  coin_flip_flag              boolean NOT NULL DEFAULT false,
  negative_stacking_flag      boolean NOT NULL DEFAULT false,
  negative_factor_count       integer NOT NULL DEFAULT 0
);

COMMENT ON TABLE public.recommendations_cache IS
  'D-272-INF-3 retroactive (schema captured 2026-05-20). Cron-generated '
  'daily picks consumed by Dashboard / Games / Tracker / Evaluator. '
  'NBA: process-games writes; MLB: process-games-mlb writes. Tier 1 '
  'rebalance + tier-aware scoring + flag set all land here.';
