-- D-511 SHIP 2 — schedule capture-closing-odds cron.
-- Every 5 min during the active MLB game-window (5pm-4am UTC).
-- Mirrors process-games-mlb-30min's `*/5 17-23,0-4 * * *` schedule.
SELECT cron.schedule(
  'capture-closing-odds-mlb-5min',
  '*/5 17-23,0-4 * * *',
  $$ SELECT public.capture_closing_odds_mlb(); $$
);

DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-511 cron] schedule confirmed:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job
   WHERE jobname='capture-closing-odds-mlb-5min'
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%',
    r.jobid, r.jobname, r.schedule, r.active; END LOOP;
END $$;
