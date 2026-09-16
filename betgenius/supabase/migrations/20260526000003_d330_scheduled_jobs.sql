-- D-330 Phase B SHIP 1 — scheduled_jobs table + indexes + claim/complete RPCs.
--
-- Purpose: holds per-(game, touch) rows that the job-dispatcher cron polls.
-- Replaces the slate-wide mega-cron pattern with one-row-per-invocation
-- queue. Each row points at an edge function + payload + run_at.
--
-- Idempotency: natural_key = function_name + ':' + payload->>'game_id' + ':' +
--   payload->>'touch_label'. UNIQUE constraint prevents duplicate registration
--   for the same (game, touch) tuple. register-game-schedule (Phase C) will
--   use INSERT ... ON CONFLICT to upsert with status='pending' filter.
--
-- Lock-safe dispatch: claim_due_jobs() uses FOR UPDATE SKIP LOCKED so
-- concurrent dispatcher invocations cannot grab the same row.
--
-- Rollback: DROP TABLE scheduled_jobs CASCADE; DROP FUNCTION claim_due_jobs;
--           DROP FUNCTION mark_job_completed; (then re-deploy this migration.)

CREATE TABLE IF NOT EXISTS public.scheduled_jobs (
  job_id         BIGSERIAL PRIMARY KEY,
  function_name  TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  run_at         TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','completed','failed','skipped')),
  attempt_count  INT NOT NULL DEFAULT 0,
  attempted_at   TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  error_text     TEXT,
  result_summary JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotency key — generated column ensures uniqueness on (function,
  -- game_id, touch_label) without requiring callers to compute it.
  natural_key    TEXT GENERATED ALWAYS AS (
    function_name || ':'
    || COALESCE(payload->>'game_id','')
    || ':'
    || COALESCE(payload->>'touch_label','')
  ) STORED,

  CONSTRAINT scheduled_jobs_natural_key_unique UNIQUE (natural_key)
);

-- Dispatcher hot path: find next pending due rows.
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_dispatcher
  ON public.scheduled_jobs (run_at)
  WHERE status = 'pending';

-- Generic time-based listing for ops/admin.
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_run_at
  ON public.scheduled_jobs (run_at);

-- Per-function operational view: how many pending d330-* jobs for tomorrow?
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_function_status
  ON public.scheduled_jobs (function_name, status, run_at);

-- ============================================================
-- claim_due_jobs(p_limit) — atomic claim. Used by job-dispatcher.
--   Pulls up to p_limit pending rows whose run_at <= now() and marks them
--   'running' + bumps attempt_count. FOR UPDATE SKIP LOCKED makes
--   concurrent dispatcher invocations safe.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_due_jobs(p_limit INT DEFAULT 10)
RETURNS TABLE (
  job_id        BIGINT,
  function_name TEXT,
  payload       JSONB,
  run_at        TIMESTAMPTZ,
  attempt_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.scheduled_jobs sj
  SET status = 'running',
      attempted_at = now(),
      attempt_count = sj.attempt_count + 1
  WHERE sj.job_id IN (
    SELECT inner_sj.job_id
    FROM public.scheduled_jobs inner_sj
    WHERE inner_sj.status = 'pending'
      AND inner_sj.run_at <= now()
    ORDER BY inner_sj.run_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING sj.job_id, sj.function_name, sj.payload, sj.run_at, sj.attempt_count;
END;
$$;

-- ============================================================
-- mark_job_completed(p_job_id, p_status, p_result, p_error) — terminal-state writer.
--   Called by job-dispatcher after invoking the function for that job.
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_job_completed(
  p_job_id BIGINT,
  p_status TEXT,
  p_result JSONB DEFAULT NULL,
  p_error  TEXT  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('completed','failed','skipped') THEN
    RAISE EXCEPTION 'mark_job_completed: invalid status %', p_status;
  END IF;
  UPDATE public.scheduled_jobs
  SET status = p_status,
      completed_at = now(),
      result_summary = p_result,
      error_text = p_error
  WHERE job_id = p_job_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_due_jobs(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_job_completed(BIGINT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_due_jobs(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_job_completed(BIGINT, TEXT, JSONB, TEXT) TO service_role;

COMMENT ON TABLE public.scheduled_jobs IS
  'D-330 Phase B per-game scheduler queue. Each row is one (function, payload, run_at) invocation. Dispatched by job-dispatcher edge function every minute via cron.';
COMMENT ON FUNCTION public.claim_due_jobs(INT) IS
  'D-330 atomic claim: marks up to p_limit pending due jobs as running and returns them. FOR UPDATE SKIP LOCKED so concurrent dispatchers cannot race.';
COMMENT ON FUNCTION public.mark_job_completed(BIGINT, TEXT, JSONB, TEXT) IS
  'D-330 terminal-state writer. Called by job-dispatcher after the function returns.';
