-- D-664 SHIP 2 — schedule weight-fit optimizer for v3 spread weights.
-- Cron entry: weekly Sunday 11:00 UTC starting 2026-06-28 (7 days post-D-663).
-- Runs run-optimizer-v2 in dry-run mode → emits candidate migration → CEO §19.3
-- reviews → CEO grants APPROVE → migration applied + scoring fn redeployed.
-- See d664_weight_fit_plan.md for the full procedure.
DO $$
DECLARE
  v_url TEXT := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/run-optimizer-v2';
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_token IS NULL THEN
    RAISE NOTICE 'BACKFILL_AUTH_TOKEN missing — D-664 weight-fit cron deferred. Run optimizer manually.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('d664-weight-fit-weekly') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'd664-weight-fit-weekly'
  );

  PERFORM cron.schedule(
    'd664-weight-fit-weekly',
    '0 11 * * 0',  -- Sunday 11:00 UTC (first fire 2026-06-28)
    format(
      $cron$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := jsonb_build_object(
          'target', 'v3_spread_weights',
          'cohort_start', 'auto',
          'dry_run', true,
          'cohort_filter', jsonb_build_object(
            'market_type', 'game_side',
            'breakdown_flag', 'd663_wired'
          )
        ),
        timeout_milliseconds := 540000
      );$cron$,
      v_url,
      v_token
    )
  );
  RAISE NOTICE 'D-664 cron scheduled: d664-weight-fit-weekly @ Sunday 11:00 UTC (first fire 2026-06-28)';
END $$;
