-- ============================================================================
-- Migration : 20260515000004_d186_cache_team_advanced_stats.sql
-- Date      : 2026-05-15
-- Task      : D-186 — C26-B per-team daily snapshot writer using BDL GOAT
--             advanced metrics. CEO §19.3 APPROVED (May 15, 2026).
--
-- Purpose   : 1) Extend cache_opponent_defensive_stats with 9 new team-level
--                advanced columns from BDL /v1/stats/advanced (GOAT-tier
--                endpoint unlocked May 15 per D-180 Path B).
--             2) Create new cache_team_advanced_stats_by_position table for
--                per-position breakdowns ("what team Y allows to position X").
--
-- Why now   : D-185 landed 1,279 backfill picks but all in Pass tier because
--             helpers returned null (no historical opponent advanced data).
--             This migration is the schema half of the unblock. Edge function
--             fetch-team-advanced-stats is the writer (deploys same session).
--
-- Pure additive : ALL columns added via ADD COLUMN IF NOT EXISTS. New table
--                 via CREATE TABLE IF NOT EXISTS. No row touched. Existing
--                 snapshot-opp-stats writer untouched (writes rpg/apg_*_bdl).
--
-- Rollback :
--     ALTER TABLE public.cache_opponent_defensive_stats
--       DROP COLUMN IF EXISTS offensive_rating,
--       DROP COLUMN IF EXISTS pie,
--       DROP COLUMN IF EXISTS true_shooting_percentage,
--       DROP COLUMN IF EXISTS assist_percentage,
--       DROP COLUMN IF EXISTS offensive_rebound_percentage,
--       DROP COLUMN IF EXISTS defensive_rebound_percentage,
--       DROP COLUMN IF EXISTS effective_field_goal_percentage,
--       DROP COLUMN IF EXISTS usage_percentage,
--       DROP COLUMN IF EXISTS assist_to_turnover,
--       DROP COLUMN IF EXISTS goat_stats_source;
--     DROP TABLE IF EXISTS public.cache_team_advanced_stats_by_position CASCADE;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Extend cache_opponent_defensive_stats with GOAT team-level advanced
--    columns. def_rating, pace, net_rating already exist (added May 5 +
--    Phase 1 May 1) so they remain untouched — fetch-team-advanced-stats
--    will OVERWRITE def_rating + pace + net_rating with GOAT values on its
--    daily tick (more authoritative than the season-averages source).
-- ----------------------------------------------------------------------------
ALTER TABLE public.cache_opponent_defensive_stats
  ADD COLUMN IF NOT EXISTS offensive_rating                NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS pie                             NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS true_shooting_percentage        NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS assist_percentage               NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS offensive_rebound_percentage    NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS defensive_rebound_percentage    NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS effective_field_goal_percentage NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS usage_percentage                NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS assist_to_turnover              NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS goat_stats_source               TEXT;

COMMENT ON COLUMN public.cache_opponent_defensive_stats.offensive_rating IS
  'Team offensive rating (per-100-possession points scored). From BDL /v1/stats/advanced '
  'aggregated over last 7-15 games. NBA range ~105-120. Higher = better offense.';
COMMENT ON COLUMN public.cache_opponent_defensive_stats.pie IS
  'Player Impact Estimate, team-aggregated. NBA scale ~0.08-0.20. Composite efficiency.';
COMMENT ON COLUMN public.cache_opponent_defensive_stats.true_shooting_percentage IS
  'Team TS% (points / (2*(FGA + 0.44*FTA))). NBA range ~0.530-0.620.';
COMMENT ON COLUMN public.cache_opponent_defensive_stats.usage_percentage IS
  'Team-aggregated usage rate. Team-level should sum near 1.00 across roster.';
COMMENT ON COLUMN public.cache_opponent_defensive_stats.goat_stats_source IS
  'Marker for which writer last populated the GOAT advanced columns: '
  'bdl_goat_stats_advanced = fetch-team-advanced-stats has run / NULL = legacy only.';

-- ----------------------------------------------------------------------------
-- 2) cache_team_advanced_stats_by_position — per-team per-OPPONENT-position
--    advanced metrics. "What team Y allows to opposing players of position X".
--
--    Per-row meaning: for snapshot_date D, when team_abbr defended against
--    players of opposing position `position`, those opposing players
--    averaged these advanced metrics. Used by scoring.calculatePaceDefense
--    for position-aware rebounds/assists prop scoring.
--
--    Position values: PG | SG | SF | PF | C (5 NBA positions). BDL player
--    rows include player.position; we map G→PG/SG via heuristic in writer
--    if BDL returns generic G/F (rare in modern feed).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cache_team_advanced_stats_by_position (
  team_abbr                       TEXT          NOT NULL,
  position                        TEXT          NOT NULL,
  snapshot_date                   DATE          NOT NULL,
  games_sampled                   INTEGER       NOT NULL DEFAULT 0,
  players_sampled                 INTEGER       NOT NULL DEFAULT 0,
  defensive_rating                NUMERIC(5,2),
  offensive_rating                NUMERIC(5,2),
  net_rating                      NUMERIC(5,2),
  pace                            NUMERIC(5,2),
  pie                             NUMERIC(5,3),
  true_shooting_percentage        NUMERIC(5,4),
  assist_percentage               NUMERIC(5,3),
  offensive_rebound_percentage    NUMERIC(5,3),
  defensive_rebound_percentage    NUMERIC(5,3),
  effective_field_goal_percentage NUMERIC(5,4),
  usage_percentage                NUMERIC(5,3),
  assist_to_turnover              NUMERIC(5,3),
  fetched_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  sport                           TEXT          NOT NULL DEFAULT 'nba',
  PRIMARY KEY (team_abbr, position, snapshot_date, sport)
);
CREATE INDEX IF NOT EXISTS idx_ctasbp_team       ON public.cache_team_advanced_stats_by_position (team_abbr, sport);
CREATE INDEX IF NOT EXISTS idx_ctasbp_date       ON public.cache_team_advanced_stats_by_position (snapshot_date, sport);
CREATE INDEX IF NOT EXISTS idx_ctasbp_fetched_at ON public.cache_team_advanced_stats_by_position (fetched_at);

COMMENT ON TABLE public.cache_team_advanced_stats_by_position IS
  'D-186 per-team per-opposing-position advanced metrics snapshot. Source: BDL '
  '/v1/stats/advanced aggregated over last 7-15 games. "What team Y allows to '
  'opposing position X" — for opp_defense factor on rebounds/assists props.';

ALTER TABLE public.cache_team_advanced_stats_by_position ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cache_team_advanced_stats_by_position_select_authed
  ON public.cache_team_advanced_stats_by_position;
CREATE POLICY cache_team_advanced_stats_by_position_select_authed
  ON public.cache_team_advanced_stats_by_position
  FOR SELECT TO authenticated USING (true);
