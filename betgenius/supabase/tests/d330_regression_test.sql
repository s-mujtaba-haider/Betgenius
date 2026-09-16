-- Regression test for D-330 Retryable logic
-- Confirms that existing non-retryable behavior remains unchanged.
-- To run: psql -f d330_regression_test.sql

DO $$
DECLARE
  v_job_id BIGINT;
  v_status TEXT;
  v_attempt_count INT;
  v_run_at TIMESTAMPTZ;
  v_next_run_at TIMESTAMPTZ;
BEGIN
  RAISE NOTICE 'Starting regression tests for D-330 Retryable...';

  -- TEST 1: Default behavior (retryable = false)
  INSERT INTO public.scheduled_jobs (function_name, payload, run_at)
  VALUES ('test_non_retryable', '{"test": 1}', now())
  RETURNING job_id INTO v_job_id;
  
  -- Simulate dispatcher claiming the job
  UPDATE public.scheduled_jobs 
  SET status = 'running', attempt_count = 1 
  WHERE job_id = v_job_id;

  -- Call mark_job_completed with a failure
  PERFORM public.mark_job_completed(v_job_id, 'failed', NULL, 'test failure');

  -- Verify it failed and didn't retry
  SELECT status, attempt_count INTO v_status, v_attempt_count
  FROM public.scheduled_jobs WHERE job_id = v_job_id;

  IF v_status != 'failed' THEN
    RAISE EXCEPTION 'TEST 1 FAILED: Expected status failed, got %', v_status;
  END IF;
  
  RAISE NOTICE 'TEST 1 PASSED: Non-retryable job transitioned to failed.';

  -- TEST 2: Opt-in behavior (retryable = true)
  INSERT INTO public.scheduled_jobs (function_name, payload, run_at, retryable, retry_deadline)
  VALUES ('test_retryable', '{"test": 2}', now(), true, now() + interval '1 hour')
  RETURNING job_id, run_at INTO v_job_id, v_run_at;
  
  -- Simulate dispatcher claiming the job
  UPDATE public.scheduled_jobs 
  SET status = 'running', attempt_count = 1 
  WHERE job_id = v_job_id;

  -- Call mark_job_completed with a failure
  PERFORM public.mark_job_completed(v_job_id, 'failed', NULL, 'first failure');

  -- Verify it is pending and backoff was applied
  SELECT status, run_at INTO v_status, v_next_run_at
  FROM public.scheduled_jobs WHERE job_id = v_job_id;

  IF v_status != 'pending' THEN
    RAISE EXCEPTION 'TEST 2 FAILED: Expected status pending, got %', v_status;
  END IF;
  
  IF v_next_run_at <= v_run_at THEN
    RAISE EXCEPTION 'TEST 2 FAILED: Expected run_at to be advanced.';
  END IF;

  RAISE NOTICE 'TEST 2 PASSED: Retryable job transitioned to pending with backoff.';

  -- TEST 3: Deadline guard (retryable = true, but past deadline)
  INSERT INTO public.scheduled_jobs (function_name, payload, run_at, retryable, retry_deadline)
  VALUES ('test_deadline', '{"test": 3}', now(), true, now() - interval '1 minute')
  RETURNING job_id INTO v_job_id;
  
  -- Simulate dispatcher claiming the job
  UPDATE public.scheduled_jobs 
  SET status = 'running', attempt_count = 1 
  WHERE job_id = v_job_id;

  -- Call mark_job_completed with a failure
  PERFORM public.mark_job_completed(v_job_id, 'failed', NULL, 'failure past deadline');

  -- Verify it failed and didn't retry
  SELECT status INTO v_status
  FROM public.scheduled_jobs WHERE job_id = v_job_id;

  IF v_status != 'failed' THEN
    RAISE EXCEPTION 'TEST 3 FAILED: Expected status failed, got %', v_status;
  END IF;

  RAISE NOTICE 'TEST 3 PASSED: Past-deadline retryable job transitioned to failed.';
  
  -- Clean up
  DELETE FROM public.scheduled_jobs WHERE function_name IN ('test_non_retryable', 'test_retryable', 'test_deadline');

  RAISE NOTICE 'All tests passed.';
END;
$$;
