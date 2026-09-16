-- D-730 — Canonical game-outcomes table (D-718 Priority #6).
-- Clean, narrow store keyed on game_pk. Distinct from cache_mlb_historical_outcomes
-- (which is JSONB-bloated and scoped to backtest/historical-context use).
-- Powers game-market resolution (game_total/game_side/spread/h2h) via game_pk
-- instead of per-cron-tick live MLB schedule re-fetches, and provides the
-- foundation for future ambiguity-by-game disambiguation (the two Max Muncys).
--
-- One row per game_pk. status reflects MLB schedule statusCode.
-- D-726-style invariants enforced for non-negative scores + winner consistency.

CREATE TABLE IF NOT EXISTS public.game_outcomes (
  game_pk        BIGINT       PRIMARY KEY,
  game_date      DATE         NOT NULL,
  home_team      TEXT         NOT NULL,
  away_team      TEXT         NOT NULL,
  home_score     INT          NULL,
  away_score     INT          NULL,
  total_runs     INT          NULL, -- denormalized = home_score + away_score
  winner         TEXT         NULL CHECK (winner IN ('home','away','tie') OR winner IS NULL),
  status         TEXT         NOT NULL DEFAULT 'scheduled',
  commence_time  TIMESTAMPTZ  NULL,
  fetched_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_go_game_date ON public.game_outcomes (game_date DESC);
CREATE INDEX IF NOT EXISTS idx_go_home_away_date ON public.game_outcomes (home_team, away_team, game_date);
CREATE INDEX IF NOT EXISTS idx_go_status_date ON public.game_outcomes (status, game_date DESC);

-- D-726-style invariants
ALTER TABLE public.game_outcomes
  ADD CONSTRAINT d730_home_score_non_negative
  CHECK (home_score IS NULL OR home_score >= 0);

ALTER TABLE public.game_outcomes
  ADD CONSTRAINT d730_away_score_non_negative
  CHECK (away_score IS NULL OR away_score >= 0);

ALTER TABLE public.game_outcomes
  ADD CONSTRAINT d730_total_runs_non_negative
  CHECK (total_runs IS NULL OR total_runs >= 0);

-- Total = home + away when both present (the D-718 sanity invariant)
ALTER TABLE public.game_outcomes
  ADD CONSTRAINT d730_total_eq_sum_when_present
  CHECK (
    (home_score IS NULL OR away_score IS NULL OR total_runs IS NULL)
    OR total_runs = home_score + away_score
  );

-- Winner consistency with scores when game is final-ish
ALTER TABLE public.game_outcomes
  ADD CONSTRAINT d730_winner_consistent
  CHECK (
    winner IS NULL OR home_score IS NULL OR away_score IS NULL
    OR (winner = 'home' AND home_score > away_score)
    OR (winner = 'away' AND away_score > home_score)
    OR (winner = 'tie'  AND home_score = away_score)
  );

-- Score sanity bound (no MLB game ever scored 100+ runs; 50 is a comfortable upper bound)
ALTER TABLE public.game_outcomes
  ADD CONSTRAINT d730_home_score_sane CHECK (home_score IS NULL OR home_score <= 50);
ALTER TABLE public.game_outcomes
  ADD CONSTRAINT d730_away_score_sane CHECK (away_score IS NULL OR away_score <= 50);

GRANT SELECT, INSERT, UPDATE ON public.game_outcomes TO service_role;

DO $$ BEGIN PERFORM pg_notify('pgrst', 'reload schema'); END $$;

DO $$ DECLARE rec record; n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_outcomes';
  RAISE NOTICE '=== D-730 game_outcomes columns: % ===', n;
  SELECT count(*) INTO n FROM pg_constraint WHERE conname LIKE 'd730_%';
  RAISE NOTICE '=== D-730 constraints installed: % ===', n;
END $$;
