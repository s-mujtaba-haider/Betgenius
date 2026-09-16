-- D-785 PART 1a/1b — Add 10 batter factor columns to pick_history schema.
--
-- D-783 audit found 10/12 batter_runs_scored factor columns absent from the
-- pick_history schema. Their values are computed in scoreBatterRunsScored and
-- persisted in `breakdown` JSONB, but NOT in dedicated top-level columns —
-- the optimizer reading top-level `pick_history.score_*` columns sees NULL
-- for these 10 factors, blocking factor-level tuning analysis.
--
-- This is NOT a classic D-758 silent drop (where the column exists but the
-- RPC INSERT list omits it). It's a partial schema gap: 10 columns were
-- never added. Adding them here + extending the RPC in the next migration.
--
-- THE 10 COLUMNS:
--   score_batter_obp                       — runs-only (on-base baseline)
--   score_recent_run_form                  — runs-only (recent R/game blend)
--   score_lineup_spot                      — batter lineup position (1-9)
--   score_bullpen_quality                  — opp pen ERA (runs market)
--   score_opp_pitcher_pitchtype_quality    — D-598 pitch-type matchup
--   score_batter_xba                       — Statcast expected BA
--   score_batter_exit_velo_trend           — Statcast EV trend
--   score_batter_barrel_rate               — Statcast barrel rate
--   score_batter_xslg_regression           — Statcast xSLG vs SLG regression
--   score_batter_vs_pitcher_hand_split     — batter vs pitcher hand split
--
-- Pure additive. ADD COLUMN IF NOT EXISTS — idempotent, safe to re-run.
-- Numeric default NULL (no data prior to D-785 deploy). Post-D-785 picks
-- will populate via the extended RPC in the next migration.

BEGIN;

ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_batter_obp NUMERIC,
  ADD COLUMN IF NOT EXISTS score_recent_run_form NUMERIC,
  ADD COLUMN IF NOT EXISTS score_lineup_spot NUMERIC,
  ADD COLUMN IF NOT EXISTS score_bullpen_quality NUMERIC,
  ADD COLUMN IF NOT EXISTS score_opp_pitcher_pitchtype_quality NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_xba NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_exit_velo_trend NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_barrel_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_xslg_regression NUMERIC,
  ADD COLUMN IF NOT EXISTS score_batter_vs_pitcher_hand_split NUMERIC;

COMMENT ON COLUMN public.pick_history.score_batter_obp IS
  'D-785: OBP factor score (runs-only). Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_recent_run_form IS
  'D-785: Recent R/game blend factor (runs-only). Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_lineup_spot IS
  'D-785: Batter lineup position factor (1-9). Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_bullpen_quality IS
  'D-785: Opp bullpen ERA factor (runs market). Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_opp_pitcher_pitchtype_quality IS
  'D-598/D-785: Pitch-type matchup. Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_batter_xba IS
  'D-785: Statcast expected BA factor. Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_batter_exit_velo_trend IS
  'D-785: Statcast EV trend factor. Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_batter_barrel_rate IS
  'D-785: Statcast barrel rate factor. Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_batter_xslg_regression IS
  'D-785: Statcast xSLG vs SLG regression factor. Was in breakdown JSONB only pre-D-785.';
COMMENT ON COLUMN public.pick_history.score_batter_vs_pitcher_hand_split IS
  'D-785: Batter vs pitcher hand split factor. Was in breakdown JSONB only pre-D-785.';

COMMIT;
