-- D-740 STEP 1A — cache_mlb_pitcher_season_stats
--
-- Mirrors PitcherSeasonStats interface from scoring_mlb_v2.ts.
-- Source-of-truth: MLB Stats API /people/{playerId}/stats?stats=season&group=pitching
-- — the SAME source process-games-mlb.fetchPitcherSeason consumes at live scoring time.
--
-- Populated by the backfill-pitcher-season-stats edge function.
-- Read by historical_context_router_pitcher.ts (D-740 STEP 1C) — falls back to
-- boxscore aggregation if a player_id+season is not in this cache.

CREATE TABLE IF NOT EXISTS cache_mlb_pitcher_season_stats (
  player_id        bigint NOT NULL,
  season           integer NOT NULL,
  full_name        text,
  throws           text,
  games_played     integer,
  innings_pitched  numeric,
  strike_outs      integer,
  batters_faced    integer,
  k_per_nine       numeric,
  era              numeric,
  pitches_per_start numeric,
  base_on_balls    integer,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_pitcher_season_stats_player ON cache_mlb_pitcher_season_stats(player_id);

COMMENT ON TABLE cache_mlb_pitcher_season_stats IS
  'D-740: per-pitcher season aggregate sourced from MLB Stats API (matches process-games-mlb.fetchPitcherSeason). Closes the k_rate parity gap D-737f-A-2 identified between historical-router (boxscore-derived) and live-scoring (MLB API) paths.';
