-- D-681 SHIP 2 — pause heavy non-critical crons so the DB can recover
-- from PGRST002 schema-cache outage + connection saturation.
--
-- KEEP (live-critical):
--   process-games-mlb-30min        (live scoring — every 30min)
--   fetch-odds-mlb-30min           (live odds polling)
--   capture-closing-odds-mlb-5min  (live closing-odds capture)
--   resolve-picks-daily            (regular yesterday-resolution)
--   resolve-picks-nightly          (regular nightly resolution)
--   fetch-mlb-team-oaa-daily       (10 UTC — already fired today)
--   dashboard-health-check-2h      (monitoring)
--   system-health-hourly           (monitoring)
--
-- PAUSE (heavy non-critical — can resume after recovery):
--   resolve-picks-backlog-drain    (300 picks × 4×/day; next fire 20:30 UTC)
--   d664-weight-fit-weekly         (540s timeout)
--   fetch-mlb-pitcher-pen-extras-daily (540s timeout — already fired today)
--   fetch-mlb-pitcher-inn1-daily   (180s timeout — already fired today)
--   fetch-savant-team-chase-weekly (180s — weekly Sunday 9 UTC)
--   fetch-baseball-savant-weekly   (300s — weekly Sunday 8 UTC)
--   snapshot-opp-stats             (heavy snapshot)
--   fetch-mlb-bullpen-stats        (heavy bullpen rollup)
--   fetch-mlb-pitcher-splits       (heavy splits)
--   fetch-mlb-batter-splits        (heavy splits)

-- Inventory table — record what was scheduled before and what we unscheduled,
-- so the unpause can faithfully restore.
CREATE TABLE IF NOT EXISTS public._d681_cron_pause_log (
  paused_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action        TEXT NOT NULL,                -- 'snapshot' | 'unscheduled' | 'kept'
  jobname       TEXT,
  schedule      TEXT,
  command       TEXT,
  reason        TEXT
);

-- Snapshot pre-pause state of cron.job — record everything so we can restore.
INSERT INTO public._d681_cron_pause_log(action, jobname, schedule, command, reason)
SELECT 'snapshot', jobname, schedule, command, 'pre-D-681 baseline'
FROM cron.job;

-- Unschedule heavy non-critical jobs. Each in its own block so one missing
-- name doesn't abort the others.
DO $$
DECLARE
  v_paused TEXT[] := ARRAY[
    'resolve-picks-backlog-drain',
    'd664-weight-fit-weekly',
    'fetch-mlb-pitcher-pen-extras-daily',
    'fetch-mlb-pitcher-inn1-daily',
    'fetch-savant-team-chase-weekly',
    'fetch-baseball-savant-weekly',
    'snapshot-opp-stats',
    'fetch-mlb-bullpen-stats',
    'fetch-mlb-pitcher-splits',
    'fetch-mlb-batter-splits',
    'fetch-mlb-boxscores-daily',
    'refresh-historical-outcomes-mlb-daily',
    'refresh-mlb-scoreboard-status-daily',
    'register-game-schedule-hourly',
    'lineup-confirmation-watcher-10min'
  ];
  v_name TEXT;
  v_existed BOOLEAN;
  v_active_count INT;
BEGIN
  -- Count active jobs before
  SELECT COUNT(*) INTO v_active_count FROM cron.job;
  RAISE NOTICE 'D-681 pre-pause cron.job count: %', v_active_count;

  FOREACH v_name IN ARRAY v_paused
  LOOP
    SELECT EXISTS(SELECT 1 FROM cron.job WHERE jobname = v_name) INTO v_existed;
    IF v_existed THEN
      PERFORM cron.unschedule(v_name);
      INSERT INTO public._d681_cron_pause_log(action, jobname, reason)
      VALUES ('unscheduled', v_name, 'D-681 heavy non-critical pause');
      RAISE NOTICE 'D-681 unscheduled: %', v_name;
    ELSE
      INSERT INTO public._d681_cron_pause_log(action, jobname, reason)
      VALUES ('not_present', v_name, 'D-681 was-not-scheduled');
      RAISE NOTICE 'D-681 not present (already inactive): %', v_name;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_active_count FROM cron.job;
  RAISE NOTICE 'D-681 post-pause cron.job count: %', v_active_count;
END $$;

-- Trigger PostgREST to reload schema after the cron.job changes, in case
-- the previous reload was a transient miss.
DO $$
BEGIN
  PERFORM pg_notify('pgrst', 'reload schema');
  PERFORM pg_notify('pgrst', 'reload config');
END $$;
