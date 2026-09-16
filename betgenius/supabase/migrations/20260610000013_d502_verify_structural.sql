-- D-502 SHIP 2 — structural verification of the cron change + ad-hoc
-- function invocation to confirm process-games-mlb still works at the
-- new state. The empirical "real slate clears in <=45 min" verification
-- can only be done at the next active window (17:05 UTC, ~7.5 hours
-- after this batch). This migration sets up the watch baseline.
DO $$
DECLARE
  v_jobid       BIGINT;
  v_schedule    TEXT;
  v_command_ex  TEXT;
  v_active      BOOLEAN;
  v_rid         BIGINT;
  v_vault_len   INTEGER;
  v_pre_progress INTEGER;
  v_pre_rec      INTEGER;
  v_et_date     TEXT := to_char(now() AT TIME ZONE 'America/New_York', 'YYYYMMDD');
  v_et_date_dash TEXT := to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD');
BEGIN
  -- ============ STRUCTURAL CHECK 1: cron schedule actually changed ==========
  SELECT jobid, schedule, active, substring(command, 1, 200)
    INTO v_jobid, v_schedule, v_active, v_command_ex
  FROM cron.job WHERE jobname = 'process-games-mlb-30min';

  IF v_jobid IS NULL THEN
    RAISE EXCEPTION '[D-502 VERIFY] jobname process-games-mlb-30min vanished after the alter';
  END IF;
  RAISE NOTICE '[D-502 VERIFY] cron.job state — jobid=% jobname=process-games-mlb-30min schedule=% active=%',
    v_jobid, v_schedule, v_active;
  IF v_schedule <> '*/5 17-23,0-4 * * *' THEN
    RAISE EXCEPTION '[D-502 VERIFY] schedule mismatch — expected "*/5 17-23,0-4 * * *" got "%"', v_schedule;
  END IF;
  RAISE NOTICE '[D-502 VERIFY] schedule matches: */5 17-23,0-4 * * *  PASS';
  RAISE NOTICE '[D-502 VERIFY] command excerpt (must still target process-games-mlb): %', v_command_ex;

  -- ============ STRUCTURAL CHECK 2: pre-state baseline ==========
  SELECT count(*) INTO v_pre_progress FROM public.mlb_scoring_progress
   WHERE game_date = v_et_date;
  SELECT count(DISTINCT game_id) INTO v_pre_rec FROM public.recommendations_cache
   WHERE sport = 'mlb' AND game_time LIKE v_et_date_dash || '%';
  RAISE NOTICE '[D-502 VERIFY] PRE-trigger baseline — mlb_scoring_progress count=% rec_cache distinct game_id=%',
    v_pre_progress, v_pre_rec;

  -- ============ AD-HOC TRIGGER: confirm function still works ==========
  -- This is NOT a cadence test (the real cron will fire at 17:05 UTC).
  -- It's a "does the function still respond" probe — should:
  --   (a) return 200 within ~150s
  --   (b) write 2 more rows to mlb_scoring_progress (or 0 if no games left
  --       in slate after the 4 from earlier today)
  --   (c) write the corresponding rec_cache rows
  SELECT length(decrypted_secret) INTO v_vault_len
   FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1;
  IF v_vault_len IS NULL OR v_vault_len = 0 THEN
    RAISE EXCEPTION '[D-502 VERIFY] vault BACKFILL_AUTH_TOKEN missing — abort';
  END IF;

  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 200000   -- ~3.3 min, safely over the 150s edge ceiling
  ) INTO v_rid;
  RAISE NOTICE '[D-502 VERIFY] ad-hoc trigger sent; request_id=% (response will land in net._http_response)', v_rid;
END $$;
