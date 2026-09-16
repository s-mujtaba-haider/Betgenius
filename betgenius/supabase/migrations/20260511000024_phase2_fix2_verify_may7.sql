-- Phase 2 Fix #2 dedicated test on May 7 (full BDL cache coverage). May 7
-- has no live process-games rows (C40 gap), so this is an OLD vs NEW
-- synthetic comparison only — measures whether Fix #2's snapshot-date
-- lookup actually selects different data than pre-fix.

DO $$
DECLARE
  v_request_id BIGINT;
  v_token TEXT;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;

  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/backfill-historical',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'startDate', '2026-05-07',
      'endDate',   '2026-05-07',
      'sport', 'nba',
      'dryRun', false,
      'requireServiceRoleKey', true,
      'algorithmVersion', '2026-05-11-phase2-verify-may7'
    ),
    timeout_milliseconds := 120000
  ) INTO v_request_id;
  RAISE NOTICE 'backfill May 7 invoked: request_id=%', v_request_id;
END $$;
