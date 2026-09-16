-- D-658 — force a re-score of one game so we can observe the 11 newly wired
-- batter_runs_scored factors fire on a live pick. Delete one scoring_progress
-- row to trigger D-617 ring (a) "never scored" path.
DO $$
DECLARE v_count INT; v_token TEXT; v_req BIGINT;
BEGIN
  -- pick a game from tomorrow's slate that should have batter props
  DELETE FROM mlb_scoring_progress
  WHERE game_pk IN (
    SELECT game_pk FROM mlb_scoring_progress
    WHERE game_date = '20260620' AND scored_at < NOW() - INTERVAL '10 hours'
    ORDER BY scored_at ASC LIMIT 1
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'D-658 deleted % scoring_progress rows', v_count;

  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='BACKFILL_AUTH_TOKEN' LIMIT 1;
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_token),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  ) INTO v_req;
  RAISE NOTICE 'D-658 fire request_id=%', v_req;
END $$;
