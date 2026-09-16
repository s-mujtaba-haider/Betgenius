-- D-495 retroactive (2026-06-09) — documents the live error_log table.
--
-- error_log was created out-of-band before formal migration discipline
-- (referenced by every fn's logFailure path + by sonnet-health-monitor's
-- rpc_failed_rate check, but no CREATE TABLE migration existed). This
-- file documents the live schema dumped via D-495's inspection migration
-- (see d495_table_schemas.md SHIP 1 for the source NOTICEs).
--
-- Pattern matches D-272-INF-3 (retroactive recommendations_cache /
-- algorithm_weights). CREATE TABLE IF NOT EXISTS — non-destructive,
-- documentary. Production already has the table with 36,283 live rows
-- as of 2026-06-09.
--
-- Rollback (production has data): no-op. For a fresh environment:
--   DROP TABLE public.error_log;

CREATE TABLE IF NOT EXISTS public.error_log (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz DEFAULT now(),
  function_name   text NOT NULL,
  phase           text,
  error_type      text,
  error_message   text NOT NULL,
  context         jsonb DEFAULT '{}'::jsonb,
  resolved        boolean DEFAULT false
);

COMMENT ON TABLE public.error_log IS
  'D-495 retroactive (schema captured 2026-06-09 via inspection migration). '
  'Append-only structured error log written by every edge fn via the '
  '_shared/error_handling.ts helper + by the _shared/pick_history_writer.ts '
  'logFailure path (D-487). Read by sonnet-health-monitor''s rpc_failed_rate '
  'check (D-481) and pick_history_validation_failed_rate check (D-489).';
