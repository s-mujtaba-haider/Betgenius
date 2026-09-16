-- D-657 SHIP 1 — second fire after deploy rollout.
DO $$
DECLARE
  v_token TEXT;
  v_req BIGINT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) INTO v_req;
  RAISE NOTICE 'D-657 SHIP 1 fire #2 request_id=%', v_req;
END $$;

-- Also re-add the raw_responses RPC for ongoing checks.
CREATE OR REPLACE FUNCTION public.d657_raw_responses(p_hours INT)
RETURNS TABLE(id BIGINT, created TIMESTAMPTZ, status_code INT, error_msg TEXT, content_short TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  SET LOCAL statement_timeout='30s';
  RETURN QUERY
    SELECT hr.id, hr.created, hr.status_code::INT, substring(hr.error_msg, 1, 80)::TEXT, substring(hr.content, 1, 250)::TEXT
    FROM net._http_response hr
    WHERE hr.created > NOW() - (p_hours || ' hours')::INTERVAL
    ORDER BY hr.created DESC
    LIMIT 50;
END $$;
GRANT EXECUTE ON FUNCTION public.d657_raw_responses(INT) TO service_role;
