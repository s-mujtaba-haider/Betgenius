DO $$
DECLARE v_token TEXT; v_rid BIGINT; BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  v_rid := net.http_post(
    url     := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body    := jsonb_build_object('priority','recent','sport','mlb','limit',200,'since_days',7),
    timeout_milliseconds := 150000
  );
  RAISE NOTICE 'D-694 SHIP 1 test 200 fired rid=%', v_rid;
END $$;
