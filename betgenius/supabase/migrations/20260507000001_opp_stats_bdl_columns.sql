-- C26-B — opp-stats true rebounds-allowed and assists-allowed via BDL aggregation
--
-- Background: cache_opponent_defensive_stats.rpg_allowed and .apg_allowed
-- columns have CORRECT NAMES but populated with WRONG DATA. The values come
-- from ESPN team-stats endpoint which returns the team's OWN rebounds/assists
-- per game, not what they ALLOW opponents to score against them. ppg_allowed
-- and def_rating are correct (sourced from BDL); only RPG/APG are wrong.
--
-- Fix: gradual-cutover pattern with new columns rpg_allowed_bdl + apg_allowed_bdl
-- populated by a daily snapshot-opp-stats edge function that aggregates BDL
-- /v1/stats per-game data. Existing rpg_allowed + apg_allowed columns continue
-- to be written by process-games' ESPN-sourced writer (legacy ESPN path stays
-- live for fallback during transition). Reader prefers _bdl values when
-- available, falls back to ESPN-sourced values when NULL.
--
-- opp_stats_source TEXT tracks which source populated the row's _bdl columns:
--   'bdl_aggregated' — daily snapshot job populated rpg_allowed_bdl + apg_allowed_bdl
--   NULL — only legacy ESPN values present (rpg_allowed + apg_allowed)
--
-- Pure additive — existing rows unchanged. No backfill required. Migration is
-- idempotent (IF NOT EXISTS on every column add).

ALTER TABLE public.cache_opponent_defensive_stats
  ADD COLUMN IF NOT EXISTS rpg_allowed_bdl NUMERIC,
  ADD COLUMN IF NOT EXISTS apg_allowed_bdl NUMERIC,
  ADD COLUMN IF NOT EXISTS opp_stats_source TEXT;

COMMENT ON COLUMN public.cache_opponent_defensive_stats.rpg_allowed_bdl IS
  'True opponent-allowed RPG via BDL /v1/stats per-game aggregation. '
  'Distinct from rpg_allowed (which is populated by ESPN team-stats and '
  'returns the team OWN RPG, not opponents-allowed). Reader prefers _bdl '
  'when present, falls back to rpg_allowed otherwise.';

COMMENT ON COLUMN public.cache_opponent_defensive_stats.apg_allowed_bdl IS
  'True opponent-allowed APG via BDL /v1/stats per-game aggregation. '
  'Distinct from apg_allowed (legacy ESPN-sourced own-team APG).';

COMMENT ON COLUMN public.cache_opponent_defensive_stats.opp_stats_source IS
  'Marker for which source populated the _bdl columns: bdl_aggregated = '
  'snapshot-opp-stats has run for this snapshot_date / NULL = only legacy '
  'ESPN values present.';
