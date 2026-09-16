-- D-473 (2026-06-07) — Progressive cron state table for process-games-mlb.
--
-- WHY: D-472 proved process-games-mlb hit 134-142s on 4-5 active-game ticks
-- (4 timeout alerts in last 24h, peak 142.7s = only 7.3s margin from 150s
-- hard ceiling). Adding the 4 queued markets would push 174-192s = silent
-- mid-tick death + pick loss (D-446 data-loss class).
--
-- FIX: shard games across cron ticks. Each tick processes only N=2 unscored
-- games, prioritized by gameTime ASC (soonest-first so urgent picks write
-- before kickoff). Across the existing 24-tick schedule (5,35 17-23,0-4 UTC),
-- a 10-15 game slate completes in 5-8 ticks.
--
-- This table tracks which (game_date, game_pk) tuples have been scored for
-- the current slate. The unique constraint guarantees no double-score; the
-- D-374 in-progress filter at fetchScheduleFull excludes Live/Final games
-- so they auto-disappear from future ticks even if not in the progress table.
--
-- Per-day reset: not required — the (game_date, game_pk) compound natural
-- key segregates days. Old days' rows accumulate harmlessly; a future
-- batch can add TTL cleanup if needed.
--
-- ROLLBACK:
--   DROP TABLE public.mlb_scoring_progress;

CREATE TABLE IF NOT EXISTS public.mlb_scoring_progress (
  id          bigserial PRIMARY KEY,
  game_date   text NOT NULL,        -- YYYYMMDD (matches pick_history.game_date)
  game_pk     integer NOT NULL,     -- MLB Stats API gamePk (stable per game)
  scored_at   timestamptz NOT NULL DEFAULT now(),

  -- Optional context (debug/audit only — not used for selection logic)
  tick_label  text                   -- e.g. function invoke timestamp tag
);

-- Composite unique constraint: a (game_date, game_pk) pair can only be
-- recorded once. Use ON CONFLICT DO NOTHING on insert path so re-scoring
-- after a tick crash is silent + idempotent (rec_cache upserts already
-- handle the pick-row idempotency per D-446).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mlb_scoring_progress_date_gamepk
  ON public.mlb_scoring_progress(game_date, game_pk);

-- Cron path reads by game_date frequently — index on the leading column.
CREATE INDEX IF NOT EXISTS idx_mlb_scoring_progress_game_date
  ON public.mlb_scoring_progress(game_date);

COMMENT ON TABLE public.mlb_scoring_progress IS
  'D-473 (2026-06-07). Per-tick progressive cron state for process-games-mlb. '
  'One row per (game_date, game_pk) successfully scored. Each tick reads this '
  'table to skip already-scored games and selects the next N=2 unscored Preview '
  'games sorted by gameTime ASC. The D-374 in-progress filter (state != Preview) '
  'is preserved upstream at fetchScheduleFull; this table only governs the '
  'games-per-tick shard size, not which games are eligible.';

-- Read for dashboards + the scoring function itself (uses service-role bearer).
GRANT SELECT, INSERT ON public.mlb_scoring_progress TO anon, authenticated, service_role;
GRANT USAGE ON SEQUENCE public.mlb_scoring_progress_id_seq TO anon, authenticated, service_role;
