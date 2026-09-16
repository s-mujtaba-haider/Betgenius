-- D-668 SHIP 2 — 3 new opponent-patience / pitch-burden columns on
-- cache_team_batting_stats. Source: MLB Stats API /teams/{id}/stats?group=hitting
-- (same body fetch-mlb-team-stats already pulls). Daily writer extended to
-- populate. Reader extends TeamHittingStats. Zero new HTTP per scoring tick.

ALTER TABLE public.cache_team_batting_stats
  ADD COLUMN IF NOT EXISTS bb_rate         NUMERIC(5,3),
  ADD COLUMN IF NOT EXISTS obp_season      NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS pitches_per_pa  NUMERIC(4,2);

COMMENT ON COLUMN public.cache_team_batting_stats.bb_rate IS
  'D-668 — team walk rate (baseOnBalls / plateAppearances). Used by score_opp_walk_rate factor in pitcher_outs scorer.';
COMMENT ON COLUMN public.cache_team_batting_stats.obp_season IS
  'D-668 — team season OBP. Used by score_opp_obp_patience factor in pitcher_outs scorer.';
COMMENT ON COLUMN public.cache_team_batting_stats.pitches_per_pa IS
  'D-668 — team pitches per plate appearance (numberOfPitches / PA). Used by score_opp_pitch_grind factor in pitcher_outs scorer.';
