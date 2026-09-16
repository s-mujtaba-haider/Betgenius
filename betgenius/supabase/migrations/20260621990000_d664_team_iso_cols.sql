-- D-664 SHIP 1 (B) — Team ISO / SLG / AVG columns on cache_team_batting_stats.
-- Used by score_team_iso_v3 (homer-teams cover -1.5 differently than singles-teams).
-- Source: MLB Stats API /teams/{id}/stats?group=hitting — extends existing
-- fetch-mlb-team-stats daily writer (jobid 19, 12:30 UTC). Reader extends
-- readTeamSeasonContext in process-games-mlb. No new cron.

ALTER TABLE public.cache_team_batting_stats
  ADD COLUMN IF NOT EXISTS slg_season NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS avg_season NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS iso_season NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS home_runs INTEGER,
  ADD COLUMN IF NOT EXISTS at_bats INTEGER;

COMMENT ON COLUMN public.cache_team_batting_stats.iso_season IS
  'D-664 — Team isolated power (slg - avg). Drives score_team_iso_v3 on spreads.';
