-- D-365 SHIP 1 — enumerate ALL cron jobs + flag GUC vs vault auth.
-- Rollback: DROP FUNCTION IF EXISTS public.d365_full_cron_inspect();

CREATE OR REPLACE FUNCTION public.d365_full_cron_inspect()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, cron AS $$
DECLARE
  v_jobs jsonb := '[]'::jsonb;
  v_row record;
BEGIN
  FOR v_row IN
    SELECT jobid, jobname, schedule, active,
           command ILIKE '%current_setting(%app.%' AS uses_guc,
           command ILIKE '%vault.decrypted_secrets%' AS uses_vault,
           left(command, 400) AS command_excerpt
      FROM cron.job
      ORDER BY jobid
  LOOP
    v_jobs := v_jobs || jsonb_build_object(
      'jobid', v_row.jobid,
      'jobname', v_row.jobname,
      'schedule', v_row.schedule,
      'active', v_row.active,
      'uses_guc', v_row.uses_guc,
      'uses_vault', v_row.uses_vault,
      'command_excerpt', v_row.command_excerpt
    );
  END LOOP;
  RETURN jsonb_build_object('jobs', v_jobs, 'count', jsonb_array_length(v_jobs));
END $$;

GRANT EXECUTE ON FUNCTION public.d365_full_cron_inspect() TO service_role, authenticated;
