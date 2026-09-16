-- D-272-INF-3 (2026-05-20) — Retroactive migration for props_cache.
--
-- Table was created out-of-band. Documents schema-as-of-2026-05-20
-- (186,795 rows). CREATE TABLE IF NOT EXISTS so it's a no-op against
-- production. Schema captured from PostgREST OpenAPI introspection.
--
-- Rollback (production has table): no-op. For fresh environment:
--   DROP TABLE public.props_cache CASCADE;

CREATE TABLE IF NOT EXISTS public.props_cache (
  id           bigserial PRIMARY KEY,
  game_date    text NOT NULL,
  event_id     text NOT NULL,
  player_name  text NOT NULL,
  prop_type    text NOT NULL,
  line         numeric NOT NULL,
  odds         integer,
  bookmaker    text DEFAULT 'unknown',
  home_team    text,
  away_team    text,
  game_time    timestamptz,
  first_seen   timestamptz DEFAULT now(),
  last_seen    timestamptz DEFAULT now(),
  pick_side    text,
  sport        text NOT NULL DEFAULT 'nba'
);

COMMENT ON TABLE public.props_cache IS
  'D-272-INF-3 retroactive (schema captured 2026-05-20). Raw odds '
  'snapshot from The Odds API, written by fetch-odds / fetch-odds-mlb. '
  'Consumed by process-games / process-games-mlb for scoring + by '
  'Evaluator for live re-score against cached lines.';
