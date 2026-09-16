CREATE OR REPLACE FUNCTION public.d640_v6b_all_crons()
RETURNS TABLE (jobname TEXT, schedule TEXT, active BOOLEAN)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout='60s';
  RETURN QUERY SELECT j.jobname::TEXT, j.schedule::TEXT, j.active
  FROM cron.job j ORDER BY j.jobname;
END $$;
GRANT EXECUTE ON FUNCTION public.d640_v6b_all_crons() TO service_role;
