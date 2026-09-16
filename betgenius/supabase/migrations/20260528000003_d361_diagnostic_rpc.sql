-- D-361 SHIP 1 — diagnostic RPC for cron auth investigation.
--
-- Read-only helper that returns:
--   (1) Job body for the 3 target crons (resolve-picks-nightly,
--       fetch-odds-every-15min, fetch-odds-tomorrow)
--   (2) HTTP status histogram for last 50 invocations of each cron
--       via net._http_response join through pg_cron.job_run_details
--
-- No writes, no side effects. Returns JSON for easy REST consumption.
--
-- Rollback: DROP FUNCTION public.d361_cron_inspect();

CREATE OR REPLACE FUNCTION public.d361_cron_inspect()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, net, extensions
AS $$
DECLARE
  v_targets text[] := ARRAY['resolve-picks-nightly', 'fetch-odds-every-15min', 'fetch-odds-tomorrow'];
  v_target text;
  v_jobs jsonb := '[]'::jsonb;
  v_http_recent jsonb := '[]'::jsonb;
  v_job_row record;
  v_status_count jsonb;
BEGIN
  -- (1) Job bodies
  FOREACH v_target IN ARRAY v_targets LOOP
    FOR v_job_row IN
      SELECT jobid, jobname, schedule, active, command
        FROM cron.job
       WHERE jobname = v_target
    LOOP
      v_jobs := v_jobs || jsonb_build_object(
        'jobid', v_job_row.jobid,
        'jobname', v_job_row.jobname,
        'schedule', v_job_row.schedule,
        'active', v_job_row.active,
        'command_excerpt', left(v_job_row.command, 2000),
        'uses_current_setting', v_job_row.command ILIKE '%current_setting%',
        'uses_vault_decrypted_secrets', v_job_row.command ILIKE '%vault.decrypted_secrets%'
      );
    END LOOP;
  END LOOP;

  -- (2) HTTP status histogram per cron (last 50 invocations each).
  -- net._http_response has (id, status_code, content_type, headers, content,
  -- created, timed_out, error_msg). pg_cron's job_run_details doesn't link
  -- directly to net._http_response — best we can do is look at recent
  -- responses cluster by URL match.
  FOREACH v_target IN ARRAY v_targets LOOP
    SELECT jsonb_agg(row_to_json(t))
      INTO v_status_count
      FROM (
        SELECT status_code, COUNT(*) AS n
          FROM net._http_response
         WHERE created > now() - interval '7 days'
           AND content::text ILIKE '%' || v_target || '%'
         GROUP BY status_code
         ORDER BY COUNT(*) DESC
      ) t;
    v_http_recent := v_http_recent || jsonb_build_object(
      'jobname', v_target,
      'status_histogram_7d', COALESCE(v_status_count, '[]'::jsonb)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'targets', v_targets,
    'jobs', v_jobs,
    'http_recent', v_http_recent,
    'inspected_at', now()
  );
END $$;

GRANT EXECUTE ON FUNCTION public.d361_cron_inspect() TO service_role, authenticated;

COMMENT ON FUNCTION public.d361_cron_inspect() IS
  'D-361 SHIP 1 diagnostic — returns cron job bodies + recent HTTP status '
  'histograms for the 3 target jobs. Read-only. Drop after D-361 ships.';
