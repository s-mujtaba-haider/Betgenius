-- D-463 (2026-06-05) — Sonnet usage log table for ground-truth Anthropic spend.
--
-- WHY: D-461 estimated $16-24/month from chars/4 token approximation.
-- D-462 measured $11 actually-spent from rec_cache row counts. CEO console
-- showed $64/month. D-462 could not reconcile the gap (~$53) from visible
-- data because we THROW AWAY the `usage` block on every Anthropic response.
-- D-463 captures `usage.input_tokens` + `usage.output_tokens` per call into
-- this table. Future bill questions become a single SQL query.
--
-- BEST-EFFORT WRITES: callers wrap the INSERT in try/catch and swallow errors —
-- usage-logging failure must never break analysis generation. The defensive
-- template fallback at process-games-mlb/index.ts:1395-1398 continues to apply.
--
-- ROLLBACK:
--   DROP TABLE public.sonnet_usage_log;

CREATE TABLE IF NOT EXISTS public.sonnet_usage_log (
  id                               bigserial PRIMARY KEY,
  created_at                       timestamptz NOT NULL DEFAULT now(),

  -- which call site fired this; one of:
  --   'mlb_pick'       — _shared/anthropic_mlb.ts (player + game markets)
  --   'nba_player'     — process-games/index.ts:1755
  --   'nba_game'       — process-games/index.ts:1825 (spread + total)
  --   'orchestrator'   — orchestrator-execute/index.ts:322 (per turn)
  source                           text NOT NULL,

  -- model + headers (capture as called; future-proofs against model rotation)
  model                            text NOT NULL,

  -- tokens from response.usage (NOT estimates — Anthropic's authoritative count)
  input_tokens                     integer NOT NULL,
  output_tokens                    integer NOT NULL,
  cache_creation_input_tokens      integer NOT NULL DEFAULT 0,
  cache_read_input_tokens          integer NOT NULL DEFAULT 0,

  -- rates used to compute cost (so historical rows remain interpretable
  -- if Anthropic changes pricing). Sonnet 4.6 as of June 2026: 3.00 / 15.00.
  input_rate_usd_per_mtok          numeric NOT NULL,
  output_rate_usd_per_mtok         numeric NOT NULL,

  -- computed at insert time from tokens × rates ÷ 1,000,000
  computed_cost_usd                numeric NOT NULL,

  -- optional per-site context (market, player, task_id, etc.) — best-effort
  context                          jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_sonnet_usage_log_created_at
  ON public.sonnet_usage_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sonnet_usage_log_source
  ON public.sonnet_usage_log(source);

-- Composite index for "spend by source over a date range" queries — leading
-- column on source, secondary on created_at. The naïve (source, created_at::date)
-- expression index fails because timestamptz→date is not marked IMMUTABLE
-- (depends on the session timezone). The plain timestamptz column is fine.
CREATE INDEX IF NOT EXISTS idx_sonnet_usage_log_source_created_at
  ON public.sonnet_usage_log(source, created_at DESC);

COMMENT ON TABLE public.sonnet_usage_log IS
  'D-463 (2026-06-05). Ground-truth Anthropic spend per Sonnet call. '
  'Populated best-effort from response.usage at 4 call sites: anthropic_mlb, '
  'nba_player, nba_game, orchestrator. Failures swallowed — logging never '
  'blocks analysis. Query daily/monthly cost via SUM(computed_cost_usd) '
  'GROUP BY source, created_at::date.';
