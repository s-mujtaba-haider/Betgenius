-- D-562 — Add runs_allowed_per_game column to cache_team_batting_stats so
-- the fetcher can write real RAPG data and the scorer can read it instead
-- of defaulting silently to 4.5 (which produced D-550 §B.4's constant-
-- valued column with corr()=NULL).
--
-- Nullable, default NULL — old snapshots stay unaffected; new snapshots
-- get populated by fetch-mlb-team-stats from /teams/{id}/stats?group=pitching.

ALTER TABLE public.cache_team_batting_stats
  ADD COLUMN IF NOT EXISTS runs_allowed_per_game NUMERIC(4,2);

COMMENT ON COLUMN public.cache_team_batting_stats.runs_allowed_per_game IS
  'D-562 (2026-06-19) — team runs ALLOWED per game (= opp_runs / games_played from /teams/{id}/stats?group=pitching). Used by process-games-mlb readTeamSeasonContext to populate TeamSeasonContext.runsAllowedPerGame, which feeds breakdown.home_rapg + breakdown.away_rapg on game_total + batter picks. Currently NOT consumed by any scoring factor (D-562 ESCALATION 2) — exists for future D-XXX score_runs_allowed_diff factor + ongoing audits like D-550. Nullable until backfilled by next fetch-mlb-team-stats cron tick.';
