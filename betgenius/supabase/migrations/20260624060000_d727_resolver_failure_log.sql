-- D-727 — Create resolver_failure_log so failures stop evaporating.
-- D-718 finding: failures in resolve-picks have no audit trail. When 1,913
-- picks voided this weekend, there was no way to tell why. Every silent
-- failure path now writes a row here.
--
-- Schema rationale:
--   - timestamped (default now())
--   - pick_id OR bet_id (one or the other; both nullable so callers can omit either)
--   - market (mlb_market_type or NBA prop_type) for cohorting
--   - failure_type — a small set of canonical strings (categorize the cause)
--   - detail — free-text for context (player_name, game_pk, HTTP status, etc.)
--   - game_pk + game_date for incident reconstruction
--
-- This table never voids picks; it only records the WHY of a failure or skip.

CREATE TABLE IF NOT EXISTS public.resolver_failure_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pick_id UUID NULL,
  bet_id UUID NULL,
  market TEXT NULL,
  failure_type TEXT NOT NULL,
  detail TEXT NULL,
  game_pk BIGINT NULL,
  game_date DATE NULL
);

-- D-727: canonical failure types. Codified as a CHECK so callers can't drift.
ALTER TABLE public.resolver_failure_log
  ADD CONSTRAINT d727_failure_type_known
  CHECK (failure_type IN (
    'name_no_match',          -- Player name didn't match any boxscore player (D-715/716 class)
    'player_id_no_match',     -- Pick had player_id but no boxscore had that id
    'dnp',                    -- Player in roster but didn't play (no AB / no IP)
    'boxscore_fetch_failed',  -- MLB Stats API HTTP fail / transient outage (D-277-FIX class)
    'game_market_no_match',   -- Game-market pick didn't match a team
    'stat_not_extractable',   -- Player found but the stat field was null
    'no_final_games_on_date', -- The pick's game_date had no Final games
    'ai_analysis_copy_failed',-- Best-effort backfill in voidPick chain failed (line 260 swallow)
    'unknown'                 -- Catch-all for unanticipated cases; always preferable to silence
  ));

-- Indices for the most common audit queries
CREATE INDEX IF NOT EXISTS idx_rfl_occurred_at ON public.resolver_failure_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_rfl_pick_id ON public.resolver_failure_log (pick_id) WHERE pick_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rfl_failure_type_date ON public.resolver_failure_log (failure_type, game_date);

-- The service role is the only writer; allow read for diagnostics
GRANT INSERT, SELECT ON public.resolver_failure_log TO service_role;
GRANT USAGE ON SEQUENCE public.resolver_failure_log_id_seq TO service_role;

DO $$ DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables
    WHERE table_schema='public' AND table_name='resolver_failure_log';
  RAISE NOTICE '  resolver_failure_log table exists: %', n;
  PERFORM pg_notify('pgrst', 'reload schema');
END $$;
