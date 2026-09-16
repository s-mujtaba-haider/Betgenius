-- D-637 SHIP 1 — Lineup confirmation tracking table.
-- ────────────────────────────────────────────────────────────────────
-- Records every empty→populated lineup transition the watcher detects.
-- Idempotency key: (game_pk, lineup_hash). When a re-pull returns the
-- same hash, the watcher short-circuits — no duplicate re-score, no
-- duplicate scratch-voids.
--
-- Why a hash, not just (game_pk, confirmed_at): late scratches happen.
-- A second confirmation with a different lineup hash should re-fire
-- the scratch/re-score path on the deltas.
--
-- Rollback: DROP TABLE public.lineup_confirmation_log;

CREATE TABLE IF NOT EXISTS public.lineup_confirmation_log (
  id                bigserial PRIMARY KEY,
  game_pk           bigint NOT NULL,
  game_date         date NOT NULL,
  sport             text NOT NULL DEFAULT 'mlb',
  source_name       text NOT NULL DEFAULT 'mlb_stats_boxscore',
  -- SHA-1 hex of the sorted starting-batter normalized-name list.
  -- Same hash → same lineup → already processed.
  lineup_hash       text NOT NULL,
  n_starters        integer NOT NULL,
  n_scratched_picks integer NOT NULL DEFAULT 0,
  n_voided_history  integer NOT NULL DEFAULT 0,
  rescore_invoked   boolean NOT NULL DEFAULT false,
  rescore_response  text,
  confirmed_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_pk, lineup_hash)
);

CREATE INDEX IF NOT EXISTS lineup_confirmation_log_game_date_idx
  ON public.lineup_confirmation_log (game_date);

CREATE INDEX IF NOT EXISTS lineup_confirmation_log_game_pk_idx
  ON public.lineup_confirmation_log (game_pk, confirmed_at DESC);

COMMENT ON TABLE public.lineup_confirmation_log IS
  'D-637 — per-game lineup-confirmation transitions. The watcher writes one row per (game_pk, distinct lineup_hash). Used for idempotency and audit.';
