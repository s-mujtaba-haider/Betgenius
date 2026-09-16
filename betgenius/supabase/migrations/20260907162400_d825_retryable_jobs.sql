-- D-825 Phase B SHIP 1.1 — retryable jobs + backoff logic
--
-- Adds retryable and retry_deadline columns to scheduled_jobs.
-- Modifies mark_job_completed to apply exponential backoff (1m, 5m, 15m)
-- for retryable jobs, up to 3 retries (4 attempts total), provided the
-- current time is before retry_deadline.
--
-- Modifies register_scheduled_job to accept p_retryable and p_retry_deadline.

ALTER TABLE public.scheduled_jobs
ADD COLUMN retryable BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN retry_deadline TIMESTAMPTZ;

-- Drop and recreate register_scheduled_job to add new params
DROP FUNCTION public.register_scheduled_job(TEXT, JSONB, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.register_scheduled_job(
  p_function_name TEXT,
  p_payload       JSONB,
  p_run_at        TIMESTAMPTZ,
  p_retryable     BOOLEAN DEFAULT false,
  p_retry_deadline TIMESTAMPTZ DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_status TEXT;
  v_existing_run_at TIMESTAMPTZ;
  v_existing_retryable BOOLEAN;
  v_existing_deadline TIMESTAMPTZ;
  v_natural_key TEXT;
BEGIN
  v_natural_key := p_function_name || ':'
    || COALESCE(p_payload->>'game_id','')
    || ':'
    || COALESCE(p_payload->>'touch_label','');

  SELECT status, run_at, retryable, retry_deadline 
    INTO v_existing_status, v_existing_run_at, v_existing_retryable, v_existing_deadline
    FROM public.scheduled_jobs
    WHERE natural_key = v_natural_key
    LIMIT 1;

  IF v_existing_status IS NULL THEN
    INSERT INTO public.scheduled_jobs (function_name, payload, run_at, retryable, retry_deadline)
      VALUES (p_function_name, p_payload, p_run_at, p_retryable, p_retry_deadline);
    RETURN 'inserted';
  END IF;

  IF v_existing_status = 'pending' THEN
    IF v_existing_run_at IS DISTINCT FROM p_run_at 
       OR v_existing_retryable IS DISTINCT FROM p_retryable
       OR v_existing_deadline IS DISTINCT FROM p_retry_deadline THEN
      UPDATE public.scheduled_jobs
        SET run_at = p_run_at,
            retryable = p_retryable,
            retry_deadline = p_retry_deadline
        WHERE natural_key = v_natural_key
          AND status = 'pending';
      RETURN 'updated';
    END IF;
    RETURN 'unchanged';
  END IF;

  RETURN 'unchanged';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_scheduled_job(TEXT, JSONB, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_scheduled_job(TEXT, JSONB, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ) TO service_role;

-- Modify mark_job_completed for retry logic and error appending
CREATE OR REPLACE FUNCTION public.mark_job_completed(
  p_job_id BIGINT,
  p_status TEXT,
  p_result JSONB DEFAULT NULL,
  p_error  TEXT  DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_retryable BOOLEAN;
  v_retry_deadline TIMESTAMPTZ;
  v_attempt_count INT;
  v_final_status TEXT;
  v_next_run_at TIMESTAMPTZ;
BEGIN
  IF p_status NOT IN ('completed','failed','skipped') THEN
    RAISE EXCEPTION 'mark_job_completed: invalid status %', p_status;
  END IF;
  
  v_final_status := p_status;
  
  -- If failing, check if we should retry
  IF p_status = 'failed' THEN
    SELECT retryable, retry_deadline, attempt_count
      INTO v_retryable, v_retry_deadline, v_attempt_count
      FROM public.scheduled_jobs
      WHERE job_id = p_job_id;
      
    IF v_retryable AND v_attempt_count < 4 THEN
      -- If there is a deadline, check if we are still before it
      IF v_retry_deadline IS NULL OR now() < v_retry_deadline THEN
        v_final_status := 'pending';
        -- 1 min, 5 min, 15 min
        IF v_attempt_count = 1 THEN
          v_next_run_at := now() + interval '1 minute';
        ELSIF v_attempt_count = 2 THEN
          v_next_run_at := now() + interval '5 minutes';
        ELSE
          v_next_run_at := now() + interval '15 minutes';
        END IF;
      END IF;
    END IF;
  END IF;

  UPDATE public.scheduled_jobs
  SET status = v_final_status,
      completed_at = CASE WHEN v_final_status IN ('completed','skipped') OR (v_final_status = 'failed' AND p_status = 'failed') THEN now() ELSE completed_at END,
      run_at = CASE WHEN v_final_status = 'pending' THEN v_next_run_at ELSE run_at END,
      result_summary = p_result,
      -- Append the error if it exists, prefixing with attempt count for context
      error_text = CASE 
        WHEN p_error IS NOT NULL THEN 
          COALESCE(error_text || E'\n', '') || '[Attempt ' || (SELECT attempt_count FROM public.scheduled_jobs WHERE job_id = p_job_id) || '] ' || p_error 
        ELSE error_text 
      END
  WHERE job_id = p_job_id;
  
  -- Return the final status so job-dispatcher knows if it was a terminal failure
  RETURN v_final_status;
END;
$$;
