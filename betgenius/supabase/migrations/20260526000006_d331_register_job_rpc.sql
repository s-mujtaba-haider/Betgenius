-- D-331 Phase C — register_scheduled_job RPC.
--
-- Encapsulates the D-328 FLAG 3 idempotency contract:
--   ON CONFLICT (natural_key) DO UPDATE SET run_at = EXCLUDED.run_at
--   WHERE scheduled_jobs.status = 'pending'
--
-- Returns 'inserted' | 'updated' | 'unchanged' so callers can report
-- per-row outcome.
--
-- Rollback: DROP FUNCTION register_scheduled_job(TEXT, JSONB, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.register_scheduled_job(
  p_function_name TEXT,
  p_payload       JSONB,
  p_run_at        TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_status TEXT;
  v_existing_run_at TIMESTAMPTZ;
  v_natural_key TEXT;
BEGIN
  v_natural_key := p_function_name || ':'
    || COALESCE(p_payload->>'game_id','')
    || ':'
    || COALESCE(p_payload->>'touch_label','');

  -- Look up existing row by natural_key
  SELECT status, run_at INTO v_existing_status, v_existing_run_at
    FROM public.scheduled_jobs
    WHERE natural_key = v_natural_key
    LIMIT 1;

  IF v_existing_status IS NULL THEN
    -- No existing row → INSERT
    INSERT INTO public.scheduled_jobs (function_name, payload, run_at)
      VALUES (p_function_name, p_payload, p_run_at);
    RETURN 'inserted';
  END IF;

  -- Existing row found. Only mutate if status = 'pending' AND run_at differs.
  IF v_existing_status = 'pending' THEN
    IF v_existing_run_at IS DISTINCT FROM p_run_at THEN
      UPDATE public.scheduled_jobs
        SET run_at = p_run_at
        WHERE natural_key = v_natural_key
          AND status = 'pending';
      RETURN 'updated';
    END IF;
    RETURN 'unchanged';
  END IF;

  -- Existing row is in a non-pending terminal state (completed/failed/skipped/running) — leave it.
  RETURN 'unchanged';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_scheduled_job(TEXT, JSONB, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_scheduled_job(TEXT, JSONB, TIMESTAMPTZ) TO service_role;

COMMENT ON FUNCTION public.register_scheduled_job(TEXT, JSONB, TIMESTAMPTZ) IS
  'D-331 Phase C. Idempotent upsert for scheduled_jobs. INSERTs if natural_key absent. UPDATEs run_at only if existing row status=''pending''. Leaves completed/failed/skipped/running rows untouched. Returns ''inserted''|''updated''|''unchanged''.';
