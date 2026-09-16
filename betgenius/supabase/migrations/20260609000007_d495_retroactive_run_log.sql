-- D-495 retroactive (2026-06-09) — documents the live run_log table.
--
-- run_log was created out-of-band before formal migration discipline
-- (written by every cron-fn invocation via _shared/cron_heartbeat.ts;
-- read by sonnet-health-monitor's mlb_cron_freshness check; no CREATE
-- TABLE migration existed). Schema dumped via D-495 inspection migration.
--
-- CREATE TABLE IF NOT EXISTS — non-destructive, documentary. Production
-- has the table with 3,678 live rows as of 2026-06-09.
--
-- Rollback (production has data): no-op. For a fresh environment:
--   DROP TABLE public.run_log;

CREATE TABLE IF NOT EXISTS public.run_log (
  id                  bigserial PRIMARY KEY,
  created_at          timestamptz DEFAULT now(),
  function_name       text NOT NULL,
  duration_ms         integer,
  games_found         integer DEFAULT 0,
  props_fetched       integer DEFAULT 0,
  players_loaded      integer DEFAULT 0,
  players_skipped     integer DEFAULT 0,
  opp_stats_found     integer DEFAULT 0,
  opp_stats_failed    integer DEFAULT 0,
  props_scored        integer DEFAULT 0,
  recommendations     integer DEFAULT 0,
  ai_generated        integer DEFAULT 0,
  ai_failed           integer DEFAULT 0,
  errors_count        integer DEFAULT 0,
  status              text DEFAULT 'success'::text,
  notes               text,
  cache_write_errors  integer DEFAULT 0
);

COMMENT ON TABLE public.run_log IS
  'D-495 retroactive (schema captured 2026-06-09 via inspection migration). '
  'Per-cron-fn-tick observability table written by _shared/cron_heartbeat.ts. '
  'Read by sonnet-health-monitor''s mlb_cron_freshness check (looks for the '
  'last process-games-mlb row vs expected interval) and by health-monitor''s '
  'generic-infra checks.';
