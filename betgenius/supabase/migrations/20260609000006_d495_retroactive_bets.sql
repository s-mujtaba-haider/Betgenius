-- D-495 retroactive (2026-06-09) — documents the live bets table.
--
-- bets was created out-of-band before formal migration discipline
-- (referenced by BetTracker.tsx + resolve-picks; no CREATE TABLE migration
-- existed). Schema dumped via D-495 inspection migration.
--
-- CREATE TABLE IF NOT EXISTS — non-destructive, documentary. Production
-- has the table with 7 live rows as of 2026-06-09 (pre-launch low volume).
--
-- Rollback (production has data): no-op. For a fresh environment:
--   DROP TABLE public.bets;

CREATE TABLE IF NOT EXISTS public.bets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id         uuid,
  player_name     text NOT NULL,
  prop_type       text NOT NULL,
  line            numeric NOT NULL,
  pick_side       text NOT NULL,
  odds            integer NOT NULL,
  stake           numeric NOT NULL,
  book            text DEFAULT 'hard_rock'::text,
  status          text DEFAULT 'pending'::text,
  result_value    numeric,
  payout          numeric,
  placed_at       timestamptz DEFAULT now(),
  settled_at      timestamptz,
  user_id         uuid,
  sport           text NOT NULL DEFAULT 'nba'::text
);

CREATE INDEX IF NOT EXISTS idx_bets_pick_id ON public.bets(pick_id) WHERE pick_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bets_status  ON public.bets(status);
CREATE INDEX IF NOT EXISTS idx_bets_user_id ON public.bets(user_id);

COMMENT ON TABLE public.bets IS
  'D-495 retroactive (schema captured 2026-06-09 via inspection migration). '
  'User-logged bet ledger. Written by BetTracker.tsx via the supabase client. '
  'Settled by resolve-picks against actuals. pick_id references the '
  'recommendations_cache or pick_history row the user followed. status: '
  '''pending'' | ''won'' | ''lost'' | ''push'' | ''void''.';
