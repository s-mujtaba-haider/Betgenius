-- D-673 SHIP 2 — dedicated backlog-drain cron for the 9,810 unresolved
-- MLB picks dated 6/8-6/21. Fires 4× daily at off-peak slots, processes
-- OLDEST-first via body.priority="oldest" so it doesn't compete with the
-- regular recent-first crons that handle yesterday's picks.
--
-- Bounded compute: limit=300, sport=mlb, since_days=30 (covers the full
-- backlog window). Each run ≤120s well under 150s edge-fn cap.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks';
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-673 backlog drain cron deferred.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('resolve-picks-backlog-drain') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'resolve-picks-backlog-drain'
  );

  -- 4× daily: 02:30, 08:30, 14:30, 20:30 UTC (offset from the regular crons).
  PERFORM cron.schedule(
    'resolve-picks-backlog-drain',
    '30 2,8,14,20 * * *',
    format(
      $cron$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := jsonb_build_object(
          'priority', 'oldest',
          'sport', 'mlb',
          'limit', 300,
          'since_days', 30
        ),
        timeout_milliseconds := 150000
      );$cron$,
      v_url,
      v_token
    )
  );
  RAISE NOTICE 'D-673 cron scheduled: resolve-picks-backlog-drain @ 4x daily (02:30, 08:30, 14:30, 20:30 UTC)';

  -- Fire once now so the backlog starts draining immediately.
  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
    body := jsonb_build_object('priority', 'oldest', 'sport', 'mlb', 'limit', 300, 'since_days', 30),
    timeout_milliseconds := 150000
  );
  RAISE NOTICE 'D-673 first-run backlog-drain dispatched';
END $$;
