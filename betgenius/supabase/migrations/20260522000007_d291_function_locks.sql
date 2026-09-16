-- D-291 SHIP 1 (2026-05-22) — function lock table for backfill mutex.
--
-- Root cause D-290 found: TWO concurrent odds-loop shells from prior
-- sessions doubled API credit burn (~500K wasted). Edge functions are
-- stateless so Postgres advisory locks released between calls. Use
-- row-level lock with TTL instead.
--
-- Pattern (in each long-running backfill function):
--   1. Try INSERT INTO function_locks (lock_key, expires_at) VALUES
--      (..., now() + interval '15 min') ON CONFLICT (lock_key)
--      DO UPDATE SET acquired_at=now(), expires_at=now() + ...
--      WHERE function_locks.expires_at < now() RETURNING *
--   2. If 0 rows returned → another instance holds an active lock.
--      Log + exit immediately.
--   3. If 1 row returned → we acquired. Proceed with work.
--   4. On function exit: DELETE WHERE lock_key = ...
--
-- TTL guards against orphaned locks (function crash, timeout).
--
-- Rollback:
--   DROP TABLE IF EXISTS public.function_locks CASCADE;

CREATE TABLE IF NOT EXISTS public.function_locks (
  lock_key TEXT PRIMARY KEY,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  acquired_by TEXT  -- optional: identifier of acquiring instance
);

CREATE INDEX IF NOT EXISTS idx_function_locks_expires ON public.function_locks (expires_at);

ALTER TABLE public.function_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS function_locks_service_all ON public.function_locks;
CREATE POLICY function_locks_service_all ON public.function_locks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.function_locks IS
  'D-291 SHIP 1: mutex for long-running edge function backfill loops. '
  'Prevents concurrent instances from doubling work + cost. TTL-based '
  'auto-recovery via expires_at column (stale locks override on '
  'ON CONFLICT DO UPDATE WHERE expired).';
