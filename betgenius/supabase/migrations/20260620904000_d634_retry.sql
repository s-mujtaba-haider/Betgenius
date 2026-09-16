DO $$ DECLARE v_token text; v_req bigint; r RECORD; BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/snapshot-odds-writer',
    headers := jsonb_build_object('Authorization','Bearer '||v_token,'Content-Type','application/json'),
    body := '{"sport":"mlb"}'::jsonb,
    timeout_milliseconds := 180000
  ) INTO v_req;
  RAISE NOTICE 'retry request_id=%', v_req;
  PERFORM pg_sleep(60);
  FOR r IN
    SELECT status_code, regexp_replace(LEFT(COALESCE(content::text,''),1500), E'[\\n\\r]+', ' ', 'g') AS body
      FROM net._http_response WHERE id = v_req
  LOOP RAISE NOTICE 'retry resp status=% body=%', r.status_code, r.body; END LOOP;
  FOR r IN
    SELECT count(*) AS n, count(DISTINCT bookmaker) AS books,
           count(DISTINCT event_id) AS games, count(DISTINCT market) AS markets,
           min(snapshot_time) AS first_snap, max(snapshot_time) AS last_snap
      FROM public.cache_odds_snapshots
     WHERE sport='mlb'
  LOOP
    RAISE NOTICE '[verify] rows=% books=% games=% markets=% first=% last=%',
      r.n, r.books, r.games, r.markets, r.first_snap, r.last_snap;
  END LOOP;
END $$;
