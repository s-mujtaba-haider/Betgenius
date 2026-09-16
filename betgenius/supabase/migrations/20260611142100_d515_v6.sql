DO $$
DECLARE v_rid BIGINT; v_body TEXT;
BEGIN
  -- Quick HTTP test of the RPC via service_role JWT to verify PostgREST sees it
  -- (using the SAME apikey path the edge function uses).
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/rest/v1/rpc/d515_props_cache_velocity',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) INTO v_rid;
  RAISE NOTICE '[D-515 v6] no-auth test rid=%', v_rid;
END $$;
